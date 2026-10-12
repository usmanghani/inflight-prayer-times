/** Editable (draft) itinerary + settings model, and conversion to/from engine types. */
import type { Airport, FlightLeg, Madhab, HighLatitudeRule, PrayerSettings, ProfileId, TrackPoint } from '../types';
import { DEFAULT_SETTINGS, METHODS, mergeSettings, MADHAB_INFO } from '../prayer/methods';
import { localToUtc, utcOffsetMinutes } from '../time/tz';
import { isValidDate, parseNumber } from './dom';

export const FT_PER_M = 3.28084;
export const DEFAULT_CRUISE_FT = 36000;
export const MAX_CRUISE_FT = 60000;


export type TzChoice = 'utc' | 'origin' | 'dest' | 'aircraft';
export const TZ_CHOICES: readonly TzChoice[] = ['utc', 'origin', 'dest', 'aircraft'];
export const STEP_CHOICES: readonly number[] = [1, 2, 5, 10];

export interface LegDraft {
  id: string;
  flightNumber: string;
  from: string;
  to: string;
  /** 'YYYY-MM-DDTHH:mm', wall clock at the origin airport. */
  depLocal: string;
  /** 'YYYY-MM-DDTHH:mm', wall clock at the destination airport. */
  arrLocal: string;
  /** Cruise altitude in feet, as typed (empty = default). */
  cruiseFt: string;
  track?: TrackPoint[];
  trackLabel?: string;
  waypoints?: TrackPoint[];
  /** Set when the leg came from OCR / AI and still needs human confirmation. */
  needsReview?: boolean;
  /** 0..1 parser confidence, when known. */
  confidence?: number;
  /** Informational note under the leg (e.g. "Filled from the schedule library"). */
  note?: string;
}

export interface AppSettings {
  prayer: PrayerSettings;
  tzChoices: TzChoice[];
  stepMinutes: number;
}

export function defaultAppSettings(): AppSettings {
  return {
    prayer: mergeSettings({}),
    tzChoices: ['utc', 'origin', 'dest'],
    stepMinutes: 1,
  };
}

let legCounter = 0;
export function newLegId(): string {
  legCounter += 1;
  return `leg-${Date.now().toString(36)}-${legCounter}`;
}

export function blankLeg(partial: Partial<LegDraft> = {}): LegDraft {
  return {
    id: newLegId(),
    flightNumber: '',
    from: '',
    to: '',
    depLocal: '',
    arrLocal: '',
    cruiseFt: '',
    ...partial,
  };
}

/** UTC instant -> 'YYYY-MM-DDTHH:mm' wall clock in tz (for <input type=datetime-local>). */
export function utcToLocalInput(d: Date, tz: string): string {
  if (!isValidDate(d)) return '';
  try {
    const off = utcOffsetMinutes(d, tz);
    return new Date(d.getTime() + off * 60000).toISOString().slice(0, 16);
  } catch {
    return d.toISOString().slice(0, 16);
  }
}

export type Resolver = (iata: string) => Airport | undefined;

export function legToDraft(leg: FlightLeg, resolve: Resolver): LegDraft {
  const from = resolve(leg.from);
  const to = resolve(leg.to);
  return blankLeg({
    id: leg.id || newLegId(),
    flightNumber: leg.flightNumber ?? '',
    from: leg.from,
    to: leg.to,
    depLocal: from ? utcToLocalInput(leg.departureUtc, from.tz) : '',
    arrLocal: to ? utcToLocalInput(leg.arrivalUtc, to.tz) : '',
    cruiseFt: leg.cruiseAltitudeM !== undefined ? String(Math.round(leg.cruiseAltitudeM * FT_PER_M)) : '',
    track: leg.track,
    waypoints: leg.waypoints,
  });
}

export interface DraftConversion {
  leg: FlightLeg | null;
  errors: string[];
}

/** Convert one draft to an engine leg, with friendly per-field errors (never throws). */
export function draftToLeg(d: LegDraft, index: number, resolve: Resolver): DraftConversion {
  const errors: string[] = [];
  const label = `Leg ${index + 1}${d.flightNumber ? ` (${d.flightNumber.trim().toUpperCase()})` : ''}`;
  const from = resolve((d.from || '').trim().toUpperCase());
  const to = resolve((d.to || '').trim().toUpperCase());
  if (!d.from.trim()) errors.push(`${label}: choose a departure airport.`);
  else if (!from) errors.push(`${label}: "${d.from.trim()}" is not a known airport code. Pick one from the suggestions.`);
  if (!d.to.trim()) errors.push(`${label}: choose an arrival airport.`);
  else if (!to) errors.push(`${label}: "${d.to.trim()}" is not a known airport code. Pick one from the suggestions.`);

  let dep: Date | null = null;
  let arr: Date | null = null;
  if (!d.depLocal) errors.push(`${label}: enter the departure date and time.`);
  else if (from) {
    try {
      dep = localToUtc(d.depLocal, from.tz);
    } catch {
      errors.push(`${label}: the departure date/time is not valid.`);
    }
  }
  if (!d.arrLocal) errors.push(`${label}: enter the arrival date and time.`);
  else if (to) {
    try {
      arr = localToUtc(d.arrLocal, to.tz);
    } catch {
      errors.push(`${label}: the arrival date/time is not valid.`);
    }
  }

  let cruiseM: number | undefined;
  if (d.cruiseFt.trim() !== '') {
    const ft = parseNumber(d.cruiseFt);
    if (ft === null) errors.push(`${label}: cruise altitude must be a number of feet.`);
    else if (ft < 0) errors.push(`${label}: cruise altitude cannot be negative.`);
    else if (ft > MAX_CRUISE_FT) errors.push(`${label}: cruise altitude above ${MAX_CRUISE_FT.toLocaleString('en-US')} ft is not realistic.`);
    else cruiseM = ft / FT_PER_M;
  }

  if (errors.length > 0 || !from || !to || !dep || !arr || !isValidDate(dep) || !isValidDate(arr)) {
    return { leg: null, errors };
  }
  const leg: FlightLeg = {
    id: d.id,
    from: from.iata,
    to: to.iata,
    departureUtc: dep,
    arrivalUtc: arr,
  };
  const fn = d.flightNumber.trim().toUpperCase();
  if (fn) leg.flightNumber = fn;
  if (cruiseM !== undefined && cruiseM > 0) leg.cruiseAltitudeM = cruiseM;
  if (d.track && d.track.length >= 2) leg.track = d.track;
  if (d.waypoints && d.waypoints.length > 0) leg.waypoints = d.waypoints;
  return { leg, errors };
}

export function draftsToLegs(drafts: LegDraft[], resolve: Resolver): { legs: FlightLeg[]; errors: string[] } {
  const legs: FlightLeg[] = [];
  const errors: string[] = [];
  drafts.forEach((d, i) => {
    const r = draftToLeg(d, i, resolve);
    errors.push(...r.errors);
    if (r.leg) legs.push(r.leg);
  });
  return { legs, errors };
}

// ───────────────────────────── settings sanitising ─────────────────────────────

const MADHABS = Object.keys(MADHAB_INFO) as Madhab[];
const RULES: HighLatitudeRule[] = ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude', 'redTwilight', 'none'];
const PROFILE_IDS: ProfileId[] = ['barelvi', 'deobandi', 'custom'];

function finiteOr<T extends number | null>(v: unknown, fallback: T): number | T {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Coerce untrusted JSON (localStorage / URL hash) into a usable AppSettings. Never throws. */
export function sanitizeAppSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p0 = (r.prayer && typeof r.prayer === 'object' ? r.prayer : {}) as Record<string, unknown>;
  const out = sanitizeCore(raw);
  // Settings saved before profiles existed carry no profile: they are the user's own choices.
  if (!PROFILE_IDS.includes(p0.profile as ProfileId)) out.prayer.profile = 'custom';
  return out;
}

/** True when stored pre-profile settings are exactly the old defaults (Hanafi, Karachi 18/18, angle-based, no offsets). */
export function isLegacyDefault(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const p = (raw as Record<string, unknown>).prayer as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return true;
  const m = (p.method ?? {}) as Record<string, unknown>;
  const o = (p.offsets ?? {}) as Record<string, unknown>;
  const zero = Object.values(o).every((v) => v === 0 || v === undefined);
  return (
    p.profile === undefined &&
    p.madhab === 'hanafi' &&
    p.highLatitudeRule === 'angleBased' &&
    (m.id === 'karachi' || m.id === undefined) &&
    m.fajrAngle === 18 && m.ishaAngle === 18 && !m.maghribAngle &&
    zero && p.dipForSunriseSunset !== false && p.dipForTwilight !== true &&
    (p.polarFallback === undefined || p.polarFallback === 'nearestLocation')
  );
}

function sanitizeCore(raw: unknown): AppSettings {
  const base = defaultAppSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const p = (r.prayer && typeof r.prayer === 'object' ? r.prayer : {}) as Record<string, unknown>;
  const m = (p.method && typeof p.method === 'object' ? p.method : {}) as Record<string, unknown>;
  const o = (p.offsets && typeof p.offsets === 'object' ? p.offsets : {}) as Record<string, unknown>;

  const defM = DEFAULT_SETTINGS.method;
  const id = typeof m.id === 'string' && m.id in METHODS ? (m.id as keyof typeof METHODS) : defM.id;
  const methodBase = METHODS[id];
  const prayer = mergeSettings({
    madhab: MADHABS.includes(p.madhab as Madhab) ? (p.madhab as Madhab) : DEFAULT_SETTINGS.madhab,
    highLatitudeRule: RULES.includes(p.highLatitudeRule as HighLatitudeRule)
      ? (p.highLatitudeRule as HighLatitudeRule)
      : DEFAULT_SETTINGS.highLatitudeRule,
    dipForSunriseSunset: typeof p.dipForSunriseSunset === 'boolean' ? p.dipForSunriseSunset : true,
    dipForTwilight: typeof p.dipForTwilight === 'boolean' ? p.dipForTwilight : false,
    method: {
      ...methodBase,
      fajrAngle: finiteOr(m.fajrAngle, methodBase.fajrAngle) as number,
      ishaAngle: m.ishaAngle === null ? null : (finiteOr(m.ishaAngle, methodBase.ishaAngle) as number | null),
      ishaIntervalMin: m.ishaIntervalMin === null ? null : (finiteOr(m.ishaIntervalMin, methodBase.ishaIntervalMin) as number | null),
      maghribAngle: m.maghribAngle === null ? null : (finiteOr(m.maghribAngle, methodBase.maghribAngle) as number | null),
      midnight: m.midnight === 'jafari' || m.midnight === 'standard' ? m.midnight : methodBase.midnight,
      name: typeof m.name === 'string' && m.name.length < 120 ? m.name : methodBase.name,
    },
    offsets: {
      fajr: finiteOr(o.fajr, 0) as number,
      sunrise: finiteOr(o.sunrise, 0) as number,
      dhuhr: finiteOr(o.dhuhr, 0) as number,
      asr: finiteOr(o.asr, 0) as number,
      maghrib: finiteOr(o.maghrib, 0) as number,
      isha: finiteOr(o.isha, 0) as number,
    },
  });
  if (p.polarFallback === 'nearestLocation' || p.polarFallback === 'fixedLatitude') prayer.polarFallback = p.polarFallback;
  if (p.fajrFallback === 'nearestLocation' || p.fajrFallback === 'redTwilight') prayer.fajrFallback = p.fajrFallback;
  if (typeof p.redTwilightAngle === 'number' && Number.isFinite(p.redTwilightAngle)) prayer.redTwilightAngle = p.redTwilightAngle;
  if (PROFILE_IDS.includes(p.profile as ProfileId)) prayer.profile = p.profile as ProfileId;
  const tz = Array.isArray(r.tzChoices) ? (r.tzChoices.filter((x) => TZ_CHOICES.includes(x as TzChoice)) as TzChoice[]) : base.tzChoices;
  const step = typeof r.stepMinutes === 'number' && STEP_CHOICES.includes(r.stepMinutes) ? r.stepMinutes : 1;
  return { prayer, tzChoices: tz.length > 0 ? Array.from(new Set(tz)) : base.tzChoices, stepMinutes: step };
}

/** Coerce untrusted JSON into legs drafts (tracks are not persisted). */
export function sanitizeDrafts(raw: unknown): LegDraft[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const out: LegDraft[] = [];
  for (const x of raw.slice(0, 12)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    out.push(
      blankLeg({
        flightNumber: str(r.flightNumber, 10),
        from: str(r.from, 8),
        to: str(r.to, 8),
        depLocal: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str(r.depLocal)) ? str(r.depLocal) : '',
        arrLocal: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str(r.arrLocal)) ? str(r.arrLocal) : '',
        cruiseFt: str(r.cruiseFt, 8),
      }),
    );
  }
  return out;
}
