import { describe, expect, it } from 'vitest';
import { buildJourney, legRoute, validateLegs, type AirportResolver } from '../src/flight/journey';
import { haversineKm } from '../src/geo/geodesy';
import type { Airport, FlightLeg, TrackPoint } from '../src/types';

const AP: Airport[] = [
  { iata: 'KHI', name: 'Jinnah Intl', city: 'Karachi', country: 'PK', lat: 24.9065, lon: 67.1608, elevationM: 30, tz: 'Asia/Karachi' },
  { iata: 'DXB', name: 'Dubai Intl', city: 'Dubai', country: 'AE', lat: 25.2528, lon: 55.3644, elevationM: 19, tz: 'Asia/Dubai' },
  { iata: 'DOH', name: 'Hamad Intl', city: 'Doha', country: 'QA', lat: 25.2731, lon: 51.6081, elevationM: 4, tz: 'Asia/Qatar' },
  { iata: 'LHR', name: 'Heathrow', city: 'London', country: 'GB', lat: 51.47, lon: -0.4543, elevationM: 25, tz: 'Europe/London' },
  { iata: 'SFO', name: 'San Francisco Intl', city: 'San Francisco', country: 'US', lat: 37.6189, lon: -122.375, elevationM: 4, tz: 'America/Los_Angeles' },
  { iata: 'JFK', name: 'John F Kennedy Intl', city: 'New York', country: 'US', lat: 40.6398, lon: -73.7789, elevationM: 4, tz: 'America/New_York' },
  { iata: 'AKL', name: 'Auckland', city: 'Auckland', country: 'NZ', lat: -37.0082, lon: 174.785, elevationM: 7, tz: 'Pacific/Auckland' },
  { iata: 'LAX', name: 'Los Angeles Intl', city: 'Los Angeles', country: 'US', lat: 33.9425, lon: -118.4081, elevationM: 38, tz: 'America/Los_Angeles' },
  { iata: 'HKG', name: 'Hong Kong Intl', city: 'Hong Kong', country: 'HK', lat: 22.308, lon: 113.9185, elevationM: 9, tz: 'Asia/Hong_Kong' },
  { iata: 'SYD', name: 'Kingsford Smith', city: 'Sydney', country: 'AU', lat: -33.9461, lon: 151.1772, elevationM: 6, tz: 'Australia/Sydney' },
];
const resolve: AirportResolver = (c) => AP.find((a) => a.iata === c);
const ap = (c: string) => resolve(c)!;

const Z = (s: string) => new Date(s);
let n = 0;
const leg = (from: string, to: string, dep: string, arr: string, extra: Partial<FlightLeg> = {}): FlightLeg => ({
  id: `L${++n}`, from, to, departureUtc: Z(dep), arrivalUtc: Z(arr), ...extra,
});

// KHI→DXB→LHR→SFO with layovers of 3 h and 4 h.
const itinerary = (): FlightLeg[] => [
  leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { flightNumber: 'EK607' }),
  leg('DXB', 'LHR', '2026-10-12T21:40:00Z', '2026-10-13T05:10:00Z', { flightNumber: 'EK1' }),
  leg('LHR', 'SFO', '2026-10-13T09:10:00Z', '2026-10-13T20:20:00Z', { flightNumber: 'EK226' }),
];

describe('validateLegs', () => {
  it('accepts a good itinerary (no errors, no warnings)', () => {
    const r = validateLegs(itinerary(), resolve);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('error: no legs', () => {
    expect(validateLegs([], resolve).errors.length).toBe(1);
  });

  it('error: unknown airport', () => {
    const r = validateLegs([leg('KHI', 'ZZZ', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z')], resolve);
    expect(r.errors.some((e) => e.includes('ZZZ'))).toBe(true);
  });

  it('error: invalid dates', () => {
    const l = leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z');
    l.arrivalUtc = new Date('nope');
    const r = validateLegs([l], resolve);
    expect(r.errors.some((e) => /invalid/i.test(e))).toBe(true);
  });

  it('error: arrival before / equal to departure', () => {
    expect(validateLegs([leg('KHI', 'DXB', '2026-10-12T18:40:00Z', '2026-10-12T16:30:00Z')], resolve).errors.some((e) => /not after/.test(e))).toBe(true);
    expect(validateLegs([leg('KHI', 'DXB', '2026-10-12T18:40:00Z', '2026-10-12T18:40:00Z')], resolve).errors.some((e) => /not after/.test(e))).toBe(true);
  });

  it('error: overlapping legs (order independent)', () => {
    const a = leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z');
    const b = leg('DXB', 'LHR', '2026-10-12T18:00:00Z', '2026-10-13T01:30:00Z');
    expect(validateLegs([a, b], resolve).errors.some((e) => /overlap/.test(e))).toBe(true);
    expect(validateLegs([b, a], resolve).errors.some((e) => /overlap/.test(e))).toBe(true);
  });

  it('error: block time > 22 h', () => {
    const r = validateLegs([leg('SFO', 'AKL', '2026-10-12T00:00:00Z', '2026-10-13T00:00:00Z')], resolve);
    expect(r.errors.some((e) => /22 h/.test(e))).toBe(true);
  });

  it('warning: connection airport mismatch', () => {
    const r = validateLegs([
      leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z'),
      leg('DOH', 'LHR', '2026-10-12T21:40:00Z', '2026-10-13T05:10:00Z'),
    ], resolve);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /mismatch/.test(w))).toBe(true);
  });

  it('warning: same from/to', () => {
    const r = validateLegs([leg('KHI', 'KHI', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z')], resolve);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /same/.test(w))).toBe(true);
  });

  it('warning: layover > 48 h', () => {
    const r = validateLegs([
      leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z'),
      leg('DXB', 'LHR', '2026-10-15T21:40:00Z', '2026-10-16T05:10:00Z'),
    ], resolve);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /48 h/.test(w))).toBe(true);
  });

  it('warning: implied speed too fast / too slow', () => {
    const fast = validateLegs([leg('KHI', 'LHR', '2026-10-12T16:30:00Z', '2026-10-12T18:30:00Z')], resolve);
    expect(fast.warnings.some((w) => /faster/.test(w))).toBe(true);
    const slow = validateLegs([leg('KHI', 'DXB', '2026-10-12T10:00:00Z', '2026-10-12T20:00:00Z')], resolve);
    expect(slow.warnings.some((w) => /slow/.test(w))).toBe(true);
  });
});

describe('legRoute', () => {
  it('great-circle leg, waypoints and imported track', () => {
    const a = leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z');
    expect(legRoute(a, resolve)).toEqual([{ lat: 24.9065, lon: 67.1608 }, { lat: 25.2528, lon: 55.3644 }]);
    const w = leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { waypoints: [{ lat: 25, lon: 60 }] });
    expect(legRoute(w, resolve)).toHaveLength(3);
    const t = leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] });
    expect(legRoute(t, resolve)).toEqual([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  });
  it('throws on unknown airport', () => {
    expect(() => legRoute(leg('KHI', 'ZZZ', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z'), resolve)).toThrow(/ZZZ/);
  });
});

describe('buildJourney', () => {
  it('throws a clear error for invalid itineraries', () => {
    expect(() => buildJourney([], resolve)).toThrow(/Invalid itinerary/);
    expect(() => buildJourney([leg('KHI', 'ZZZ', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z')], resolve)).toThrow(/unknown airport/);
    expect(() => buildJourney([leg('KHI', 'DXB', '2026-10-12T18:40:00Z', '2026-10-12T16:30:00Z')], resolve)).toThrow(/not after/);
  });

  it('sorts legs by departure and sets start/end', () => {
    const j = buildJourney(itinerary().reverse(), resolve);
    expect(j.legs.map((l) => l.from)).toEqual(['KHI', 'DXB', 'LHR']);
    expect(j.start.toISOString()).toBe('2026-10-12T16:30:00.000Z');
    expect(j.end.toISOString()).toBe('2026-10-13T20:20:00.000Z');
  });

  describe('KHI→DXB→LHR→SFO', () => {
    const j = buildJourney(itinerary(), resolve);

    it('before departure: on the ground at the origin', () => {
      const s = j.stateAt(Z('2026-10-12T10:00:00Z'));
      expect(s).toMatchObject({ lat: ap('KHI').lat, lon: ap('KHI').lon, onGround: true, airport: 'KHI', phase: 'ground', legIndex: 0, altitudeM: 30 });
      expect(s.time.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    });

    it('during taxi-out the aircraft is on the ground at the origin', () => {
      const s = j.stateAt(Z('2026-10-12T16:40:00Z'));
      expect(s).toMatchObject({ onGround: true, airport: 'KHI', phase: 'taxi', legIndex: 0 });
    });

    it('in cruise: airborne, high, with a heading', () => {
      const s = j.stateAt(Z('2026-10-13T00:00:00Z')); // mid DXB→LHR
      expect(s.legIndex).toBe(1);
      expect(s.phase).toBe('cruise');
      expect(s.onGround).toBe(false);
      expect(s.altitudeM).toBeCloseTo(11000, 3);
      expect(s.airport).toBeUndefined();
      expect(s.headingDeg).toBeGreaterThan(0);
      expect(s.headingDeg).toBeLessThan(360);
      // Roughly on the DXB–LHR great circle: distance via the point ≈ direct distance.
      const direct = haversineKm(ap('DXB'), ap('LHR'));
      expect(haversineKm(ap('DXB'), s) + haversineKm(s, ap('LHR'))).toBeCloseTo(direct, 0);
    });

    it('layover 1 (DXB): on the ground at the connecting airport', () => {
      const s = j.stateAt(Z('2026-10-12T20:00:00Z'));
      expect(s).toMatchObject({ lat: ap('DXB').lat, lon: ap('DXB').lon, onGround: true, airport: 'DXB', phase: 'ground', legIndex: 0, altitudeM: 19, headingDeg: 0 });
    });

    it('layover 2 (LHR): legIndex is the leg just completed', () => {
      const s = j.stateAt(Z('2026-10-13T07:00:00Z'));
      expect(s).toMatchObject({ onGround: true, airport: 'LHR', phase: 'ground', legIndex: 1, altitudeM: 25 });
    });

    it('layover boundaries: arrival instant is ground at destination; departure instant starts the next leg', () => {
      const arr = j.stateAt(Z('2026-10-12T18:40:00Z'));
      expect(arr).toMatchObject({ airport: 'DXB', onGround: true, legIndex: 0 });
      const dep = j.stateAt(Z('2026-10-12T21:40:00Z'));
      expect(dep).toMatchObject({ airport: 'DXB', onGround: true, legIndex: 1, phase: 'taxi' });
    });

    it('after the end (and exactly at it): at the final destination', () => {
      for (const t of ['2026-10-13T20:20:00Z', '2026-10-14T05:00:00Z']) {
        const s = j.stateAt(Z(t));
        expect(s).toMatchObject({ lat: ap('SFO').lat, lon: ap('SFO').lon, onGround: true, airport: 'SFO', legIndex: 2, altitudeM: 4 });
      }
    });

    it('during taxi-in the aircraft is at the destination airport', () => {
      const s = j.stateAt(Z('2026-10-12T18:35:00Z'));
      expect(s).toMatchObject({ onGround: true, airport: 'DXB', phase: 'taxi', legIndex: 0 });
    });

    it('invalid Date input does not blow up', () => {
      const s = j.stateAt(new Date(NaN));
      expect(Number.isFinite(s.lat)).toBe(true);
    });

    it('minute sweep across the whole journey: no NaN, valid ranges, continuity', () => {
      let prev = j.stateAt(j.start);
      const total = (j.end.getTime() - j.start.getTime()) / 60000;
      let maxStepKm = 0;
      for (let m = -120; m <= total + 120; m++) {
        const s = j.stateAt(new Date(j.start.getTime() + m * 60000));
        expect(Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.altitudeM) && Number.isFinite(s.headingDeg)).toBe(true);
        expect(s.lat).toBeGreaterThanOrEqual(-90);
        expect(s.lat).toBeLessThanOrEqual(90);
        expect(s.lon).toBeGreaterThanOrEqual(-180);
        expect(s.lon).toBeLessThan(180);
        expect(s.headingDeg).toBeGreaterThanOrEqual(0);
        expect(s.headingDeg).toBeLessThan(360);
        expect(s.altitudeM).toBeGreaterThanOrEqual(0);
        expect(s.altitudeM).toBeLessThanOrEqual(11000 + 1e-6);
        expect(s.onGround).toBe(s.airport !== undefined);
        if (s.phase === 'climb' || s.phase === 'cruise' || s.phase === 'descent') expect(s.onGround).toBe(false);
        maxStepKm = Math.max(maxStepKm, haversineKm(prev, s));
        prev = s;
      }
      // 11 km/min at ~Mach 0.85 ≈ 14 km/min; ground phases are 0.
      expect(maxStepKm).toBeLessThan(16);
    });
  });

  it('antimeridian leg SFO→AKL: continuous, wraps lon, heading westward then south-westerly', () => {
    const j = buildJourney([leg('SFO', 'AKL', '2026-10-12T04:00:00Z', '2026-10-12T17:00:00Z')], resolve);
    const total = 13 * 60;
    let prev = j.stateAt(j.start);
    let wrapped = false;
    for (let m = 0; m <= total; m++) {
      const s = j.stateAt(new Date(j.start.getTime() + m * 60000));
      expect(Number.isFinite(s.lat + s.lon + s.altitudeM + s.headingDeg)).toBe(true);
      expect(haversineKm(prev, s)).toBeLessThan(16);
      if (Math.abs(s.lon - prev.lon) > 180) wrapped = true;
      prev = s;
    }
    expect(wrapped).toBe(true);
    const mid = j.stateAt(new Date(j.start.getTime() + 6.5 * 60 * 60000));
    expect(mid.headingDeg).toBeGreaterThan(180); // south-west quadrant
    expect(mid.headingDeg).toBeLessThan(300);
  });

  it('polar JFK→HKG: no NaN and heading stays defined near the pole', () => {
    const j = buildJourney([leg('JFK', 'HKG', '2026-07-01T00:00:00Z', '2026-07-01T16:00:00Z')], resolve);
    let maxLat = -90;
    for (let m = 0; m <= 16 * 60; m++) {
      const s = j.stateAt(new Date(j.start.getTime() + m * 60000));
      expect(Number.isFinite(s.lat + s.lon + s.headingDeg + s.altitudeM)).toBe(true);
      maxLat = Math.max(maxLat, s.lat);
    }
    expect(maxLat).toBeGreaterThan(75);
  });

  it('LAX→SYD and a short 45 min hop work too', () => {
    const j1 = buildJourney([leg('LAX', 'SYD', '2026-10-12T22:00:00Z', '2026-10-13T12:30:00Z')], resolve);
    for (let m = 0; m <= 14.5 * 60; m += 1) {
      const s = j1.stateAt(new Date(j1.start.getTime() + m * 60000));
      expect(Number.isFinite(s.lat + s.lon + s.altitudeM + s.headingDeg)).toBe(true);
    }
    const j2 = buildJourney([leg('DXB', 'DOH', '2026-10-12T10:00:00Z', '2026-10-12T10:45:00Z')], resolve);
    let peak = 0;
    for (let m = 0; m <= 45; m++) peak = Math.max(peak, j2.stateAt(new Date(j2.start.getTime() + m * 60000)).altitudeM);
    expect(peak).toBeLessThan(4200);
    expect(peak).toBeGreaterThan(1000);
  });

  it('honours leg cruise altitude and profile overrides', () => {
    const j = buildJourney([leg('KHI', 'LHR', '2026-10-12T00:00:00Z', '2026-10-12T09:00:00Z', { cruiseAltitudeM: 9500 })], resolve, { taxiOutMin: 5 });
    const mid = j.stateAt(new Date(j.start.getTime() + 4.5 * 3600000));
    expect(mid.altitudeM).toBeCloseTo(9500, 3);
    expect(j.stateAt(new Date(j.start.getTime() + 6 * 60000)).onGround).toBe(false); // taxi-out is only 5 min
  });

  it('waypoints are followed', () => {
    const wp: TrackPoint = { lat: 60, lon: 30 };
    const j = buildJourney([leg('KHI', 'LHR', '2026-10-12T00:00:00Z', '2026-10-12T09:00:00Z', { waypoints: [wp] })], resolve);
    let best = Infinity;
    for (let m = 0; m <= 540; m++) best = Math.min(best, haversineKm(j.stateAt(new Date(j.start.getTime() + m * 60000)), wp));
    expect(best).toBeLessThan(15);
  });

  describe('imported tracks', () => {
    const base = Date.parse('2026-10-12T16:30:00Z');
    const mkTrack = (withTimes: boolean, withAlt = true): TrackPoint[] => [
      { lat: 24.9065, lon: 67.1608, altitudeM: 30 },
      { lat: 25.0, lon: 64.0, altitudeM: 5000 },
      { lat: 25.1, lon: 60.0, altitudeM: 10000 },
      { lat: 25.2528, lon: 55.3644, altitudeM: 19 },
    ].map((p, i) => ({
      lat: p.lat, lon: p.lon,
      ...(withAlt ? { altitudeM: p.altitudeM } : {}),
      ...(withTimes ? { time: new Date(base + (20 + i * 30) * 60000) } : {}),
    }));

    it('timed track: interpolates position and altitude by time', () => {
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: mkTrack(true) })], resolve);
      // Halfway between points 0 (t+20) and 1 (t+50) → t+35 min
      const s = j.stateAt(new Date(base + 35 * 60000));
      expect(s.onGround).toBe(false);
      expect(s.altitudeM).toBeCloseTo(2515, 3);
      expect(s.lat).toBeGreaterThan(24.9);
      expect(s.lon).toBeLessThan(67.16);
      expect(s.lon).toBeGreaterThan(64);
      expect(haversineKm(s, { lat: 24.9065, lon: 67.1608 }) + haversineKm(s, { lat: 25.0, lon: 64.0 })).toBeCloseTo(haversineKm({ lat: 24.9065, lon: 67.1608 }, { lat: 25.0, lon: 64.0 }), 1);
      expect(s.headingDeg).toBeGreaterThan(250);
      expect(s.headingDeg).toBeLessThan(290);
      // Exactly on a track point
      const p2 = j.stateAt(new Date(base + 80 * 60000));
      expect(p2.lat).toBeCloseTo(25.1, 6);
      expect(p2.lon).toBeCloseTo(60, 6);
      expect(p2.altitudeM).toBeCloseTo(10000, 6);
      // Before first track time / after last: on the ground at the airports
      expect(j.stateAt(new Date(base + 5 * 60000))).toMatchObject({ onGround: true, airport: 'KHI' });
      expect(j.stateAt(new Date(base + 125 * 60000))).toMatchObject({ onGround: true, airport: 'DXB' });
    });

    it('timed track without altitudes falls back to the profile altitude', () => {
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: mkTrack(true, false) })], resolve);
      const s = j.stateAt(new Date(base + 60 * 60000));
      expect(Number.isFinite(s.altitudeM)).toBe(true);
      expect(s.altitudeM).toBeGreaterThan(500);
    });

    it('timed track unsorted input and clock far from the leg (re-anchored to departure)', () => {
      const shifted = mkTrack(true).map((p) => ({ ...p, time: new Date(p.time!.getTime() - 365 * 86400000) })).reverse();
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: shifted })], resolve);
      // Anchored so the first point is at departure: the third point is 60 min later.
      const mid = j.stateAt(new Date(base + 60 * 60000));
      expect(mid.lat).toBeCloseTo(25.1, 6);
      expect(mid.onGround).toBe(false);
    });

    it('untimed track: follows the geometry with profile timing and uses track altitudes', () => {
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: mkTrack(false) })], resolve);
      for (let m = 0; m <= 130; m++) {
        const s = j.stateAt(new Date(base + m * 60000));
        expect(Number.isFinite(s.lat + s.lon + s.altitudeM + s.headingDeg)).toBe(true);
        if (!s.onGround) {
          // Track altitudes (max 10 000 m) are used instead of the 11 000 m profile cruise.
          expect(s.altitudeM).toBeLessThanOrEqual(10000 + 1e-6);
        }
      }
      const mid = j.stateAt(new Date(base + 65 * 60000));
      expect(mid.onGround).toBe(false);
      expect(mid.lon).toBeLessThan(67.16);
      expect(mid.lon).toBeGreaterThan(55.36);
    });

    it('untimed track without altitudes uses the profile altitude', () => {
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: mkTrack(false, false) })], resolve, {});
      let peak = 0;
      for (let m = 0; m <= 130; m++) peak = Math.max(peak, j.stateAt(new Date(base + m * 60000)).altitudeM);
      expect(peak).toBeGreaterThan(5000);
    });

    it('single-point track is ignored (falls back to the great circle)', () => {
      const j = buildJourney([leg('KHI', 'DXB', '2026-10-12T16:30:00Z', '2026-10-12T18:40:00Z', { track: [{ lat: 1, lon: 1 }] })], resolve);
      const s = j.stateAt(new Date(base + 65 * 60000));
      expect(s.lat).toBeGreaterThan(24);
    });
  });

  it('performance: ~50k stateAt calls complete quickly', () => {
    const j = buildJourney(itinerary(), resolve);
    const t0 = Date.now();
    let acc = 0;
    const total = j.end.getTime() - j.start.getTime();
    for (let i = 0; i < 50000; i++) acc += j.stateAt(new Date(j.start.getTime() + (total * i) / 50000)).lat;
    expect(Number.isFinite(acc)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
