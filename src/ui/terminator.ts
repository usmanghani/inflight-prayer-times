/** Day/night terminator for map shading. */
import { sunPosition } from '../astro/solar';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function wrap180(x: number): number {
  const r = (((x + 180) % 360) + 360) % 360;
  return r - 180;
}

/** The point on Earth where the Sun is at the zenith. */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const p = sunPosition(date);
  return { lat: p.declinationDeg, lon: wrap180(p.rightAscensionDeg - p.gmstDeg) };
}

/**
 * Polygon (as [lat, lon] pairs) covering the night side of the Earth at `date`,
 * closed through the pole that is currently in darkness.
 */
export function nightPolygon(date: Date, stepDeg = 3): [number, number][] {
  const sub = subsolarPoint(date);
  let dec = sub.lat;
  if (Math.abs(dec) < 0.05) dec = dec < 0 ? -0.05 : 0.05; // avoid tan(0) at the equinox
  const tanDec = Math.tan(dec * RAD);
  const pts: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const H = (lon - sub.lon) * RAD;
    const lat = Math.atan(-Math.cos(H) / tanDec) * DEG;
    pts.push([Math.max(-89.9, Math.min(89.9, lat)), lon]);
  }
  const pole = dec >= 0 ? -90 : 90; // the night pole is opposite the Sun's hemisphere
  pts.push([pole, 180], [pole, -180]);
  return pts;
}
