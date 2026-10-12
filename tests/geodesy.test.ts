import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_KM, buildPathIndex, clampLat, densifyPath, haversineKm, initialBearingDeg,
  interpolateGreatCircle, normalizeLon, pathLengthKm, pointAlongPath, splitAtAntimeridian,
} from '../src/geo/geodesy';
import type { LatLon } from '../src/types';

const KHI: LatLon = { lat: 24.9065, lon: 67.1608 };
const DXB: LatLon = { lat: 25.2528, lon: 55.3644 };
const SFO: LatLon = { lat: 37.6189, lon: -122.375 };
const JFK: LatLon = { lat: 40.6398, lon: -73.7789 };
const LHR: LatLon = { lat: 51.47, lon: -0.4543 };
const AKL: LatLon = { lat: -37.0082, lon: 174.785 };
const SYD: LatLon = { lat: -33.9461, lon: 151.1772 };
const LAX: LatLon = { lat: 33.9425, lon: -118.4081 };
const HKG: LatLon = { lat: 22.308, lon: 113.9185 };

const finite = (p: LatLon) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

describe('normalizeLon / clampLat', () => {
  it('wraps into [-180,180)', () => {
    expect(normalizeLon(0)).toBe(0);
    expect(normalizeLon(180)).toBe(-180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(190)).toBeCloseTo(-170, 9);
    expect(normalizeLon(-190)).toBeCloseTo(170, 9);
    expect(normalizeLon(720 + 33)).toBeCloseTo(33, 9);
    expect(normalizeLon(-1e-20)).toBeGreaterThanOrEqual(-180);
    expect(normalizeLon(-1e-20)).toBeLessThan(180);
    expect(normalizeLon(NaN)).toBe(0);
    expect(normalizeLon(Infinity)).toBe(0);
  });
  it('clamps latitude', () => {
    expect(clampLat(95)).toBe(90);
    expect(clampLat(-95)).toBe(-90);
    expect(clampLat(12.5)).toBe(12.5);
    expect(clampLat(NaN)).toBe(0);
  });
});

describe('haversine', () => {
  it('KHI→SFO ≈ 12,99x km (independent calc: 12,991.5)', () => {
    const d = haversineKm(KHI, SFO);
    expect(d).toBeGreaterThan(12980);
    expect(d).toBeLessThan(13000);
  });
  it('JFK→LHR ≈ 5,540 km', () => {
    expect(haversineKm(JFK, LHR)).toBeCloseTo(5540.2, 0);
  });
  it('is symmetric, zero for identical points and half-circumference for antipodes', () => {
    expect(haversineKm(KHI, DXB)).toBeCloseTo(haversineKm(DXB, KHI), 9);
    expect(haversineKm(KHI, KHI)).toBe(0);
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: -10, lon: -160 })).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6);
  });
  it('treats lon 180 and -180 as the same place', () => {
    expect(haversineKm({ lat: 10, lon: 180 }, { lat: 10, lon: -180 })).toBeCloseTo(0, 9);
  });
  it('pole to pole = half circumference; quarter circle equator to pole', () => {
    expect(haversineKm({ lat: 90, lon: 0 }, { lat: -90, lon: 0 })).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6);
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 90, lon: 123 })).toBeCloseTo((Math.PI / 2) * EARTH_RADIUS_KM, 6);
  });
});

describe('bearing', () => {
  it('KHI→DXB is roughly west, slightly north (≈274°)', () => {
    const b = initialBearingDeg(KHI, DXB);
    expect(b).toBeGreaterThan(270);
    expect(b).toBeLessThan(280);
    expect(b).toBeCloseTo(274.36, 1);
  });
  it('cardinal directions', () => {
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0, 9);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90, 9);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: -10, lon: 0 })).toBeCloseTo(180, 9);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -10 })).toBeCloseTo(270, 9);
  });
  it('is 0 for identical points and always within [0,360)', () => {
    expect(initialBearingDeg(KHI, KHI)).toBe(0);
    for (const [a, b] of [[SFO, AKL], [AKL, SFO], [JFK, HKG], [{ lat: 90, lon: 0 }, KHI], [KHI, { lat: -90, lon: 0 }]] as [LatLon, LatLon][]) {
      const x = initialBearingDeg(a, b);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(360);
    }
  });
  it('from the north pole everything is south-ish', () => {
    const b = initialBearingDeg({ lat: 90, lon: 0 }, { lat: 45, lon: 0 });
    expect(b).toBeCloseTo(180, 6);
  });
});

describe('interpolateGreatCircle', () => {
  it('endpoints and midpoint', () => {
    const s = interpolateGreatCircle(KHI, SFO, 0);
    const e = interpolateGreatCircle(KHI, SFO, 1);
    expect(s.lat).toBeCloseTo(KHI.lat, 9);
    expect(e.lon).toBeCloseTo(SFO.lon, 9);
    const m = interpolateGreatCircle(KHI, SFO, 0.5);
    expect(haversineKm(KHI, m)).toBeCloseTo(haversineKm(KHI, SFO) / 2, 3);
    expect(haversineKm(m, SFO)).toBeCloseTo(haversineKm(KHI, SFO) / 2, 3);
  });
  it('clamps f outside [0,1] and tolerates NaN', () => {
    expect(interpolateGreatCircle(KHI, DXB, -3).lat).toBeCloseTo(KHI.lat, 9);
    expect(interpolateGreatCircle(KHI, DXB, 7).lon).toBeCloseTo(DXB.lon, 9);
    expect(finite(interpolateGreatCircle(KHI, DXB, NaN))).toBe(true);
  });
  it('zero-length leg returns the point (no sin(d)=0 NaN)', () => {
    for (const f of [0, 0.3, 0.5, 1]) {
      const p = interpolateGreatCircle(KHI, KHI, f);
      expect(p.lat).toBeCloseTo(KHI.lat, 9);
      expect(p.lon).toBeCloseTo(KHI.lon, 9);
    }
    // Almost identical points (d ~ 1e-9)
    const p = interpolateGreatCircle(KHI, { lat: KHI.lat + 1e-8, lon: KHI.lon }, 0.5);
    expect(finite(p)).toBe(true);
  });
  it('antipodal points: deterministic, finite and exactly half-circumference in total', () => {
    const a: LatLon = { lat: 30, lon: 40 };
    const b: LatLon = { lat: -30, lon: -140 };
    let prev = a;
    let total = 0;
    for (let i = 1; i <= 100; i++) {
      const p = interpolateGreatCircle(a, b, i / 100);
      expect(finite(p)).toBe(true);
      total += haversineKm(prev, p);
      prev = p;
    }
    expect(total).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 3);
    expect(interpolateGreatCircle(a, b, 0.5)).toEqual(interpolateGreatCircle(a, b, 0.5));
    // Passes over the north pole after 60° of arc (lat 30 → 90).
    expect(interpolateGreatCircle(a, b, 60 / 180).lat).toBeCloseTo(90, 9);
    expect(interpolateGreatCircle(a, b, 0.5).lat).toBeCloseTo(60, 9);
  });
  it('antipodal from a pole and the equator', () => {
    for (const [a, b] of [[{ lat: 90, lon: 0 }, { lat: -90, lon: 0 }], [{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }], [{ lat: -90, lon: 12 }, { lat: 90, lon: 5 }]] as [LatLon, LatLon][]) {
      for (let i = 0; i <= 20; i++) expect(finite(interpolateGreatCircle(a, b, i / 20))).toBe(true);
    }
  });
  it('passes close to the pole on JFK→HKG (polar route) without NaN and with continuous steps', () => {
    const total = haversineKm(JFK, HKG);
    let prev = interpolateGreatCircle(JFK, HKG, 0);
    let maxLat = -90;
    for (let i = 1; i <= 400; i++) {
      const p = interpolateGreatCircle(JFK, HKG, i / 400);
      expect(finite(p)).toBe(true);
      expect(haversineKm(prev, p)).toBeLessThan(total / 400 + 1);
      maxLat = Math.max(maxLat, p.lat);
      prev = p;
    }
    expect(maxLat).toBeGreaterThan(75);
  });
  it('SFO→AKL crosses the antimeridian continuously', () => {
    const total = haversineKm(SFO, AKL);
    let prev = interpolateGreatCircle(SFO, AKL, 0);
    let crossed = false;
    for (let i = 1; i <= 300; i++) {
      const p = interpolateGreatCircle(SFO, AKL, i / 300);
      expect(finite(p)).toBe(true);
      expect(p.lon).toBeGreaterThanOrEqual(-180);
      expect(p.lon).toBeLessThan(180);
      expect(haversineKm(prev, p)).toBeLessThan(total / 300 + 1);
      if (Math.abs(p.lon - prev.lon) > 180) crossed = true;
      prev = p;
    }
    expect(crossed).toBe(true);
  });
  it('works from the poles', () => {
    const p = interpolateGreatCircle({ lat: 90, lon: 0 }, { lat: 0, lon: 90 }, 0.5);
    expect(p.lat).toBeCloseTo(45, 6);
    expect(p.lon).toBeCloseTo(90, 6);
  });
});

describe('pathLengthKm / pointAlongPath', () => {
  const path = [KHI, DXB, LHR, SFO];
  it('sums segments; 0 for empty/single', () => {
    expect(pathLengthKm([])).toBe(0);
    expect(pathLengthKm([KHI])).toBe(0);
    expect(pathLengthKm(path)).toBeCloseTo(haversineKm(KHI, DXB) + haversineKm(DXB, LHR) + haversineKm(LHR, SFO), 6);
  });
  it('clamps to the ends and returns defined bearings', () => {
    const total = pathLengthKm(path);
    const s = pointAlongPath(path, -50);
    const e = pointAlongPath(path, total + 500);
    expect(s.point.lat).toBeCloseTo(KHI.lat, 9);
    expect(e.point.lat).toBeCloseTo(SFO.lat, 9);
    expect(e.point.lon).toBeCloseTo(SFO.lon, 9);
    expect(s.bearingDeg).toBeCloseTo(initialBearingDeg(KHI, DXB), 6);
    // Bearing at the very end is the arrival track, not 0.
    expect(e.bearingDeg).toBeCloseTo((initialBearingDeg(SFO, LHR) + 180) % 360, 6);
  });
  it('distance along the path matches', () => {
    const total = pathLengthKm(path);
    for (const f of [0.1, 0.25, 0.5, 0.75, 0.99]) {
      const r = pointAlongPath(path, total * f);
      expect(finite(r.point)).toBe(true);
      expect(r.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(r.bearingDeg).toBeLessThan(360);
    }
    const first = haversineKm(KHI, DXB);
    expect(pointAlongPath(path, first).point.lon).toBeCloseTo(DXB.lon, 6);
    const half = pointAlongPath([KHI, DXB], first / 2);
    expect(haversineKm(KHI, half.point)).toBeCloseTo(first / 2, 3);
  });
  it('handles 0 and 1 point paths', () => {
    expect(pointAlongPath([], 10)).toEqual({ point: { lat: 0, lon: 0 }, bearingDeg: 0 });
    const one = pointAlongPath([KHI], 10);
    expect(one.point.lat).toBeCloseTo(KHI.lat, 9);
    expect(one.bearingDeg).toBe(0);
  });
  it('handles duplicate consecutive points and all-duplicate paths', () => {
    const dup = [KHI, KHI, DXB, DXB, DXB, LHR];
    const total = pathLengthKm(dup);
    for (let i = 0; i <= 50; i++) {
      const r = pointAlongPath(dup, (total * i) / 50);
      expect(finite(r.point)).toBe(true);
      expect(Number.isFinite(r.bearingDeg)).toBe(true);
    }
    expect(pointAlongPath(dup, 0).bearingDeg).toBeCloseTo(initialBearingDeg(KHI, DXB), 6);
    const same = pointAlongPath([KHI, KHI, KHI], 100);
    expect(same.point.lat).toBeCloseTo(KHI.lat, 9);
    expect(same.bearingDeg).toBe(0);
  });
  it('NaN distance is treated as 0', () => {
    const r = pointAlongPath(path, NaN);
    expect(r.point.lat).toBeCloseTo(KHI.lat, 9);
  });
  it('buildPathIndex exposes cumulative distances and segment fraction', () => {
    const idx = buildPathIndex(path);
    expect(idx.totalKm).toBeCloseTo(pathLengthKm(path), 9);
    expect(idx.cumKm).toHaveLength(4);
    const loc = idx.locate(idx.cumKm[1] + (idx.cumKm[2] - idx.cumKm[1]) / 2);
    expect(loc.segment).toBe(1);
    expect(loc.t).toBeCloseTo(0.5, 6);
  });
  it('polar path: no NaN along JFK→HKG densified', () => {
    const p = densifyPath([JFK, HKG], 100);
    const total = pathLengthKm(p);
    for (let i = 0; i <= 200; i++) {
      const r = pointAlongPath(p, (total * i) / 200);
      expect(finite(r.point) && Number.isFinite(r.bearingDeg)).toBe(true);
    }
  });
});

describe('densifyPath', () => {
  it('keeps endpoints and limits segment length', () => {
    const d = densifyPath([KHI, SFO], 100);
    expect(d[0].lat).toBeCloseTo(KHI.lat, 9);
    expect(d[d.length - 1].lon).toBeCloseTo(SFO.lon, 9);
    expect(d.length).toBeGreaterThan(125);
    for (let i = 1; i < d.length; i++) expect(haversineKm(d[i - 1], d[i])).toBeLessThanOrEqual(100.5);
    expect(pathLengthKm(d)).toBeCloseTo(haversineKm(KHI, SFO), 2);
  });
  it('step <= 0 / NaN → 50 km', () => {
    const d0 = densifyPath([KHI, DXB], 0);
    const dn = densifyPath([KHI, DXB], -5);
    const d50 = densifyPath([KHI, DXB], 50);
    expect(d0.length).toBe(d50.length);
    expect(dn.length).toBe(d50.length);
    expect(densifyPath([KHI, DXB], NaN).length).toBe(d50.length);
  });
  it('tiny/zero-length segments and short inputs', () => {
    expect(densifyPath([], 50)).toEqual([]);
    expect(densifyPath([KHI], 50)).toHaveLength(1);
    expect(densifyPath([KHI, KHI], 50)).toHaveLength(2);
  });
});

describe('splitAtAntimeridian', () => {
  it('SFO→AKL densified splits into 2 parts with a shared crossing latitude', () => {
    const parts = splitAtAntimeridian(densifyPath([SFO, AKL], 50));
    expect(parts).toHaveLength(2);
    const [p1, p2] = parts;
    expect(p1[0].lon).toBeCloseTo(SFO.lon, 9);
    // Westbound over the Pacific: leaves the western edge (-180) and re-enters at +180.
    expect(p1[p1.length - 1].lon).toBe(-180);
    expect(p2[0].lon).toBe(180);
    expect(p1[p1.length - 1].lat).toBeCloseTo(p2[0].lat, 9);
    expect(p2[p2.length - 1].lon).toBeCloseTo(AKL.lon, 9);
    // The crossing latitude is plausible (southern hemisphere, close to AKL).
    const lat = p1[p1.length - 1].lat;
    expect(lat).toBeGreaterThan(-40);
    expect(lat).toBeLessThan(-20);
    // Check the crossing against the true great circle.
    const dense = densifyPath([SFO, AKL], 1);
    let best = 999;
    for (const p of dense) best = Math.min(best, Math.abs(Math.abs(p.lon) - 180) < 0.05 ? Math.abs(p.lat - lat) : 999);
    expect(best).toBeLessThan(0.5);
  });
  it('crossings in both directions (AKL→SFO, SYD→LAX, LAX→SYD)', () => {
    expect(splitAtAntimeridian(densifyPath([AKL, SFO], 50))).toHaveLength(2);
    expect(splitAtAntimeridian(densifyPath([LAX, SYD], 50))).toHaveLength(2);
    // Eastbound (SYD→LAX) exits at +180; westbound (LAX→SYD) exits at -180.
    const east = splitAtAntimeridian(densifyPath([SYD, LAX], 50));
    expect(east[0][east[0].length - 1].lon).toBe(180);
    const west = splitAtAntimeridian(densifyPath([LAX, SYD], 50));
    expect(west[0][west[0].length - 1].lon).toBe(-180);
  });
  it('no crossing → single part; empty → []', () => {
    expect(splitAtAntimeridian(densifyPath([KHI, LHR], 50))).toHaveLength(1);
    expect(splitAtAntimeridian([])).toEqual([]);
    expect(splitAtAntimeridian([KHI])).toHaveLength(1);
  });
  it('a simple two-point jump interpolates the crossing latitude', () => {
    const parts = splitAtAntimeridian([{ lat: 0, lon: 170 }, { lat: 10, lon: -170 }]);
    expect(parts).toHaveLength(2);
    expect(parts[0][1]).toEqual({ lat: 5, lon: 180 });
    expect(parts[1][0]).toEqual({ lat: 5, lon: -180 });
  });
  it('multiple crossings', () => {
    const parts = splitAtAntimeridian([
      { lat: 0, lon: 170 }, { lat: 0, lon: -170 }, { lat: 0, lon: 170 }, { lat: 0, lon: -170 },
    ]);
    expect(parts).toHaveLength(4);
  });
});
