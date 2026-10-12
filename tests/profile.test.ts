import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, profileAt } from '../src/flight/profile';

function sweep(block: number, fromE = 0, toE = 0, cfg = {}, step = 0.25) {
  const out = [];
  for (let t = 0; t <= block + 1e-9; t += step) out.push({ t, ...profileAt(t, block, fromE, toE, cfg) });
  return out;
}

describe('profileAt', () => {
  it('defaults match the spec', () => {
    expect(DEFAULT_PROFILE).toEqual({
      taxiOutMin: 15, climbMin: 22, descentMin: 28, taxiInMin: 8,
      cruiseAltitudeM: 11000, climbSpeedFactor: 0.6, descentSpeedFactor: 0.6,
    });
  });

  it('endpoints on a long leg', () => {
    const block = 600;
    const s = profileAt(0, block, 30, 5);
    expect(s).toEqual({ distanceFraction: 0, altitudeM: 30, phase: 'taxi' });
    const e = profileAt(block, block, 30, 5);
    expect(e.distanceFraction).toBe(1);
    expect(e.altitudeM).toBe(5);
    expect(e.phase).toBe('taxi');
  });

  it('phases occur in order with correct boundaries', () => {
    const block = 600;
    expect(profileAt(14.9, block, 0, 0).phase).toBe('taxi');
    expect(profileAt(15.1, block, 0, 0).phase).toBe('climb');
    expect(profileAt(37.1, block, 0, 0).phase).toBe('cruise');
    expect(profileAt(block - 8 - 27.9, block, 0, 0).phase).toBe('descent');
    expect(profileAt(block - 7.9, block, 0, 0).phase).toBe('taxi');
    const runs: string[] = [];
    for (const p of sweep(block)) if (runs[runs.length - 1] !== p.phase) runs.push(p.phase);
    expect(runs).toEqual(['taxi', 'climb', 'cruise', 'descent', 'taxi']);
  });

  it('is monotonic non-decreasing in distance and reaches exactly 1 at taxi-in start', () => {
    for (const block of [600, 120, 73, 45, 10, 1, 0.5]) {
      let prev = -1;
      for (const p of sweep(block, 10, 300, {}, block / 400)) {
        expect(p.distanceFraction).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(p.distanceFraction).toBeGreaterThanOrEqual(0);
        expect(p.distanceFraction).toBeLessThanOrEqual(1);
        prev = p.distanceFraction;
      }
    }
    const block = 600;
    expect(profileAt(block - 8, block, 0, 0).distanceFraction).toBe(1);
    expect(profileAt(block - 8 - 0.01, block, 0, 0).distanceFraction).toBeLessThan(1);
    expect(profileAt(block - 8 - 0.01, block, 0, 0).distanceFraction).toBeGreaterThan(0.999);
  });

  it('cruise speed exceeds climb/descent average speed by 1/0.6', () => {
    const block = 600;
    // 10 minutes in cruise vs. the same time in climb
    const dc = profileAt(100, block, 0, 0).distanceFraction - profileAt(90, block, 0, 0).distanceFraction;
    const dClimb = profileAt(25, block, 0, 0).distanceFraction - profileAt(15, block, 0, 0).distanceFraction;
    expect(dClimb / dc).toBeCloseTo(0.6, 6);
  });

  it('altitudes never negative for elevations >= 0 and never exceed cruise', () => {
    for (const block of [600, 120, 60, 45, 20, 5]) {
      for (const [f, t] of [[0, 0], [10, 2200], [1600, 5]] as [number, number][]) {
        for (const p of sweep(block, f, t, {}, block / 300)) {
          expect(p.altitudeM).toBeGreaterThanOrEqual(0);
          expect(p.altitudeM).toBeLessThanOrEqual(Math.max(11000, f, t));
          expect(Number.isFinite(p.altitudeM)).toBe(true);
        }
      }
    }
  });

  it('reaches cruise altitude on a long leg and is continuous (smooth)', () => {
    const pts = sweep(600, 0, 0, {}, 0.1);
    expect(Math.max(...pts.map((p) => p.altitudeM))).toBeCloseTo(11000, 6);
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i].altitudeM - pts[i - 1].altitudeM)).toBeLessThan(80);
  });

  it('honours custom cruise altitude', () => {
    const pts = sweep(600, 0, 0, { cruiseAltitudeM: 9000 });
    expect(Math.max(...pts.map((p) => p.altitudeM))).toBeCloseTo(9000, 6);
  });

  it('short 45 min leg: scaled phases, lowered cruise altitude, valid throughout', () => {
    const pts = sweep(45, 0, 0, {}, 0.05);
    const peak = Math.max(...pts.map((p) => p.altitudeM));
    expect(peak).toBeLessThanOrEqual(3000 + 25 * 45 + 1e-6);
    expect(peak).toBeGreaterThan(2000);
    expect(pts[pts.length - 1].distanceFraction).toBe(1);
    expect(pts[0].distanceFraction).toBe(0);
    // taxi-out is scaled: 15 * 45/73 ≈ 9.2 min
    expect(profileAt(9, 45, 0, 0).phase).toBe('taxi');
    expect(profileAt(9.5, 45, 0, 0).phase).toBe('climb');
    // Descent begins before the end and taxi-in is scaled too.
    expect(profileAt(45 - 8, 45, 0, 0).phase).toBe('descent');
  });

  it('blockMin <= 0 → no division by zero', () => {
    expect(profileAt(0, 0, 10, 20)).toEqual({ distanceFraction: 0, altitudeM: 10, phase: 'ground' });
    expect(profileAt(5, 0, 10, 20)).toEqual({ distanceFraction: 1, altitudeM: 20, phase: 'ground' });
    expect(profileAt(-5, 0, 10, 20).distanceFraction).toBe(0);
    expect(profileAt(5, -10, 10, 20).distanceFraction).toBe(1);
    expect(profileAt(0, -10, 10, 20).distanceFraction).toBe(0);
    expect(profileAt(NaN, NaN, 0, 0).distanceFraction).toBe(0);
  });

  it('negative elapsed → still on the ground at origin; beyond block → at destination', () => {
    expect(profileAt(-30, 300, 12, 40)).toEqual({ distanceFraction: 0, altitudeM: 12, phase: 'ground' });
    expect(profileAt(1e6, 300, 12, 40)).toEqual({ distanceFraction: 1, altitudeM: 40, phase: 'ground' });
    expect(profileAt(NaN, 300, 12, 40).distanceFraction).toBe(0);
  });

  it('is robust to odd configs (zero durations, zero speed factors)', () => {
    const cfg = { taxiOutMin: 0, climbMin: 0, descentMin: 0, taxiInMin: 0 };
    for (const p of sweep(100, 0, 0, cfg)) {
      expect(Number.isFinite(p.distanceFraction) && Number.isFinite(p.altitudeM)).toBe(true);
    }
    const z = sweep(100, 0, 0, { climbSpeedFactor: 0, descentSpeedFactor: 0 });
    let prev = 0;
    for (const p of z) { expect(p.distanceFraction).toBeGreaterThanOrEqual(prev); prev = p.distanceFraction; }
    const lin = sweep(100, 0, 0, { climbSpeedFactor: 0, descentSpeedFactor: 0, climbMin: 0, descentMin: 0, taxiOutMin: 0, taxiInMin: 0 });
    for (const p of lin) expect(Number.isFinite(p.distanceFraction)).toBe(true);
  });

  it('negative airport elevation (below sea level) stays finite and below cruise', () => {
    for (const p of sweep(300, -28, -28)) {
      expect(Number.isFinite(p.altitudeM)).toBe(true);
      expect(p.altitudeM).toBeLessThanOrEqual(11000);
    }
  });

  it('high airport above lowered cruise altitude never dips below its own elevation', () => {
    for (const p of sweep(30, 4000, 4000, {}, 0.1)) expect(p.altitudeM).toBeGreaterThanOrEqual(4000 - 1e-9);
  });
});
