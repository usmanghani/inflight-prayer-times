import { describe, it, expect } from 'vitest';
import { KAABA, qiblaBearing, relativeBearing } from '../src/geo/qibla';

describe('qiblaBearing', () => {
  it('Karachi ~ 267 deg, San Francisco ~ 19 deg, New York ~ 58 deg', () => {
    expect(qiblaBearing(24.8607, 67.0011)).toBeCloseTo(267.3, 0);
    expect(qiblaBearing(37.6213, -122.379)).toBeCloseTo(18.6, 0);
    expect(qiblaBearing(40.7128, -74.006)).toBeCloseTo(58.5, 0);
  });
  it('London ~ 119 deg, Jakarta ~ 295 deg, Sydney ~ 278 deg', () => {
    expect(qiblaBearing(51.5074, -0.1278)).toBeCloseTo(118.987, 0);
    expect(qiblaBearing(-6.2, 106.8)).toBeCloseTo(295, 0);
    expect(qiblaBearing(-33.87, 151.21)).toBeCloseTo(277.5, 0);
  });
  it('is 0 at the Kaaba and finite at the poles / odd inputs', () => {
    expect(KAABA).toEqual({ lat: 21.422487, lon: 39.826206 });
    expect(qiblaBearing(KAABA.lat, KAABA.lon)).toBe(0);
    for (const [lat, lon] of [[90, 0], [-90, 0], [90, 39.826206], [89.99999, 10], [0, 180], [0, -180], [0, 540]]) {
      const b = qiblaBearing(lat, lon);
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
    expect(qiblaBearing(NaN, 10)).toBe(0);
    expect(qiblaBearing(10, Infinity)).toBe(0);
  });
  it('at the north pole the Qibla is due south along the Kaaba meridian; at the south pole due north', () => {
    expect(qiblaBearing(90, KAABA.lon)).toBeCloseTo(180, 3);
    expect(qiblaBearing(-90, KAABA.lon)).toBeCloseTo(0, 3);
  });
  it('from west of Mecca at about its latitude the Qibla is roughly east', () => {
    const b = qiblaBearing(21.4, 0);
    expect(b).toBeGreaterThan(60);
    expect(b).toBeLessThan(90);
  });
});

describe('relativeBearing', () => {
  it('normalises to (-180, 180]', () => {
    expect(relativeBearing(90, 0)).toBe(90);
    expect(relativeBearing(0, 90)).toBe(-90);
    expect(relativeBearing(10, 350)).toBe(20);
    expect(relativeBearing(350, 10)).toBe(-20);
    expect(relativeBearing(180, 0)).toBe(180);
    expect(relativeBearing(0, 180)).toBe(180);
    expect(relativeBearing(750, -330)).toBe(0); // 750 - (-330) = 1080 = 3 turns
    expect(relativeBearing(100, -100)).toBe(-160); // 200 wraps to -160
  });
  it('never returns NaN', () => {
    expect(relativeBearing(NaN, 10)).toBe(0);
    expect(relativeBearing(10, Infinity)).toBe(0);
  });
});
