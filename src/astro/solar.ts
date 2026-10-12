/**
 * Low-precision solar position (NOAA / Meeus, "Astronomical Algorithms" ch. 25 & 28).
 * Accuracy is ~0.01° for declination and ~0.1 min for the equation of time over
 * several centuries around J2000, and it degrades gracefully (no NaN) outside.
 */

export const DEG = 180 / Math.PI; // radians -> degrees
export const RAD = Math.PI / 180; // degrees -> radians

const MS_PER_DAY = 86_400_000;
/** Julian Day of the Unix epoch (1970-01-01T00:00:00Z). */
const JD_UNIX_EPOCH = 2440587.5;
/** Julian Day of J2000.0 (2000-01-01T12:00:00 TT, treated as UTC here). */
const JD_J2000 = 2451545.0;

/** Reduce an angle to [0, 360). */
function mod360(x: number): number {
  const r = x % 360;
  return r < 0 ? r + 360 : r;
}

/** Normalise an angle to (-180, 180]. */
function wrap180(x: number): number {
  const r = mod360(x);
  return r > 180 ? r - 360 : r;
}

/**
 * Normalise a longitude to [-180, 180). Non-finite input yields 0 so callers
 * never propagate NaN.
 */
export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  const r = ((((lon + 180) % 360) + 360) % 360) - 180;
  return r;
}

/** Julian Day (UT) of a JS Date. NaN only if the Date itself is invalid. */
export function julianDay(date: Date): number {
  return date.getTime() / MS_PER_DAY + JD_UNIX_EPOCH;
}

export interface SunPosition {
  /** Apparent declination, degrees. */
  declinationDeg: number;
  /** Apparent right ascension, degrees in [0, 360). */
  rightAscensionDeg: number;
  /** Equation of time (apparent minus mean solar time), minutes. */
  eqTimeMin: number;
  /** Greenwich mean sidereal time, degrees in [0, 360). */
  gmstDeg: number;
}

/** Sun's apparent position & the equation of time for an instant. */
export function sunPosition(date: Date): SunPosition {
  const jd = julianDay(date);
  const d = jd - JD_J2000; // days since J2000
  const T = d / 36525; // Julian centuries since J2000

  // Geometric mean longitude and mean anomaly of the Sun (deg), eccentricity of Earth's orbit.
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = mod360(357.52911 + T * (35999.05029 - T * 0.0001537));
  const e = 0.016708634 - T * (0.000042037 + T * 0.0000001267);

  // Equation of the centre (deg) -> true longitude.
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + T * 0.000014)) +
    Math.sin(2 * Mr) * (0.019993 - T * 0.000101) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;

  // Apparent longitude: correct for nutation & aberration (via the Moon's node Ω).
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  // Mean obliquity of the ecliptic (arc-seconds polynomial) + nutation term.
  const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const eps0 = 23 + (26 + seconds / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega * RAD)) * RAD;

  const lr = lambda * RAD;
  // atan2 keeps the quadrant right; asin argument is |.| <= sin(eps) < 1 so it is safe.
  const ra = mod360(Math.atan2(Math.cos(eps) * Math.sin(lr), Math.cos(lr)) * DEG);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lr)) * DEG;

  // Equation of time (min), Meeus eq. 28.3 in series form.
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eqRad =
    y * Math.sin(2 * L0r) -
    2 * e * Math.sin(Mr) +
    4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
    0.5 * y * y * Math.sin(4 * L0r) -
    1.25 * e * e * Math.sin(2 * Mr);
  const eqTimeMin = 4 * eqRad * DEG; // 1° of hour angle = 4 minutes

  // Greenwich mean sidereal time (deg).
  const gmst = mod360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T);

  return { declinationDeg: dec, rightAscensionDeg: ra, eqTimeMin, gmstDeg: gmst };
}

/**
 * Geometric (no refraction) horizontal coordinates of the Sun for an observer.
 * Azimuth is measured from true north, clockwise. Hour angle is the local
 * hour angle normalised to (-180, 180] (0 at transit, negative in the morning).
 */
export function sunAltAz(
  date: Date,
  lat: number,
  lon: number,
): { altitudeDeg: number; azimuthDeg: number; hourAngleDeg: number } {
  const { declinationDeg, rightAscensionDeg, gmstDeg } = sunPosition(date);
  const H = wrap180(gmstDeg + lon - rightAscensionDeg);
  const phi = lat * RAD;
  const delta = declinationDeg * RAD;
  const Hr = H * RAD;

  const sinAlt = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(Hr);
  // Clamp: rounding can push |sinAlt| a hair past 1, which would make asin return NaN.
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;

  // Azimuth from north, clockwise. Using atan2 on the (east, north) components avoids
  // any division, so it is finite at the poles (cos φ = 0) and at the zenith (both 0 -> 0).
  const east = -Math.cos(delta) * Math.sin(Hr);
  const north = Math.sin(delta) * Math.cos(phi) - Math.cos(delta) * Math.cos(Hr) * Math.sin(phi);
  const az = mod360(Math.atan2(east, north) * DEG);

  return { altitudeDeg: alt, azimuthDeg: az, hourAngleDeg: H };
}

/**
 * Dip of the visible horizon (degrees) for an observer `elevationM` metres up:
 * ≈ 0.0347·√h (standard-refraction approximation, ≈ 3.64° at 11 000 m).
 * Returns 0 for NaN, ±Infinity and negative heights.
 */
export function horizonDipDeg(elevationM: number): number {
  if (!Number.isFinite(elevationM)) return 0;
  return 0.0347 * Math.sqrt(Math.max(0, elevationM));
}
