/**
 * In-flight engine: slide the aircraft along its journey, ask "which prayer window is
 * active *here and now*" at every sample, and bisect every change of window to the second.
 *
 * Per sample t:   state = journey.stateAt(t)               (lat, lon, altitude, heading)
 *                 window = windowAt(t, state position)     (static prayer times of that exact place/solar date)
 * The continuous function f(t) = windowAt(t, stateAt(t)).window is piecewise constant; when two
 * consecutive samples disagree, we bisect between them on f itself (exact positions, never rounded)
 * until the bracket is <= refineSeconds. See docs/ALGORITHM.md.
 *
 * Anomalies a static calculator never sees are reported alongside the events:
 *   windowRepeated  – the window sequence moved backwards (e.g. Asr → Dhuhr: flying west faster than the sun,
 *                     crossing meridians quickly near a pole, or a high-latitude rule recomputing the times)
 *   windowSkipped   – one or more windows never opened (e.g. Maghrib missing between Asr and Isha)
 *   highLatitudeRuleUsed – an event time came from a high-latitude rule, not from the Sun's angle
 *   polarDay / polarNight – the Sun does not set / rise at the aircraft's place that day
 *
 * No NaN / Invalid Date leaves this module.
 */
import { sunAltAz } from '../astro/solar';
import { qiblaBearing, relativeBearing } from '../geo/qibla';
import { tzAt } from '../time/tz';
import { computeStaticTimes, solarDateAt, windowAt } from './static';
import type {
  AircraftState,
  AnomalyKind,
  InflightResult,
  Journey,
  MinuteSample,
  PrayerEvent,
  PrayerName,
  PrayerSettings,
  PrayerWindow,
  StaticPrayerTimes,
  TimeNote,
} from '../types';

export interface InflightOptions {
  /** Sampling interval in minutes (default 1). */
  stepMinutes?: number;
  /** Bisection precision in seconds (default 1). */
  refineSeconds?: number;
  /** Look up the IANA time zone under the aircraft for every sample (default true; false reports 'UTC'). */
  tzUnderAircraft?: boolean;
}

const MS_PER_MIN = 60_000;
/** Hard cap on samples so a tiny stepMinutes can never freeze the UI. */
const MAX_SAMPLES = 12_000;
/** Maximum window transitions resolved inside one sampling interval (guards against pathological flicker). */
const MAX_TRANSITIONS_PER_INTERVAL = 16;
/** Sub-divisions used when a jump looks like a skipped/repeated window. */
const SUBDIVISIONS = 8;
/** tz cache cell size in degrees (airborne). */
const TZ_CELL_DEG = 0.5;

/** Canonical daily cycle of windows. */
const CYCLE: readonly PrayerWindow[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const idx = (w: PrayerWindow): number => CYCLE.indexOf(w);

export const PRAYER_LABEL: Record<PrayerName, string> = {
  fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha',
};

// ─────────────────────────── small helpers ───────────────────────────

const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

/** "64.2°N 22.1°W" */
export function formatLatLon(lat: number, lon: number): string {
  const la = fin(lat);
  const lo = fin(lon);
  return `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`;
}

type StepKind = 'normal' | 'repeated' | 'skipped';

/** How a jump prev → next relates to the canonical cycle, and which windows it jumped over. */
function classify(prev: PrayerWindow, next: PrayerWindow): { kind: StepKind; skipped: PrayerWindow[] } {
  const n = (idx(next) - idx(prev) + 6) % 6;
  if (n === 1) return { kind: 'normal', skipped: [] };
  if (n === 2 || n === 3) {
    const skipped: PrayerWindow[] = [];
    for (let k = 1; k < n; k++) skipped.push(CYCLE[(idx(prev) + k) % 6]);
    return { kind: 'skipped', skipped };
  }
  return { kind: 'repeated', skipped: [] }; // n = 4, 5 (or 0): the sequence went backwards
}

function validDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** Apparent westward speed of the Sun's shadow at the equator: 15°/h × 111.32 km/° = 1669.8 km/h (× cos φ at latitude φ). */
const SUN_EQUATOR_KMH = 1669.8;
const KM_PER_DEG_LON_EQUATOR = 111.32;
/** Beyond this latitude / longitude rate the "meridians converge" wording is used instead of "faster than the sun". */
const POLAR_LAT = 80;
const RAPID_SWEEP_DEG_PER_H = 30;

/** How the aircraft moves relative to the Sun's apparent motion at one instant. */
export interface Motion {
  /** Longitude rate, degrees per hour (negative = westward). */
  lonRateDegPerH: number;
}

const isRuleNote = (n: TimeNote | undefined): boolean =>
  n === 'highLatitudeRule' || n === 'nearestLatitude' || n === 'redTwilight';

/** Human labels for the high-latitude rules (never print the raw identifier). */
const RULE_LABEL: Record<PrayerSettings['highLatitudeRule'], string> = {
  angleBased: 'angle-based rule',
  oneSeventh: 'one-seventh-of-the-night rule',
  middleOfNight: 'middle-of-the-night rule',
  nearestLatitude: 'nearest-location rule',
  redTwilight: 'red-twilight rule',
  none: 'no high-latitude rule',
};
const ruleLabel = (r: PrayerSettings['highLatitudeRule']): string => RULE_LABEL[r] ?? 'high-latitude rule';

/** "≈54.5°N" */
const fmtLat = (lat: number): string => `≈${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;

const SCHOLAR_NOTE =
  'Scholars generally hold that a prayer already prayed within its valid time remains valid; consult a scholar about any repeat or combining.';

/** Exported for unit tests. */
export function repeatedMessage(
  prev: PrayerWindow,
  next: PrayerWindow,
  s: AircraftState,
  motion: Motion,
  settings: PrayerSettings,
  note: TimeNote | undefined,
): string {
  const loc = formatLatLon(s.lat, s.lon);
  const northSouth = `${Math.round(Math.abs(s.lat))}°${s.lat >= 0 ? 'N' : 'S'}`;
  const rate = s.onGround ? 0 : fin(motion.lonRateDegPerH);
  const cosLat = Math.cos((fin(s.lat) * Math.PI) / 180);
  const sunKmh = SUN_EQUATOR_KMH * cosLat;
  const westKmh = Math.max(0, -rate) * KM_PER_DEG_LON_EQUATOR * cosLat;
  const sunLike = idx(next) <= idx('asr'); // the "day" windows: the sun appears to come back up
  const what = `the ${PRAYER_LABEL[next]} window re-opened after ${PRAYER_LABEL[prev]}`;

  // 1. Near a pole (or a very fast longitude sweep) the meridians converge: the aircraft changes local solar time
  //    much faster than the clock, whatever its ground speed.
  if (!s.onGround && (Math.abs(s.lat) > POLAR_LAT || Math.abs(rate) > RAPID_SWEEP_DEG_PER_H)) {
    const dir = rate < 0 ? 'local solar time runs backwards' : 'local solar time changes faster than the clock';
    return (
      `Near ${loc} the aircraft crosses meridians very quickly (${Math.abs(rate).toFixed(0)}° of longitude per hour, ` +
      `against 15° for the Sun), so ${dir}${sunLike && rate < 0 ? ' and the Sun appears to rise again' : ''}; ${what}. ` +
      SCHOLAR_NOTE
    );
  }
  // 2. Genuinely westbound faster than the Sun's apparent speed at this latitude.
  if (!s.onGround && rate < -15) {
    const speeds = `your westward speed (${Math.round(westKmh)} km/h) exceeds the Sun's apparent speed here (${Math.round(sunKmh)} km/h)`;
    return sunLike
      ? `Flying west faster than the sun near ${northSouth}: ${speeds}, so the sun appears to rise again in the west; ${what}. ${SCHOLAR_NOTE}`
      : `Flying west faster than the sun near ${northSouth} (${loc}): ${speeds}, so the evening light returns; ${what}. ${SCHOLAR_NOTE}`;
  }
  // 3. The Sun's motion is not the cause: a high-latitude rule recomputed the times as the position changed.
  if (isRuleNote(note)) {
    return (
      `Near ${loc}: the window sequence went backwards because the high-latitude handling (${ruleLabel(settings.highLatitudeRule)}) ` +
      `recomputed the times as the aircraft moved, not because the aircraft outran the Sun; ${what}. ` + SCHOLAR_NOTE
    );
  }
  return `Near ${loc}: the window sequence went backwards; ${what}. ` + SCHOLAR_NOTE;
}

function skippedMessage(
  prev: PrayerWindow,
  next: PrayerWindow,
  skipped: PrayerWindow[],
  s: AircraftState,
  motion: Motion,
): string {
  const loc = formatLatLon(s.lat, s.lon);
  const names = skipped.map((w) => PRAYER_LABEL[w]).join(' and ');
  const high = Math.abs(s.lat) > 45 ? ' At this latitude the twilight can be very short or absent.' : '';
  const fast =
    !s.onGround && motion.lonRateDegPerH > 15
      ? ` Flying east, local solar time runs ahead of the clock (${motion.lonRateDegPerH.toFixed(0)}° of longitude per hour against 15° for the Sun).`
      : '';
  return (
    `Near ${loc}: the ${names} window${skipped.length > 1 ? 's' : ''} did not open ` +
    `(${PRAYER_LABEL[prev]} went straight to ${PRAYER_LABEL[next]}).${high}${fast} ` +
    'Follow your chosen high-latitude rule or ask a scholar.'
  );
}

/** Message for an event whose time comes from a high-latitude method, describing the method actually used. */
function highLatMessage(
  prayer: PrayerName,
  note: TimeNote,
  s: AircraftState,
  settings: PrayerSettings,
  borrowed: number | undefined,
): string {
  const loc = formatLatLon(s.lat, s.lon);
  const label = PRAYER_LABEL[prayer];
  if (note === 'redTwilight') {
    const red = settings.redTwilightAngle ?? 12;
    const full = prayer === 'fajr' ? settings.method.fajrAngle : settings.method.ishaAngle ?? 18;
    return (
      `${label} at ${loc} is at the red twilight (${red}°) per the Sahibayn \u2014 ${full}° is not reached here ` +
      '(Barelvi/Ahl-e-Sunnat fatwa). It is prayed as ada, and the 18° of Imam Abu Hanifa applies again whenever it occurs.'
    );
  }
  if (note === 'nearestLatitude') {
    if (settings.polarFallback === 'fixedLatitude') {
      return `${label} at ${loc} is taken from latitude 48.5° on the same meridian (fixed-latitude fallback) because the Sun's twilight angle is not reached here.`;
    }
    const where = borrowed !== undefined && Number.isFinite(borrowed) ? ` (${fmtLat(borrowed)} on this meridian)` : ' on this meridian';
    return `${label} at ${loc} is borrowed from the nearest location with a normal night${where}, because the Sun's twilight angle is not reached here.`;
  }
  // note === 'highLatitudeRule': a share of the night under the configured rule.
  const share: Record<string, string> = {
    angleBased: 'a share of the night in proportion to its angle (angle ÷ 60)',
    oneSeventh: 'one seventh of the night',
    middleOfNight: 'half of the night',
  };
  const how = share[settings.highLatitudeRule] ?? 'a share of the night (angle ÷ 60)';
  const why =
    settings.highLatitudeRule === 'redTwilight' || settings.highLatitudeRule === 'nearestLatitude'
      ? 'no usable twilight time exists at the nearest location either'
      : 'the twilight angle is not reached or the night is too short';
  return `${label} at ${loc} is set to ${how} (${ruleLabel(settings.highLatitudeRule)}), not by the Sun's angle, because ${why}.`;
}

/** Message for polar day / night: says what actually supplies the windows. */
function polarMessage(
  kind: 'polarDay' | 'polarNight',
  loc: string,
  settings: PrayerSettings,
  borrowed: number | undefined,
): string {
  const head =
    kind === 'polarDay'
      ? `Polar day near ${loc}: the Sun does not set on this date, so sunset-based times do not occur normally.`
      : `Polar night near ${loc}: the Sun does not rise on this date, so sunrise and sunset do not occur normally.`;
  if (settings.highLatitudeRule === 'none') return `${head} No high-latitude rule is set, so the missing times stay empty.`;
  if (settings.polarFallback === 'fixedLatitude') {
    return `${head} The times of latitude 48.5° on the same meridian are used (fixed-latitude fallback).`;
  }
  const where = borrowed !== undefined && Number.isFinite(borrowed) ? ` (${fmtLat(borrowed)} on this meridian)` : '';
  return `${head} The times of the nearest location with a normal day${where} are used.`;
}

// ─────────────────────────── engine ───────────────────────────

interface InternalSample {
  sample: MinuteSample;
  dayState: StaticPrayerTimes['dayState'];
}

interface Transition { ms: number; from: PrayerWindow; to: PrayerWindow }

export function computeInflight(journey: Journey, settings: PrayerSettings, opts: InflightOptions = {}): InflightResult {
  const startMs = validDate(journey?.start) ? journey.start.getTime() : NaN;
  const endMs = validDate(journey?.end) ? journey.end.getTime() : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { samples: [], events: [], anomalies: [], initialWindow: 'isha' };
  }
  const lastMs = Math.max(startMs, endMs);

  let stepMs = (Number.isFinite(opts.stepMinutes) && (opts.stepMinutes as number) > 0 ? (opts.stepMinutes as number) : 1) * MS_PER_MIN;
  if ((lastMs - startMs) / stepMs > MAX_SAMPLES) stepMs = Math.ceil((lastMs - startMs) / MAX_SAMPLES);
  const refineMs = Math.max(1, Math.round((Number.isFinite(opts.refineSeconds) && (opts.refineSeconds as number) > 0 ? (opts.refineSeconds as number) : 1) * 1000));
  const useTz = opts.tzUnderAircraft !== false;

  // ── state / window evaluation ──
  const stateCache = new Map<number, AircraftState>();
  const stateAtMs = (ms: number): AircraftState => {
    const hit = stateCache.get(ms);
    if (hit) return hit;
    const raw = journey.stateAt(new Date(ms));
    const s: AircraftState = {
      ...raw,
      time: new Date(ms),
      lat: Math.max(-90, Math.min(90, fin(raw.lat))),
      lon: fin(raw.lon),
      altitudeM: Math.max(0, fin(raw.altitudeM)),
      headingDeg: fin(raw.headingDeg),
    };
    if (stateCache.size > 4096) stateCache.clear();
    stateCache.set(ms, s);
    return s;
  };

  const windowAtMs = (ms: number, s: AircraftState) =>
    windowAt(new Date(ms), { lat: s.lat, lon: s.lon, elevationM: s.altitudeM }, settings);

  /** Longitude rate (°/h, negative = westward) from the positions a minute apart around t. */
  const motionAt = (ms: number): Motion => {
    const a = stateAtMs(ms - 30_000);
    const b = stateAtMs(ms + 30_000);
    const dt = (b.time.getTime() - a.time.getTime()) / 3_600_000;
    if (!(dt > 0)) return { lonRateDegPerH: 0 };
    let dLon = b.lon - a.lon;
    dLon = ((((dLon + 180) % 360) + 360) % 360) - 180; // across the antimeridian
    return { lonRateDegPerH: fin(dLon / dt) };
  };

  /** Latitude a borrowed (nearest-location) time at this place comes from, if any. */
  const borrowedLatFor = (s: AircraftState, ms: number, prayer?: PrayerName): number | undefined => {
    const st = computeStaticTimes({ lat: s.lat, lon: s.lon, elevationM: s.altitudeM }, solarDateAt(new Date(ms), s.lon), settings);
    return (prayer ? st.borrowedLatitudes?.[prayer] : undefined) ?? st.borrowedLatitude;
  };

  /** f(t): the active window for the exact aircraft position at t. */
  const f = (ms: number): PrayerWindow => windowAtMs(ms, stateAtMs(ms)).window;

  // ── tz cache: airborne positions by 0.5° cell (first-seen position), ground positions exactly ──
  const tzCache = new Map<string, string>();
  const tzFor = (s: AircraftState): string => {
    if (!useTz) return 'UTC';
    const key = s.onGround
      ? `g${s.lat.toFixed(3)},${s.lon.toFixed(3)}`
      : `a${Math.round(s.lat / TZ_CELL_DEG)},${Math.round(s.lon / TZ_CELL_DEG)}`;
    let z = tzCache.get(key);
    if (z === undefined) {
      z = tzAt(s.lat, s.lon);
      tzCache.set(key, z);
    }
    return z;
  };

  const sampleAt = (ms: number): InternalSample => {
    const state = stateAtMs(ms);
    const w = windowAtMs(ms, state);
    const sun = sunAltAz(new Date(ms), state.lat, state.lon);
    const qibla = qiblaBearing(state.lat, state.lon);
    return {
      dayState: w.dayState,
      sample: {
        state,
        sunAltitudeDeg: fin(sun.altitudeDeg),
        sunAzimuthDeg: fin(sun.azimuthDeg),
        window: w.window,
        qiblaDeg: qibla,
        qiblaRelativeDeg: relativeBearing(qibla, state.headingDeg),
        tz: tzFor(state),
      },
    };
  };

  // ── sampling ──
  const times: number[] = [];
  if (lastMs === startMs) {
    times.push(startMs);
  } else {
    for (let ms = startMs; ms < lastMs; ms += stepMs) times.push(ms);
    times.push(lastMs); // always include the exact end
  }
  const internal = times.map(sampleAt);
  const samples = internal.map((x) => x.sample);

  // ── transitions ──
  const transitions: Transition[] = [];

  /** Resolve window changes inside (loMs, hiMs] where f(loMs) = wLo ≠ wHi = f(hiMs). Chronological output. */
  const resolve = (loMs: number, wLo: PrayerWindow, hiMs: number, wHi: PrayerWindow, out: Transition[], depth: number): void => {
    if (out.length >= MAX_TRANSITIONS_PER_INTERVAL || depth > 40) {
      out.push({ ms: hiMs, from: wLo, to: wHi });
      return;
    }
    // A jump that is not "the next window in the cycle" may hide short windows: subdivide first.
    if (classify(wLo, wHi).kind !== 'normal' && hiMs - loMs > 4 * refineMs) {
      const pts: number[] = [];
      for (let i = 0; i <= SUBDIVISIONS; i++) pts.push(loMs + Math.round(((hiMs - loMs) * i) / SUBDIVISIONS));
      const ws = pts.map((p, i) => (i === 0 ? wLo : i === SUBDIVISIONS ? wHi : f(p)));
      for (let i = 0; i < SUBDIVISIONS; i++) {
        if (ws[i] !== ws[i + 1] && pts[i + 1] > pts[i]) resolve(pts[i], ws[i], pts[i + 1], ws[i + 1], out, depth + 1);
      }
      return;
    }
    // Plain bisection on f(t) down to refineMs.
    let lo = loMs, hi = hiMs, wl = wLo, wh = wHi;
    while (hi - lo > refineMs) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (mid <= lo || mid >= hi) break;
      const wm = f(mid);
      if (wm === wl) lo = mid;
      else { hi = mid; wh = wm; }
    }
    out.push({ ms: hi, from: wl, to: wh });
    if (wh !== wHi && hi < hiMs) resolve(hi, wh, hiMs, wHi, out, depth + 1);
  };

  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i].window, b = samples[i + 1].window;
    if (a !== b) {
      const out: Transition[] = [];
      resolve(times[i], a, times[i + 1], b, out, 0);
      transitions.push(...out);
    }
  }

  // ── events + anomalies ──
  const events: PrayerEvent[] = [];
  const anomalies: InflightResult['anomalies'] = [];

  for (const tr of transitions) {
    const state = stateAtMs(tr.ms);
    const w = windowAtMs(tr.ms, state);
    const prayer: PrayerName = w.window;
    const note: TimeNote = w.openedBy?.note ?? 'noEvent';
    const time = new Date(tr.ms);
    const step = classify(tr.from, prayer);

    let anomaly: AnomalyKind | undefined;
    if (step.kind === 'repeated') {
      anomaly = 'windowRepeated';
      anomalies.push({
        time, kind: 'windowRepeated',
        message: repeatedMessage(tr.from, prayer, state, motionAt(tr.ms), settings, note),
      });
    } else if (step.kind === 'skipped') {
      anomaly = 'windowSkipped';
      anomalies.push({
        time, kind: 'windowSkipped',
        message: skippedMessage(tr.from, prayer, step.skipped, state, motionAt(tr.ms)),
      });
    }
    if (note === 'highLatitudeRule' || note === 'nearestLatitude' || note === 'redTwilight') {
      anomaly ??= 'highLatitudeRuleUsed';
      const borrowed = note === 'nearestLatitude' ? borrowedLatFor(state, tr.ms, prayer) : undefined;
      anomalies.push({ time, kind: 'highLatitudeRuleUsed', message: highLatMessage(prayer, note, state, settings, borrowed) });
    }
    events.push({ prayer, time, state, note, ...(anomaly ? { anomaly } : {}) });
  }

  // Polar day / night: once per contiguous stretch (a change polarDay ↔ polarNight starts a new stretch).
  let stretch: StaticPrayerTimes['dayState'] = 'normal';
  for (const { sample, dayState } of internal) {
    if (dayState !== stretch) {
      stretch = dayState;
      if (dayState === 'polarDay' || dayState === 'polarNight') {
        const loc = formatLatLon(sample.state.lat, sample.state.lon);
        anomalies.push({
          time: sample.state.time,
          kind: dayState,
          message: polarMessage(
            dayState,
            loc,
            settings,
            settings.highLatitudeRule === 'none' ? undefined : borrowedLatFor(sample.state, sample.state.time.getTime()),
          ),
        });
      }
    }
  }

  anomalies.sort((a, b) => a.time.getTime() - b.time.getTime());
  return { samples, events, anomalies, initialWindow: samples[0].window };
}
