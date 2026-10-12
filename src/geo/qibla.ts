/** Qibla direction: initial great-circle bearing from an observer to the Kaaba. */

/** Coordinates of the Kaaba, Makkah. */
export const KAABA = { lat: 21.422487, lon: 39.826206 };

const RAD = Math.PI / 180;

/** Normalise degrees to [0, 360). */
function norm360(x: number): number {
  const r = ((x % 360) + 360) % 360;
  // (-1e-15 % 360 + 360) % 360 can round to exactly 360; fold it back to 0.
  return r >= 360 ? 0 : r;
}

/**
 * True (geographic) bearing from (lat, lon) to the Kaaba, 0..360 clockwise from north.
 * Uses atan2 so it is defined everywhere: at the Kaaba itself both components are
 * exactly 0 and atan2(0, 0) = 0; at the poles the formula degenerates to a
 * meridian-based direction (every direction at a pole is "south"/"north" by
 * convention, here measured against the observer's longitude). Non-finite input -> 0.
 */
export function qiblaBearing(lat: number, lon: number): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
  const phi1 = lat * RAD;
  const phi2 = KAABA.lat * RAD;
  const dLon = (KAABA.lon - lon) * RAD;

  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const b = norm360(Math.atan2(y, x) / RAD);
  return Number.isFinite(b) ? b : 0;
}

/**
 * Qibla relative to the direction the aircraft is heading: positive = turn right
 * (clockwise). Result normalised to (-180, 180]. Non-finite input -> 0.
 */
export function relativeBearing(bearing: number, heading: number): number {
  if (!Number.isFinite(bearing) || !Number.isFinite(heading)) return 0;
  const r = norm360(bearing - heading);
  return r > 180 ? r - 360 : r;
}
