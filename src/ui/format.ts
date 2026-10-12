/** Presentation helpers: coordinates, altitude, durations, time zones, Qibla wording. */
import type { AircraftState, Airport, FlightPhase, PrayerName, PrayerWindow } from '../types';
import { formatInTz, formatOffset, utcOffsetMinutes } from '../time/tz';
import { PRAYER_LABEL, formatLatLon } from '../prayer/inflight';
import { isValidDate } from './dom';
import type { TzChoice } from './model';

export { formatLatLon, PRAYER_LABEL };

export const PRAYER_AR: Record<PrayerName, string> = {
  fajr: 'الفجر',
  sunrise: 'الشروق',
  dhuhr: 'الظهر',
  asr: 'العصر',
  maghrib: 'المغرب',
  isha: 'العشاء',
};

export const WINDOW_LABEL: Record<PrayerWindow, string> = {
  fajr: 'Fajr',
  sunrise: 'After sunrise',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

export const PHASE_LABEL: Record<FlightPhase, string> = {
  ground: 'On the ground',
  taxi: 'Taxi',
  climb: 'Climb',
  cruise: 'Cruise',
  descent: 'Descent',
};

const FT_PER_M = 3.28084;

export function safeNum(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

export function fmtAlt(altitudeM: number): string {
  const m = Math.max(0, safeNum(altitudeM));
  const ft = Math.round((m * FT_PER_M) / 10) * 10;
  return `${ft.toLocaleString('en-US')} ft (${Math.round(m).toLocaleString('en-US')} m)`;
}

export function fmtFt(altitudeM: number): string {
  return `${(Math.round((Math.max(0, safeNum(altitudeM)) * FT_PER_M) / 10) * 10).toLocaleString('en-US')}`;
}

export function fmtDuration(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—';
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function fmtDeg(x: number, digits = 0): string {
  return `${safeNum(x).toFixed(digits)}°`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  const d = ((safeNum(deg) % 360) + 360) % 360;
  return COMPASS[Math.round(d / 22.5) % 16];
}

/** Plain-language Qibla direction. `rel` is relative to the aircraft nose (+ = right). */
export function qiblaPhrase(absDeg: number, relDeg: number, onGround: boolean): string {
  const abs = ((safeNum(absDeg) % 360) + 360) % 360;
  const absText = `${Math.round(abs)}° ${compass(abs)}`;
  if (onGround) return `Qibla is ${absText} (true bearing from north).`;
  const rel = safeNum(relDeg);
  const n = Math.round(Math.abs(rel));
  const side = rel >= 0 ? 'right' : 'left';
  let rest: string;
  if (n <= 5) rest = "straight ahead of the aircraft's nose";
  else if (n >= 175) rest = 'directly behind the aircraft';
  else if (n < 90) rest = `${n}° to the ${side} of the aircraft's nose`;
  else if (n < 100) rest = `${n}° to the ${side} of the nose, almost abeam`;
  else rest = `behind you, ${180 - n}° ${side} of the tail (${n}° ${side} of the nose)`;
  return `Qibla is ${absText}: ${rest}.`;
}

/** Short Qibla text for tables: "42° R" / "170° L". */
export function qiblaShort(relDeg: number): string {
  const rel = safeNum(relDeg);
  const n = Math.round(Math.abs(rel));
  if (n === 0) return '0° ahead';
  if (n === 180) return '180° behind';
  return `${n}° ${rel >= 0 ? 'R' : 'L'}`;
}

export function whereText(s: AircraftState, airports?: Map<string, Airport>): string {
  if (s.onGround) {
    const a = s.airport ? airports?.get(s.airport) : undefined;
    const name = a ? `${a.iata} (${a.city})` : (s.airport ?? 'the airport');
    return `On the ground at ${name}`;
  }
  return `${formatLatLon(s.lat, s.lon)}, ${fmtAlt(s.altitudeM)}, ${PHASE_LABEL[s.phase].toLowerCase()}`;
}

export function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ───────────────────────────── time zones ─────────────────────────────

export function fmtInTz(d: Date | null | undefined, tz: string, opts?: { seconds?: boolean; date?: boolean }): string {
  if (!d || !isValidDate(d)) return '—';
  return formatInTz(d, tz, opts);
}

export function offsetLabel(d: Date, tz: string): string {
  try {
    return `UTC${formatOffset(utcOffsetMinutes(d, tz))}`;
  } catch {
    return 'UTC';
  }
}

export interface TzColumn {
  key: TzChoice;
  /** Row label, e.g. "UTC", "Origin · KHI". */
  label: string;
  /** Fixed IANA zone; undefined for 'aircraft' (resolved per position). */
  tz?: string;
}

export interface TripTz {
  originIata: string;
  destIata: string;
  originTz: string;
  destTz: string;
}

/** Resolve the selected display zones in a stable order, merging duplicates (e.g. origin == destination). */
export function tzColumns(choices: TzChoice[], trip: TripTz): TzColumn[] {
  const order: TzChoice[] = ['utc', 'origin', 'dest', 'aircraft'];
  const cols: TzColumn[] = [];
  for (const key of order) {
    if (!choices.includes(key)) continue;
    if (key === 'utc') cols.push({ key, label: 'UTC', tz: 'UTC' });
    else if (key === 'origin') cols.push({ key, label: `Origin · ${trip.originIata}`, tz: trip.originTz });
    else if (key === 'dest') {
      const prev = cols.find((c) => c.key === 'origin' && c.tz === trip.destTz);
      if (prev) prev.label = `Origin & destination · ${trip.originIata}/${trip.destIata}`;
      else cols.push({ key, label: `Destination · ${trip.destIata}`, tz: trip.destTz });
    } else cols.push({ key, label: 'Under the aircraft' });
  }
  if (cols.length === 0) cols.push({ key: 'utc', label: 'UTC', tz: 'UTC' });
  return cols;
}

export function approxEq(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}
