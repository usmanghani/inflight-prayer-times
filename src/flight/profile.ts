import type { FlightPhase } from '../types';

export interface ProfileConfig {
  taxiOutMin: number;
  climbMin: number;
  descentMin: number;
  taxiInMin: number;
  cruiseAltitudeM: number;
  /** Average ground speed during climb as a fraction of cruise speed. */
  climbSpeedFactor: number;
  /** Average ground speed during descent as a fraction of cruise speed. */
  descentSpeedFactor: number;
}

export const DEFAULT_PROFILE: ProfileConfig = {
  taxiOutMin: 15,
  climbMin: 22,
  descentMin: 28,
  taxiInMin: 8,
  cruiseAltitudeM: 11000,
  climbSpeedFactor: 0.6,
  descentSpeedFactor: 0.6,
};

function num(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Where is the aircraft `elapsedMin` minutes after block-out on a leg of `blockMin` minutes?
 * Returns the fraction of route distance covered (0..1), altitude (m AMSL) and phase.
 * Taxi covers no route distance; distanceFraction reaches exactly 1 when taxi-in starts.
 */
export function profileAt(
  elapsedMin: number,
  blockMin: number,
  fromElevM: number,
  toElevM: number,
  cfg?: Partial<ProfileConfig>,
): { distanceFraction: number; altitudeM: number; phase: FlightPhase } {
  const c: ProfileConfig = { ...DEFAULT_PROFILE, ...(cfg ?? {}) };
  const fromE = num(fromElevM, 0);
  const toE = num(toElevM, 0);
  const el = Number.isFinite(elapsedMin) ? elapsedMin : 0;
  const block = Number.isFinite(blockMin) ? blockMin : 0;

  // Degenerate block time: no time to fly anything (avoids division by zero below).
  if (block <= 0) {
    return el <= 0
      ? { distanceFraction: 0, altitudeM: fromE, phase: 'ground' }
      : { distanceFraction: 1, altitudeM: toE, phase: 'ground' };
  }
  if (el < 0) return { distanceFraction: 0, altitudeM: fromE, phase: 'ground' };
  if (el > block) return { distanceFraction: 1, altitudeM: toE, phase: 'ground' };

  let taxiOut = Math.max(0, num(c.taxiOutMin, 0));
  let climb = Math.max(0, num(c.climbMin, 0));
  let descent = Math.max(0, num(c.descentMin, 0));
  let taxiIn = Math.max(0, num(c.taxiInMin, 0));
  let cruiseAlt = num(c.cruiseAltitudeM, DEFAULT_PROFILE.cruiseAltitudeM);

  // Short flights: scale all phases to fit and cap the cruise altitude.
  const fixed = taxiOut + climb + descent + taxiIn;
  if (fixed > block) {
    const s = block / fixed; // fixed > block > 0
    taxiOut *= s; climb *= s; descent *= s; taxiIn *= s;
    cruiseAlt = Math.min(cruiseAlt, 3000 + 25 * block);
  }
  const cruise = Math.max(0, block - taxiOut - climb - descent - taxiIn);
  // Never "climb" downhill if an airport sits above the (possibly lowered) cruise altitude.
  const peak = Math.max(cruiseAlt, fromE, toE);

  const t1 = taxiOut, t2 = t1 + climb, t3 = t2 + cruise, t4 = t3 + descent;

  // Route distance: cruise at speed v, climb/descent at factor*v; total distance is 1.
  const cf = Math.max(0, num(c.climbSpeedFactor, 0.6));
  const df = Math.max(0, num(c.descentSpeedFactor, 0.6));
  const denom = cf * climb + cruise + df * descent; // distance-in-cruise-minutes
  const airborne = t4 - t1;
  const frac = (x: number): number => {
    if (denom > 0) return Math.max(0, Math.min(1, x / denom));
    return airborne > 0 ? Math.max(0, Math.min(1, (el - t1) / airborne)) : 1; // all-zero factors: linear in time
  };

  if (el < t1) return { distanceFraction: 0, altitudeM: fromE, phase: 'taxi' };
  if (el < t2) {
    const u = climb > 0 ? (el - t1) / climb : 1;
    return { distanceFraction: frac(cf * (el - t1)), altitudeM: fromE + (peak - fromE) * smoothstep(u), phase: 'climb' };
  }
  if (el < t3) {
    return { distanceFraction: frac(cf * climb + (el - t2)), altitudeM: peak, phase: 'cruise' };
  }
  if (el < t4) {
    const u = descent > 0 ? (el - t3) / descent : 1;
    return {
      distanceFraction: frac(cf * climb + cruise + df * (el - t3)),
      altitudeM: peak + (toE - peak) * smoothstep(u),
      phase: 'descent',
    };
  }
  return { distanceFraction: 1, altitudeM: toE, phase: 'taxi' };
}
