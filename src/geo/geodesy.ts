import type { LatLon } from '../types';

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

type Vec3 = [number, number, number];

/** Wrap a longitude into [-180, 180). Non-finite input maps to 0 (never NaN). */
export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  // The trailing `% 360` guards the case where `+ 360` rounds a tiny negative up to exactly 360.
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Clamp a latitude into [-90, 90]. Non-finite input maps to 0. */
export function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return Math.max(-90, Math.min(90, lat));
}

function norm360(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r >= 360 ? 0 : r; // -1e-17 % 360 + 360 can round to 360
}

function toVec(p: LatLon): Vec3 {
  const lat = clampLat(p.lat) * DEG;
  const lon = normalizeLon(p.lon) * DEG;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

function fromVec(v: Vec3): LatLon {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  const x = v[0] / n, y = v[1] / n, z = v[2] / n;
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * RAD; // clamp: |z| may exceed 1 by 1 ulp
  // At the poles x = y = 0 so atan2 is meaningless; pick lon 0 for determinism.
  const lon = Math.abs(x) < 1e-15 && Math.abs(y) < 1e-15 ? 0 : Math.atan2(y, x) * RAD;
  return { lat, lon: normalizeLon(lon) };
}

/** Great-circle distance in km (haversine). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const la1 = clampLat(a.lat) * DEG;
  const la2 = clampLat(b.lat) * DEG;
  const dLat = la2 - la1;
  const dLon = (normalizeLon(b.lon) - normalizeLon(a.lon)) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  let h = s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2;
  h = Math.max(0, Math.min(1, h)); // rounding can push h just outside [0,1] -> sqrt/asin NaN
  if (h > 0.75) {
    // Beyond ~120° of arc the haversine loses precision (1-h cancellation): use the cross/dot angle instead.
    const va = toVec(a), vb = toVec(b);
    const cx = va[1] * vb[2] - va[2] * vb[1];
    const cy = va[2] * vb[0] - va[0] * vb[2];
    const cz = va[0] * vb[1] - va[1] * vb[0];
    return EARTH_RADIUS_KM * Math.atan2(Math.hypot(cx, cy, cz), va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]);
  }
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing a→b, 0..360 (0 for identical points). */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const la1 = clampLat(a.lat) * DEG;
  const la2 = clampLat(b.lat) * DEG;
  const dLon = (normalizeLon(b.lon) - normalizeLon(a.lon)) * DEG;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  if (y === 0 && x === 0) return 0; // identical points: atan2(0,0) would be 0 anyway, made explicit
  return norm360(Math.atan2(y, x) * RAD);
}

/** Deterministic path for exactly antipodal points: up the meridian of `a`, over the north pole. */
function antipodalPoint(a: LatLon, f: number): LatLon {
  const lat0 = clampLat(a.lat);
  const lon0 = normalizeLon(a.lon);
  const travelled = f * 180; // degrees of arc from a
  const toPole = 90 - lat0;
  if (travelled <= toPole) return { lat: lat0 + travelled, lon: lon0 };
  return { lat: 180 - lat0 - travelled, lon: normalizeLon(lon0 + 180) };
}

/** Spherical linear interpolation along the great circle a→b; f clamped to [0,1]. */
export function interpolateGreatCircle(a: LatLon, b: LatLon, f: number): LatLon {
  const ff = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  if (ff <= 0) return { lat: clampLat(a.lat), lon: normalizeLon(a.lon) };
  if (ff >= 1) return { lat: clampLat(b.lat), lon: normalizeLon(b.lon) };
  const va = toVec(a);
  const vb = toVec(b);
  const cx: Vec3 = [
    va[1] * vb[2] - va[2] * vb[1],
    va[2] * vb[0] - va[0] * vb[2],
    va[0] * vb[1] - va[1] * vb[0],
  ];
  const sinD = Math.hypot(cx[0], cx[1], cx[2]);
  const cosD = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
  const d = Math.atan2(sinD, cosD); // atan2 form is accurate for both tiny and near-π angles
  if (d < 1e-12) return { lat: clampLat(a.lat), lon: normalizeLon(a.lon) }; // zero-length: sin(d)=0 division
  if (sinD < 1e-10 && cosD < 0) return antipodalPoint(a, ff); // antipodal: plane of the circle undefined
  const k0 = Math.sin((1 - ff) * d) / sinD;
  const k1 = Math.sin(ff * d) / sinD;
  return fromVec([k0 * va[0] + k1 * vb[0], k0 * va[1] + k1 * vb[1], k0 * va[2] + k1 * vb[2]]);
}

/** Total length of a polyline of great-circle segments, km. */
export function pathLengthKm(points: LatLon[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += haversineKm(points[i - 1], points[i]);
  return s;
}

export interface PathLocation {
  /** Index of the segment (points[segment] → points[segment+1]); 0 for degenerate paths. */
  segment: number;
  /** Fraction 0..1 along that segment. */
  t: number;
  point: LatLon;
  bearingDeg: number;
}

/** Precomputed cumulative distances so repeated lookups are O(log n). */
export interface PathIndex {
  totalKm: number;
  cumKm: number[]; // cumKm[i] = distance from points[0] to points[i]
  locate(distanceKm: number): PathLocation;
}

export function buildPathIndex(points: LatLon[]): PathIndex {
  const n = points.length;
  const cum: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversineKm(points[i - 1], points[i]);
  const total = n > 0 ? cum[n - 1] : 0;
  // Last segment with positive length: where distances >= total are clamped.
  let lastPos = -1;
  for (let i = n - 2; i >= 0; i--) {
    if (cum[i + 1] > cum[i]) { lastPos = i; break; }
  }
  const first: LatLon = n > 0
    ? { lat: clampLat(points[0].lat), lon: normalizeLon(points[0].lon) }
    : { lat: 0, lon: 0 };

  function locate(distanceKm: number): PathLocation {
    if (n < 2 || lastPos < 0) return { segment: 0, t: 0, point: first, bearingDeg: 0 }; // 0/1-point or all-duplicate path
    const d = Number.isFinite(distanceKm) ? Math.max(0, Math.min(total, distanceKm)) : 0;
    // Smallest i with cum[i+1] > d (skips zero-length duplicate segments).
    let lo = 0, hi = n - 2, seg = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] > d) { seg = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (seg < 0) seg = lastPos; // d == total
    const len = cum[seg + 1] - cum[seg];
    const t = Math.max(0, Math.min(1, (d - cum[seg]) / len)); // len > 0 guaranteed by construction
    const p0 = points[seg], p1 = points[seg + 1];
    const point = t <= 0
      ? { lat: clampLat(p0.lat), lon: normalizeLon(p0.lon) }
      : t >= 1 ? { lat: clampLat(p1.lat), lon: normalizeLon(p1.lon) }
        : interpolateGreatCircle(p0, p1, t);
    // At/near the segment end the forward bearing is undefined; use the reverse bearing from the end instead.
    const bearingDeg = len * (1 - t) < 1e-6
      ? norm360(initialBearingDeg(p1, p0) + 180)
      : initialBearingDeg(point, p1);
    return { segment: seg, t, point, bearingDeg };
  }

  return { totalKm: total, cumKm: cum, locate };
}

/** Position and track bearing `distanceKm` along the path (clamped to its ends). */
export function pointAlongPath(points: LatLon[], distanceKm: number): { point: LatLon; bearingDeg: number } {
  const loc = buildPathIndex(points).locate(distanceKm);
  return { point: loc.point, bearingDeg: loc.bearingDeg };
}

/** Insert great-circle intermediate points so segments are at most ~stepKm long (for drawing). */
export function densifyPath(points: LatLon[], stepKm: number): LatLon[] {
  if (points.length < 2) return points.map((p) => ({ lat: clampLat(p.lat), lon: normalizeLon(p.lon) }));
  let step = Number.isFinite(stepKm) && stepKm > 0 ? stepKm : 50;
  const total = pathLengthKm(points);
  if (total / step > 50000) step = total / 50000; // safety cap on output size
  const out: LatLon[] = [{ lat: clampLat(points[0].lat), lon: normalizeLon(points[0].lon) }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.ceil(haversineKm(a, b) / step);
    for (let k = 1; k < n; k++) out.push(interpolateGreatCircle(a, b, k / n));
    out.push({ lat: clampLat(b.lat), lon: normalizeLon(b.lon) });
  }
  return out;
}

/**
 * Split a path wherever it crosses the ±180° meridian so Leaflet does not draw a line across the
 * whole map. The crossing latitude is linearly interpolated, so densify first for accuracy.
 */
export function splitAtAntimeridian(points: LatLon[]): LatLon[][] {
  if (points.length === 0) return [];
  const norm = points.map((p) => ({ lat: clampLat(p.lat), lon: normalizeLon(p.lon) }));
  const parts: LatLon[][] = [];
  let cur: LatLon[] = [norm[0]];
  for (let i = 1; i < norm.length; i++) {
    const p = norm[i - 1], q = norm[i];
    if (Math.abs(q.lon - p.lon) > 180) {
      const east = p.lon > q.lon; // positive → negative lon means travelling east across +180
      const qu = east ? q.lon + 360 : q.lon - 360; // unwrap q next to p
      const edge = east ? 180 : -180;
      const t = (edge - p.lon) / (qu - p.lon); // qu - p.lon != 0 because |qu - p.lon| < 180 and crossing implies a gap
      const lat = p.lat + Math.max(0, Math.min(1, t)) * (q.lat - p.lat);
      cur.push({ lat, lon: edge });
      parts.push(cur);
      cur = [{ lat, lon: -edge }];
    }
    cur.push(q);
  }
  parts.push(cur);
  return parts;
}
