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
 *   windowRepeated  – the window sequence moved backwards (e.g. Asr → Dhuhr: flying west faster than the sun)
 *   windowSkipped   – one or more windows never opened (e.g. Maghrib missing between Asr and Isha)
 *   highLatitudeRuleUsed – an event time came from a high-latitude rule, not from the Sun's angle
 *   polarDay / polarNight – the Sun does not set / rise at the aircraft's place that day
 *
 * No NaN / Invalid Date leaves this module.
 */
import { sunAltAz } from '../astro/solar';
import { qiblaBearing, relativeBearing } from '../geo/qibla';
import { tzAt } from '../time/tz';
import { windowAt } from './static';
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

const DIRECTION_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const directionWord = (headingDeg: number): string =>
  DIRECTION_WORDS[Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8];

const SCHOLAR_NOTE =
  'Scholars generally hold that a prayer already prayed within its valid time remains valid; consult a scholar about any repeat or combining.';

function repeatedMessage(prev: PrayerWindow, next: PrayerWindow, s: AircraftState): string {
  const loc = formatLatLon(s.lat, s.lon);
  const northSouth = `${Math.round(Math.abs(s.lat))}°${s.lat >= 0 ? 'N' : 'S'}`;
  const sinH = Math.sin((fin(s.headingDeg) * Math.PI) / 180);
  const westward = !s.onGround && sinH < -0.1;
  const eastward = !s.onGround && sinH > 0.1;
  const sunLike = idx(next) <= idx('asr'); // the "day" windows: the sun appears to come back up
  const what = `the ${PRAYER_LABEL[next]} window re-opened after ${PRAYER_LABEL[prev]}`;
  if (westward && sunLike) {
    return (
      `Flying west faster than the sun near ${northSouth}: the sun appears to rise again in the west; ${what}. ` +
      SCHOLAR_NOTE
    );
  }
  if (westward) {
    return (
      `Flying west faster than the sun near ${northSouth} (${loc}): the evening light returns; ${what}. ` + SCHOLAR_NOTE
    );
  }
  if (eastward) {
    return (
      `Flying ${directionWord(s.headingDeg)} near ${loc}: the prayer times at this longitude are earlier than at the previous one; ${what}. ` +
      SCHOLAR_NOTE
    );
  }
  return `Near ${loc}: the window sequence went backwards; ${what}. ` + SCHOLAR_NOTE;
}

function skippedMessage(prev: PrayerWindow, next: PrayerWindow, skipped: PrayerWindow[], s: AircraftState): string {
  const loc = formatLatLon(s.lat, s.lon);
  const names = skipped.map((w) => PRAYER_LABEL[w]).join(' and ');
  const high = Math.abs(s.lat) > 45 ? ' At this latitude the twilight can be very short or absent.' : '';
  return (
    `Near ${loc}: the ${names} window${skipped.length > 1 ? 's' : ''} did not open ` +
    `(${PRAYER_LABEL[prev]} went straight to ${PRAYER_LABEL[next]}).${high} ` +
    'Follow your chosen high-latitude rule or ask a scholar.'
  );
}

function highLatMessage(prayer: PrayerName, note: TimeNote, s: AircraftState): string {
  const loc = formatLatLon(s.lat, s.lon);
  if (note === 'nearestLatitude') {
    return `${PRAYER_LABEL[prayer]} at ${loc} is taken from the nearest-latitude rule (times of 48.5° at the same longitude) because the Sun's twilight angle is not reached here.`;
  }
  return `${PRAYER_LABEL[prayer]} at ${loc} comes from your high-latitude rule (a share of the night), not from the Sun's angle, because the twilight angle is not reached or the night is too short.`;
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
      anomalies.push({ time, kind: 'windowRepeated', message: repeatedMessage(tr.from, prayer, state) });
    } else if (step.kind === 'skipped') {
      anomaly = 'windowSkipped';
      anomalies.push({ time, kind: 'windowSkipped', message: skippedMessage(tr.from, prayer, step.skipped, state) });
    }
    if (note === 'highLatitudeRule' || note === 'nearestLatitude') {
      anomaly ??= 'highLatitudeRuleUsed';
      anomalies.push({ time, kind: 'highLatitudeRuleUsed', message: highLatMessage(prayer, note, state) });
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
          message:
            dayState === 'polarDay'
              ? `Polar day near ${loc}: the Sun does not set on this date, so sunset-based times do not occur normally; the high-latitude rule (${settings.highLatitudeRule}) decides the windows.`
              : `Polar night near ${loc}: the Sun does not rise on this date, so sunrise and sunset do not occur normally; the high-latitude rule (${settings.highLatitudeRule}) decides the windows.`,
        });
      }
    }
  }

  anomalies.sort((a, b) => a.time.getTime() - b.time.getTime());
  return { samples, events, anomalies, initialWindow: samples[0].window };
}
