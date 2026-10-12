import { describe, it, expect } from 'vitest';
import { DEG, RAD, horizonDipDeg, julianDay, sunAltAz, sunPosition } from '../src/astro/solar';

describe('julianDay', () => {
  it('matches known epochs', () => {
    expect(julianDay(new Date('1970-01-01T00:00:00Z'))).toBeCloseTo(2440587.5, 9);
    expect(julianDay(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 9);
  });
  it('exposes consistent unit constants', () => {
    expect(DEG * RAD).toBeCloseTo(1, 12);
  });
});

describe('sunPosition', () => {
  it('declination ~ +23.44 at the June solstice, ~ -23.44 in December, ~0 at the equinox', () => {
    expect(sunPosition(new Date('2026-06-21T03:00:00Z')).declinationDeg).toBeCloseTo(23.44, 1);
    expect(sunPosition(new Date('2026-12-21T15:00:00Z')).declinationDeg).toBeCloseTo(-23.44, 1);
    expect(Math.abs(sunPosition(new Date('2026-03-20T14:46:00Z')).declinationDeg)).toBeLessThan(0.1);
    expect(Math.abs(sunPosition(new Date('2026-09-23T00:05:00Z')).declinationDeg)).toBeLessThan(0.1);
  });

  it('equation of time: ~ -14 min mid-February, ~ +16 min early November', () => {
    const feb = sunPosition(new Date('2026-02-11T12:00:00Z')).eqTimeMin;
    const nov = sunPosition(new Date('2026-11-03T12:00:00Z')).eqTimeMin;
    expect(feb).toBeGreaterThan(-14.8);
    expect(feb).toBeLessThan(-13.6);
    expect(nov).toBeGreaterThan(15.8);
    expect(nov).toBeLessThan(16.6);
  });

  it('matches a published NOAA value (2000-01-01 12:00 UT: decl -23.01, EoT -3.2 min, RA ~281.3)', () => {
    const p = sunPosition(new Date('2000-01-01T12:00:00Z'));
    expect(p.declinationDeg).toBeCloseTo(-23.01, 1);
    expect(p.eqTimeMin).toBeCloseTo(-3.2, 0);
    expect(p.rightAscensionDeg).toBeCloseTo(281.3, 0);
    expect(p.gmstDeg).toBeCloseTo(280.46 + 360.98564736629 * 0, 1); // GMST at J2000.0 = 280.46°
  });

  it('is finite for far-past and far-future dates', () => {
    for (const iso of ['1600-01-01T00:00:00Z', '1900-06-01T00:00:00Z', '2100-12-31T23:59:59Z', '3000-01-01T00:00:00Z']) {
      const p = sunPosition(new Date(iso));
      for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(p.declinationDeg)).toBeLessThan(24);
    }
  });
});

describe('sunAltAz', () => {
  it('is near-zenith at the subsolar point and the Sun is south of a northern observer at noon', () => {
    // Equinox noon, observer on the equator at the meridian where it is solar noon.
    const t = new Date('2026-03-20T12:00:00Z');
    const eq = sunPosition(t).eqTimeMin;
    const lon = -eq / 4; // apparent noon at this longitude (EoT in minutes -> degrees)
    const a = sunAltAz(t, 0, lon);
    expect(a.altitudeDeg).toBeGreaterThan(88);
    expect(Math.abs(a.hourAngleDeg)).toBeLessThan(0.5);

    const north = sunAltAz(t, 40, lon);
    expect(north.azimuthDeg).toBeGreaterThan(179);
    expect(north.azimuthDeg).toBeLessThan(181);
    expect(north.altitudeDeg).toBeCloseTo(50, 0);
  });

  it('sun is in the east in the morning and the west in the evening', () => {
    // 2026-03-21 Karachi: 06:00 PKT (01:00 UTC) sun is up in the east, 18:00 PKT in the west.
    const am = sunAltAz(new Date('2026-03-21T01:00:00Z'), 24.86, 67.0);
    const pm = sunAltAz(new Date('2026-03-21T13:00:00Z'), 24.86, 67.0);
    expect(am.azimuthDeg).toBeGreaterThan(60);
    expect(am.azimuthDeg).toBeLessThan(110);
    expect(pm.azimuthDeg).toBeGreaterThan(250);
    expect(pm.azimuthDeg).toBeLessThan(300);
    expect(am.hourAngleDeg).toBeLessThan(0);
    expect(pm.hourAngleDeg).toBeGreaterThan(0);
  });

  it('hour angle is in (-180, 180] and outputs never NaN at poles/zenith/wrapped longitudes', () => {
    const t = new Date('2026-06-21T12:00:00Z');
    for (const lat of [90, -90, 89.99999, 0]) {
      for (const lon of [-540, -180, 0, 180, 540, 1234.5]) {
        const a = sunAltAz(t, lat, lon);
        expect(Number.isFinite(a.altitudeDeg)).toBe(true);
        expect(Number.isFinite(a.azimuthDeg)).toBe(true);
        expect(a.azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(a.azimuthDeg).toBeLessThan(360);
        expect(a.hourAngleDeg).toBeGreaterThan(-180);
        expect(a.hourAngleDeg).toBeLessThanOrEqual(180);
      }
    }
  });

  it('at the poles the Sun altitude ~ declination (N) / -declination (S)', () => {
    const t = new Date('2026-06-21T00:00:00Z');
    const decl = sunPosition(t).declinationDeg;
    expect(sunAltAz(t, 90, 0).altitudeDeg).toBeCloseTo(decl, 1);
    expect(sunAltAz(t, -90, 0).altitudeDeg).toBeCloseTo(-decl, 1);
  });

  it('exact zenith does not divide by zero', () => {
    const t = new Date('2026-03-20T12:00:00Z');
    const p = sunPosition(t);
    // Place the observer exactly under the Sun: lat = decl, hour angle 0.
    const lon = p.rightAscensionDeg - p.gmstDeg;
    const a = sunAltAz(t, p.declinationDeg, lon);
    expect(Number.isFinite(a.azimuthDeg)).toBe(true);
    expect(a.altitudeDeg).toBeGreaterThan(89.999);
  });
});

describe('horizonDipDeg', () => {
  it('~3.64 deg at 11000 m, 0 at sea level', () => {
    expect(horizonDipDeg(11000)).toBeCloseTo(3.64, 2);
    expect(horizonDipDeg(0)).toBe(0);
    expect(horizonDipDeg(100)).toBeCloseTo(0.347, 3);
  });
  it('returns 0 for NaN, negative and infinite elevations', () => {
    expect(horizonDipDeg(NaN)).toBe(0);
    expect(horizonDipDeg(-400)).toBe(0);
    expect(horizonDipDeg(-Infinity)).toBe(0);
    expect(horizonDipDeg(Infinity)).toBe(0);
  });
});
