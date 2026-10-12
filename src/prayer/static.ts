/**
 * Prayer times for a fixed place and (local mean solar) date, plus window lookup.
 *
 * Method: every event is "the Sun reaches altitude a". From spherical astronomy
 *     cos H = (sin a − sin φ sin δ) / (cos φ cos δ)
 * gives the hour angle H of the crossing; time = solar transit ∓ H/15 h.
 * δ and the equation of time change during the day, so each crossing is iterated:
 * evaluate the Sun at the estimated time, recompute, repeat (converges in 2–3 steps).
 *
 * Numerics: when |cos H| > 1 the Sun never reaches that altitude (or never drops
 * below it); that is reported as 'never'/'always', never as NaN. No NaN or
 * Invalid Date can leave this module – a time is a valid Date or null.
 */
import { DEG, RAD, horizonDipDeg, normalizeLon, sunPosition } from '../astro/solar';
import { asrShadowFactor } from './methods';
import type {
  HighLatitudeRule,
  Observer,
  PrayerName,
  PrayerSettings,
  PrayerTime,
  PrayerWindow,
  StaticPrayerTimes,
  TimeNote,
} from '../types';

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Legacy fixed latitude of the "nearest latitude" fallback (`polarFallback: 'fixedLatitude'`), and the last resort. */
const NEAREST_LAT = 48.5;
/** Nearest-location search: grid step toward the equator, bisection tolerance, and safety margin (degrees). */
const SEARCH_STEP = 0.25;
const SEARCH_TOL = 0.01;
const SEARCH_MARGIN = 0.05;
/** Size of the memo of latitude searches (a flight asks for the same day/longitude thousands of times). */
const SEARCH_CACHE_SIZE = 256;
/** Refined iterations per crossing; declination/EoT drift is tiny so 4 is ample. */
const ITERATIONS = 4;
/** Below this |cos φ cos δ| the hour-angle division is meaningless (poles); use the sign instead. */
const MIN_DENOM = 1e-12;

const PRAYER_ORDER: readonly PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

// ─────────────────────────── dates ───────────────────────────

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** Format a UTC instant as YYYY-MM-DD (safe for any year, unlike toISOString for |year| > 9999). */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return `${y < 0 ? '-' : ''}${pad(y, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Parse YYYY-MM-DD to the UTC midnight (ms) that starts that mean-solar day; NaN if malformed. */
function parseDate(s: string): number {
  const m = /^(-?\d{4,6})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return NaN;
  const d = new Date(0);
  // setUTCFullYear (unlike Date.UTC) does not remap years 0..99 to 1900..1999.
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

/**
 * Local *mean solar* date (YYYY-MM-DD) at longitude `lon` for instant `t`:
 * the UTC date of (t + lon/15 hours). Longitudes outside ±180 are normalised.
 * Returns 'invalid-date' for an invalid instant.
 */
export function solarDateAt(t: Date, lon: number): string {
  const ms = t.getTime() + (normalizeLon(lon) / 15) * MS_PER_HOUR;
  return Number.isFinite(ms) ? formatDate(ms) : 'invalid-date';
}

// ─────────────────────────── crossings ───────────────────────────

type Crossing = { kind: 'time'; ms: number } | { kind: 'never' } | { kind: 'always' };

/**
 * When does the Sun cross altitude `altOf(δ)` on the mean-solar day starting at
 * `dayStartMs`, in the morning (side −1) or afternoon (side +1)?
 * 'never'  = the Sun stays below that altitude all day (cos H > 1);
 * 'always' = the Sun stays above it all day (cos H < −1).
 * `altOf` may return null to mean "the target altitude is unreachable" (→ 'never').
 */
function crossing(
  dayStartMs: number,
  lat: number,
  lon: number,
  altOf: (declDeg: number) => number | null,
  side: -1 | 1,
): Crossing {
  const noonMs = dayStartMs + 12 * MS_PER_HOUR - (lon / 15) * MS_PER_HOUR; // mean solar noon
  const sinPhi = Math.sin(lat * RAD);
  const cosPhi = Math.cos(lat * RAD);
  let t = noonMs;
  for (let i = 0; i < ITERATIONS; i++) {
    const pos = sunPosition(new Date(t));
    const transitMs = noonMs - pos.eqTimeMin * MS_PER_MIN; // apparent noon at this EoT
    const alt = altOf(pos.declinationDeg);
    if (alt === null || !Number.isFinite(alt)) return { kind: 'never' };

    const decl = pos.declinationDeg * RAD;
    const num = Math.sin(alt * RAD) - sinPhi * Math.sin(decl);
    const den = cosPhi * Math.cos(decl);
    let cosH: number;
    if (Math.abs(den) < MIN_DENOM) {
      // Poles: the Sun's altitude is constant (= declination) all day, so it is either
      // above or below the target all day; the sign of the numerator tells which.
      cosH = num < 0 ? -Infinity : Infinity;
    } else {
      cosH = num / den;
    }
    if (cosH > 1) return { kind: 'never' };
    if (cosH < -1) return { kind: 'always' };
    const hHours = (Math.acos(cosH) * DEG) / 15;
    t = transitMs + side * hHours * MS_PER_HOUR;
  }
  return Number.isFinite(t) ? { kind: 'time', ms: t } : { kind: 'never' };
}

/** Solar transit (apparent noon) for the mean-solar day: iterate the equation of time. */
function transit(dayStartMs: number, lon: number): number {
  const noonMs = dayStartMs + 12 * MS_PER_HOUR - (lon / 15) * MS_PER_HOUR;
  let t = noonMs;
  for (let i = 0; i < 3; i++) t = noonMs - sunPosition(new Date(t)).eqTimeMin * MS_PER_MIN;
  return t;
}

/** Asr altitude: shadow = factor × object + noon shadow ⇒ alt = atan(1 / (factor + tan z)), z = |φ − δ|. */
function asrAltitude(lat: number, factor: 1 | 2): (declDeg: number) => number | null {
  return (declDeg) => {
    const z = Math.abs(lat - declDeg);
    // z >= 90 ⇒ the Sun is at or below the horizon even at noon: no Asr (also avoids tan(≥90°) < 0).
    if (z >= 90) return null;
    return Math.atan(1 / (factor + Math.tan(z * RAD))) * DEG;
  };
}

// ─────────────────────────── core ───────────────────────────

const NO_EVENT: PrayerTime = { time: null, note: 'noEvent' };
const pt = (ms: number, note: TimeNote = 'ok'): PrayerTime => ({ time: new Date(ms), note });
const asMs = (p: PrayerTime): number | null => (p.time ? p.time.getTime() : null);

interface Core {
  fajr: PrayerTime;
  sunrise: PrayerTime;
  dhuhr: PrayerTime;
  asr: PrayerTime;
  maghrib: PrayerTime;
  isha: PrayerTime;
  /** Sunset (geometric horizon incl. dip) and the following sunrise, for midnight. */
  sunsetMs: number | null;
  nextSunriseMs: number | null;
  /** True if the values come from the nearest-latitude fallback at ±48.5°. */
  fallback: boolean;
  /** Signed latitude whose times were borrowed (see StaticPrayerTimes.borrowedLatitude). */
  borrowedLat?: number;
  dayState: StaticPrayerTimes['dayState'];
}

function emptyCore(): Core {
  return {
    fajr: NO_EVENT, sunrise: NO_EVENT, dhuhr: NO_EVENT, asr: NO_EVENT, maghrib: NO_EVENT, isha: NO_EVENT,
    sunsetMs: null, nextSunriseMs: null, fallback: false, dayState: 'normal',
  };
}

/** Fraction of the night that Fajr/Isha may be away from sunrise/sunset under a rule. */
function nightPortion(rule: HighLatitudeRule, angle: number): number | null {
  switch (rule) {
    case 'angleBased': return angle / 60;
    case 'oneSeventh': return 1 / 7;
    case 'middleOfNight': return 1 / 2;
    default: return null;
  }
}

// ─────────────────────── nearest-location search ───────────────────────

/**
 * Do all the given Sun altitudes get crossed at `lat`? With `withNight`, also sunset and *next* sunrise at alts[0].
 * With a non-zero `asrFactor`, Asr (shadow factor 1 or 2) must exist too.
 */
function altitudesReached(
  dayStartMs: number,
  lat: number,
  lon: number,
  alts: number[],
  withNight: boolean,
  asrFactor: 1 | 2 | 0,
): boolean {
  // Cheapest/most restrictive first: a failed crossing returns after a single Sun evaluation.
  for (const a of alts) {
    if (crossing(dayStartMs, lat, lon, () => a, -1).kind !== 'time') return false;
  }
  if (withNight) {
    if (crossing(dayStartMs, lat, lon, () => alts[0], +1).kind !== 'time') return false;
    if (crossing(dayStartMs + MS_PER_DAY, lat, lon, () => alts[0], -1).kind !== 'time') return false;
  }
  // Asr needs the noon Sun to be above the horizon (otherwise a Dec. polar-night edge place has no Asr).
  if (asrFactor !== 0 && crossing(dayStartMs, lat, lon, asrAltitude(lat, asrFactor), +1).kind !== 'time') return false;
  return true;
}

/** Tiny LRU (Map keeps insertion order): key -> |latitude| found, or null when none exists. */
const searchCache = new Map<string, number | null>();

/**
 * Nearest-location (aqrab al-bilad) search. Starting poleward of the observer (whose own latitude is known to
 * fail), walk toward the equator on a fixed 0.25° grid until all `alts` are crossed (and, with `withNight`, the
 * sun also sets and rises the next day); then bisect the bracket down to 0.01° and step a further 0.05° toward
 * the equator so the borrowed place is safely inside the region where the events exist.
 *
 * The grid is global (multiples of 0.25°) and the longitude is quantised to 0.1°, so the result depends only on
 * hemisphere, date, ~longitude and altitudes, not on the exact observer position: that makes it memoisable.
 * Returns a signed latitude, or null if the equator is reached without success (cannot happen for real
 * parameters: at the equator the Sun always rises/sets and goes at least 66° below the horizon).
 */
function findNearestLatitude(
  lat: number,
  lon: number,
  dayStartMs: number,
  alts: number[],
  withNight: boolean,
  asrFactor: 1 | 2 | 0 = 0,
): number | null {
  const sign = lat < 0 ? -1 : 1;
  const lonKey = Math.round(lon * 10);
  const key = `${sign}|${dayStartMs}|${lonKey}|${withNight ? 1 : 0}|${asrFactor}|${alts.map((a) => a.toFixed(3)).join(',')}`;
  let mag = searchCache.get(key);
  if (mag !== undefined) {
    searchCache.delete(key); // refresh recency
    searchCache.set(key, mag);
  } else {
    mag = searchMagnitude(Math.abs(lat), lonKey / 10, sign, dayStartMs, alts, withNight, asrFactor);
    searchCache.set(key, mag);
    if (searchCache.size > SEARCH_CACHE_SIZE) searchCache.delete(searchCache.keys().next().value as string);
  }
  return mag === null ? null : sign * mag;
}

function searchMagnitude(
  startMag: number,
  lon: number,
  sign: 1 | -1,
  dayStartMs: number,
  alts: number[],
  withNight: boolean,
  asrFactor: 1 | 2 | 0,
): number | null {
  const ok = (mag: number) => altitudesReached(dayStartMs, sign * mag, lon, alts, withNight, asrFactor);
  // Largest grid latitude strictly closer to the equator than the observer.
  let k = Math.ceil(startMag / SEARCH_STEP) - 1;
  while (k >= 0 && !ok(k * SEARCH_STEP)) k--;
  if (k < 0) return null;
  let lo = k * SEARCH_STEP; // events exist
  let hi = lo + SEARCH_STEP; // events do not exist (the observer is at or beyond this, by monotonicity)
  while (hi - lo > SEARCH_TOL) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return Math.max(0, lo - SEARCH_MARGIN);
}

/** Current size of the memo (exposed for tests only). */
export function _searchCacheSize(): number {
  return searchCache.size;
}

/**
 * Prayer times (no offsets) for one mean-solar day starting at `dayStartMs`.
 * `allowFallback` is false when already computing at the nearest latitude.
 */
function computeCore(
  lat: number,
  lon: number,
  elevationM: number,
  dayStartMs: number,
  s: PrayerSettings,
  allowFallback: boolean,
): Core {
  const m = s.method;
  const dip = horizonDipDeg(elevationM);
  const horizonAlt = -(0.833 + (s.dipForSunriseSunset ? dip : 0)); // sunrise/sunset altitude
  const twilightDip = s.dipForTwilight ? dip : 0;
  const nextDayMs = dayStartMs + MS_PER_DAY;
  const flat = (a: number) => () => a;

  const rise = crossing(dayStartMs, lat, lon, flat(horizonAlt), -1);
  const set = crossing(dayStartMs, lat, lon, flat(horizonAlt), +1);
  const nextRise = crossing(nextDayMs, lat, lon, flat(horizonAlt), -1);

  const dayState: Core['dayState'] =
    rise.kind === 'always' || set.kind === 'always' ? 'polarDay'
      : rise.kind === 'never' || set.kind === 'never' ? 'polarNight'
        : 'normal';

  // No sunrise/sunset (or no sunrise tomorrow ⇒ no night length): borrow a nearer place's times.
  const nightKnown = rise.kind === 'time' && set.kind === 'time' && nextRise.kind === 'time';
  if (!nightKnown && allowFallback && s.highLatitudeRule !== 'none') {
    let nearLat: number | null = null;
    if (s.polarFallback !== 'fixedLatitude') {
      // Nearest location where the sun rises and sets (and reaches the Maghrib angle, if any) and Asr exists.
      const alts = [horizonAlt];
      if (m.maghribAngle !== null) alts.push(-m.maghribAngle - twilightDip);
      nearLat = findNearestLatitude(lat, lon, dayStartMs, alts, true, asrShadowFactor(s.madhab));
    }
    // Legacy fixed latitude (also the last resort if the search ever finds nothing).
    if (nearLat === null && Math.abs(lat) > NEAREST_LAT) nearLat = lat > 0 ? NEAREST_LAT : -NEAREST_LAT;
    if (nearLat !== null) {
      const c = computeCore(nearLat, lon, elevationM, dayStartMs, s, false);
      // Keep more specific notes ('interval', 'highLatitudeRule') that the fallback itself produced.
      const tag = (p: PrayerTime): PrayerTime => (p.time && p.note === 'ok' ? { time: p.time, note: 'nearestLatitude' } : p);
      // Dhuhr (solar transit) does not depend on latitude, so it stays an exact 'ok'.
      return {
        ...c,
        fajr: tag(c.fajr), sunrise: tag(c.sunrise), asr: tag(c.asr), maghrib: tag(c.maghrib), isha: tag(c.isha),
        fallback: true,
        borrowedLat: nearLat,
        dayState,
      };
    }
  }

  const core = emptyCore();
  core.dayState = dayState;
  core.dhuhr = pt(transit(dayStartMs, lon));
  if (rise.kind === 'time') core.sunrise = pt(rise.ms);
  if (set.kind === 'time') core.sunsetMs = set.ms;
  if (nextRise.kind === 'time') core.nextSunriseMs = nextRise.ms;

  // Asr
  const asr = crossing(dayStartMs, lat, lon, asrAltitude(lat, asrShadowFactor(s.madhab)), +1);
  if (asr.kind === 'time') core.asr = pt(asr.ms);

  // Maghrib: sunset, or a sun angle below the horizon (Ja'fari/Tehran).
  if (m.maghribAngle !== null) {
    const mg = crossing(dayStartMs, lat, lon, flat(-m.maghribAngle - twilightDip), +1);
    if (mg.kind === 'time') core.maghrib = pt(mg.ms);
    else if (set.kind === 'time') core.maghrib = pt(set.ms, 'highLatitudeRule'); // angle unreachable: use sunset
  } else if (set.kind === 'time') {
    core.maghrib = pt(set.ms);
  }

  // Fajr
  const fajr = crossing(dayStartMs, lat, lon, flat(-m.fajrAngle - twilightDip), -1);
  if (fajr.kind === 'time') core.fajr = pt(fajr.ms);

  // Isha: fixed interval after Maghrib wins if set, otherwise a sun angle.
  const ishaByInterval = m.ishaIntervalMin !== null;
  if (ishaByInterval) {
    const mg = asMs(core.maghrib);
    if (mg !== null) core.isha = pt(mg + (m.ishaIntervalMin as number) * MS_PER_MIN, 'interval');
  } else if (m.ishaAngle !== null) {
    const is = crossing(dayStartMs, lat, lon, flat(-m.ishaAngle - twilightDip), +1);
    if (is.kind === 'time') core.isha = pt(is.ms);
  }

  applyHighLatitudeRule(core, lat, lon, elevationM, dayStartMs, s, ishaByInterval);
  return core;
}

/**
 * Fill in / correct Fajr and Isha when the twilight angle is unreachable or the
 * resulting time is further from sunrise/sunset than the rule allows.
 * night = next sunrise − sunset; Isha = sunset + portion, Fajr = sunrise − portion.
 */
function applyHighLatitudeRule(
  core: Core,
  lat: number,
  lon: number,
  elevationM: number,
  dayStartMs: number,
  s: PrayerSettings,
  ishaByInterval: boolean,
): void {
  const rule = s.highLatitudeRule;
  if (rule === 'none') return;
  const m = s.method;
  const sunriseMs = asMs(core.sunrise);
  const sunsetMs = core.sunsetMs;
  const nextRiseMs = core.nextSunriseMs;
  const night = sunsetMs !== null && nextRiseMs !== null ? nextRiseMs - sunsetMs : null;
  // `portion` is the rule's limit; `angleRule` is used when 'nearestLatitude' cannot help.
  const portionFor = (angle: number): number | null => {
    if (night === null || !(night > 0)) return null;
    const f = nightPortion(rule === 'nearestLatitude' ? 'angleBased' : rule, angle);
    return f === null ? null : f * night;
  };

  const fajrMs = asMs(core.fajr);
  const ishaMs = asMs(core.isha);
  const needFajr = fajrMs === null;
  const needIsha = ishaMs === null && !ishaByInterval;

  if (rule === 'nearestLatitude' && (needFajr || needIsha)) {
    // A borrowed time on the wrong side of the local sunrise/sunset is meaningless; guard it.
    const fajrOk = (ms: number) => sunriseMs === null || ms < sunriseMs;
    const ishaOk = (ms: number) => sunsetMs === null || ms > sunsetMs;
    const note = (b: number) => {
      if (core.borrowedLat === undefined || Math.abs(b) < Math.abs(core.borrowedLat)) core.borrowedLat = b;
    };
    if (s.polarFallback === 'fixedLatitude') {
      // Legacy: take the missing times from latitude ±48.5° (same longitude/date).
      if (Math.abs(lat) > NEAREST_LAT) {
        const b = lat > 0 ? NEAREST_LAT : -NEAREST_LAT;
        const near = computeCore(b, lon, elevationM, dayStartMs, s, false);
        if (needFajr && near.fajr.time && fajrOk(near.fajr.time.getTime())) {
          core.fajr = { time: near.fajr.time, note: 'nearestLatitude' };
          note(b);
        }
        if (needIsha && near.isha.time && ishaOk(near.isha.time.getTime())) {
          core.isha = { time: near.isha.time, note: 'nearestLatitude' };
          note(b);
        }
      }
    } else {
      // Nearest location where *this* twilight angle is actually reached (searched per event).
      const twilightDip = s.dipForTwilight ? horizonDipDeg(elevationM) : 0;
      const borrow = (angle: number, side: -1 | 1): { ms: number; lat: number } | null => {
        const alt = -angle - twilightDip;
        let b = findNearestLatitude(lat, lon, dayStartMs, [alt], false);
        if (b === null && Math.abs(lat) > NEAREST_LAT) b = lat > 0 ? NEAREST_LAT : -NEAREST_LAT; // last resort
        if (b === null) return null;
        const c = crossing(dayStartMs, b, lon, () => alt, side);
        return c.kind === 'time' ? { ms: c.ms, lat: b } : null;
      };
      if (needFajr) {
        const r = borrow(m.fajrAngle, -1);
        if (r && fajrOk(r.ms)) { core.fajr = pt(r.ms, 'nearestLatitude'); note(r.lat); }
      }
      if (needIsha && m.ishaAngle !== null) {
        const r = borrow(m.ishaAngle, +1);
        if (r && ishaOk(r.ms)) { core.isha = pt(r.ms, 'nearestLatitude'); note(r.lat); }
      }
    }
  }

  // Night-portion rules (also the last resort for 'nearestLatitude' when the borrowed time is unusable).
  const fajrNow = asMs(core.fajr);
  const ishaNow = asMs(core.isha);
  if (sunriseMs !== null) {
    const lim = portionFor(m.fajrAngle);
    const missing = fajrNow === null;
    // For portion rules, also pull in a Fajr that is *too far* before sunrise.
    const tooFar = rule !== 'nearestLatitude' && fajrNow !== null && lim !== null && sunriseMs - fajrNow > lim;
    // Fajr after sunrise can only come from a borrowed time; keep the order sane.
    const wrongSide = fajrNow !== null && fajrNow >= sunriseMs;
    if (lim !== null && (missing || tooFar || wrongSide)) core.fajr = pt(sunriseMs - lim, 'highLatitudeRule');
  }
  if (sunsetMs !== null && !ishaByInterval && m.ishaAngle !== null) {
    const lim = portionFor(m.ishaAngle);
    // Measure from sunset, or from an angle-based Maghrib (Ja'fari/Tehran) if that is later,
    // so that Isha can never be derived at or before Maghrib.
    const base = Math.max(sunsetMs, asMs(core.maghrib) ?? sunsetMs);
    const missing = ishaNow === null;
    const tooFar = rule !== 'nearestLatitude' && ishaNow !== null && lim !== null && ishaNow - base > lim;
    const wrongSide = ishaNow !== null && ishaNow <= base;
    if (lim !== null && (missing || tooFar || wrongSide)) core.isha = pt(base + lim, 'highLatitudeRule');
  }
}

// ─────────────────────────── public API ───────────────────────────

function allNull(solarDate: string): StaticPrayerTimes {
  return {
    solarDate,
    fajr: NO_EVENT, sunrise: NO_EVENT, dhuhr: NO_EVENT, asr: NO_EVENT, maghrib: NO_EVENT, isha: NO_EVENT,
    midnight: NO_EVENT,
    dayState: 'normal',
  };
}

/** Sanitise an Observer; null if lat/lon are not finite numbers. Elevation: non-finite → 0, clamped 0..100 km. */
function sanitize(obs: Observer): { lat: number; lon: number; elev: number } | null {
  if (!obs || !Number.isFinite(obs.lat) || !Number.isFinite(obs.lon)) return null;
  const lat = Math.max(-90, Math.min(90, obs.lat));
  const elev = Number.isFinite(obs.elevationM) ? Math.max(0, Math.min(100_000, obs.elevationM)) : 0;
  return { lat, lon: normalizeLon(obs.lon), elev };
}

function withOffset(p: PrayerTime, minutes: number): PrayerTime {
  if (!p.time || !Number.isFinite(minutes) || minutes === 0) return p;
  return { time: new Date(p.time.getTime() + minutes * MS_PER_MIN), note: p.note };
}

function applyOffsets(c: Core, s: PrayerSettings): Pick<StaticPrayerTimes, PrayerName> {
  const o = s.offsets;
  return {
    fajr: withOffset(c.fajr, o.fajr),
    sunrise: withOffset(c.sunrise, o.sunrise),
    dhuhr: withOffset(c.dhuhr, o.dhuhr),
    asr: withOffset(c.asr, o.asr),
    maghrib: withOffset(c.maghrib, o.maghrib),
    isha: withOffset(c.isha, o.isha),
  };
}

/** Prayer times at a fixed place for the given local solar date (YYYY-MM-DD). Never throws or returns NaN. */
export function computeStaticTimes(obs: Observer, solarDate: string, settings: PrayerSettings): StaticPrayerTimes {
  const o = sanitize(obs);
  const dayStart = parseDate(solarDate);
  if (!o || !Number.isFinite(dayStart)) return allNull(solarDate);

  const today = computeCore(o.lat, o.lon, o.elev, dayStart, settings, true);
  const tomorrow = computeCore(o.lat, o.lon, o.elev, dayStart + MS_PER_DAY, settings, true);

  // Islamic midnight: midpoint of sunset → next sunrise (or next Fajr for Ja'fari).
  let midnight: PrayerTime = NO_EVENT;
  const jafari = settings.method.midnight === 'jafari';
  const endMs = jafari ? asMs(tomorrow.fajr) : today.nextSunriseMs;
  if (today.sunsetMs !== null && endMs !== null && endMs > today.sunsetMs) {
    const note: TimeNote =
      today.fallback || tomorrow.fallback ? 'nearestLatitude'
        : jafari && tomorrow.fajr.note === 'highLatitudeRule' ? 'highLatitudeRule' : 'ok';
    midnight = pt(today.sunsetMs + (endMs - today.sunsetMs) / 2, note);
  }

  return {
    solarDate,
    ...applyOffsets(today, settings),
    midnight,
    dayState: today.dayState,
    ...(today.borrowedLat !== undefined ? { borrowedLatitude: today.borrowedLat } : {}),
  };
}

/**
 * Which prayer window instant `t` falls in at this fixed place: the window opened by
 * the last event at or before `t`, looking at solar dates d−1, d, d+1.
 * If no event exists at all (invalid input) the window defaults to 'isha' with openedBy null.
 */
export function windowAt(
  t: Date,
  obs: Observer,
  settings: PrayerSettings,
): {
  window: PrayerWindow;
  openedBy: { prayer: PrayerName; time: Date; note: TimeNote } | null;
  dayState: StaticPrayerTimes['dayState'];
} {
  const o = sanitize(obs);
  const tMs = t.getTime();
  if (!o || !Number.isFinite(tMs)) return { window: 'isha', openedBy: null, dayState: 'normal' };

  const d = parseDate(solarDateAt(t, o.lon));
  const days = [-1, 0, 1].map((k) => {
    const start = d + k * MS_PER_DAY;
    return { k, times: computeStaticTimes({ lat: o.lat, lon: o.lon, elevationM: o.elev }, formatDate(start), settings) };
  });

  type Ev = { prayer: PrayerName; time: Date; note: TimeNote; ms: number; order: number };
  const events: Ev[] = [];
  for (const { k, times } of days) {
    PRAYER_ORDER.forEach((prayer, i) => {
      const p = times[prayer];
      if (p.time) events.push({ prayer, time: p.time, note: p.note, ms: p.time.getTime(), order: k * 10 + i });
    });
  }
  // Chronological; ties (e.g. offsets collapsing two events) keep prayer order.
  events.sort((a, b) => a.ms - b.ms || a.order - b.order);

  let last: Ev | null = null;
  for (const ev of events) {
    if (ev.ms <= tMs) last = ev;
    else break;
  }
  const dayState = days[1].times.dayState;
  if (!last) return { window: 'isha', openedBy: null, dayState };
  return { window: last.prayer, openedBy: { prayer: last.prayer, time: last.time, note: last.note }, dayState };
}

/**
 * Makrooh (disliked) prayer intervals for a day: ~15 min after sunrise, ~5 min before
 * Dhuhr (zawal, sun at the meridian) and ~15 min before Maghrib. Missing times are skipped.
 */
export function makroohIntervals(times: StaticPrayerTimes): { start: Date; end: Date; label: string }[] {
  const out: { start: Date; end: Date; label: string }[] = [];
  // Interval = [event + startMin, event + endMin].
  const add = (a: Date | null, startMin: number, endMin: number, label: string) => {
    if (!a) return;
    const ms = a.getTime();
    out.push({ start: new Date(ms + startMin * MS_PER_MIN), end: new Date(ms + endMin * MS_PER_MIN), label });
  };
  add(times.sunrise.time, 0, 15, 'After sunrise');
  add(times.dhuhr.time, -5, 0, 'Zawal (sun at its zenith)');
  add(times.maghrib.time, -15, 0, 'Before sunset');
  return out;
}
