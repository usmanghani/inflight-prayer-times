import { describe, expect, it } from 'vitest';
import { computeInflight, formatLatLon } from '../src/prayer/inflight';
import { prayerTasks, windowTimeline } from '../src/prayer/summary';
import { computeStaticTimes, windowAt } from '../src/prayer/static';
import { DEFAULT_SETTINGS, METHODS } from '../src/prayer/methods';
import { buildJourney } from '../src/flight/journey';
import { resolveAirport } from '../src/data/airports';
import type {
  AircraftState,
  FlightLeg,
  InflightResult,
  Journey,
  PrayerName,
  PrayerSettings,
  PrayerWindow,
} from '../src/types';

const Z = (s: string) => new Date(s);
const HOUR = 3_600_000;
const NAMES: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

let legNo = 0;
const leg = (from: string, to: string, dep: string, arr: string): FlightLeg => ({
  id: `T${++legNo}`, from, to, departureUtc: Z(dep), arrivalUtc: Z(arr),
});
const journeyOf = (...legs: FlightLeg[]) => buildJourney(legs, resolveAirport);

/** A "journey" that sits still: handy for comparing with static prayer times. */
function stationary(
  lat: number, lon: number, start: string, hours: number,
  o: { altitudeM?: number; onGround?: boolean } = {},
): Journey {
  const s = Z(start);
  const e = new Date(s.getTime() + hours * HOUR);
  const onGround = o.onGround ?? true;
  return {
    legs: [], start: s, end: e,
    stateAt(t: Date): AircraftState {
      return {
        time: t, lat, lon, altitudeM: o.altitudeM ?? 0, headingDeg: 0,
        phase: onGround ? 'ground' : 'cruise', legIndex: 0, onGround,
        ...(onGround ? { airport: 'XXX' } : {}),
      };
    },
  };
}

/** Constant-latitude flight along a parallel at a given ground speed (dir -1 = west). */
function parallel(lat: number, lon0: number, kmh: number, start: string, hours: number, dir: 1 | -1): Journey {
  const s = Z(start);
  const degPerH = kmh / (111.195 * Math.cos((lat * Math.PI) / 180));
  return {
    legs: [], start: s, end: new Date(s.getTime() + hours * HOUR),
    stateAt(t: Date): AircraftState {
      const h = Math.max(0, Math.min(hours, (t.getTime() - s.getTime()) / HOUR));
      const lon = ((lon0 + dir * degPerH * h + 540) % 360) - 180;
      return {
        time: t, lat, lon, altitudeM: 11000, headingDeg: dir < 0 ? 270 : 90,
        phase: 'cruise', legIndex: 0, onGround: false,
      };
    },
  };
}

const withMethod = (over: Partial<PrayerSettings>): PrayerSettings => ({ ...DEFAULT_SETTINGS, ...over });

function expectSane(r: InflightResult, j: Journey): void {
  const a = j.start.getTime(), b = j.end.getTime();
  expect(r.samples.length).toBeGreaterThan(0);
  for (const s of r.samples) {
    for (const v of [s.state.lat, s.state.lon, s.state.altitudeM, s.state.headingDeg, s.sunAltitudeDeg, s.sunAzimuthDeg, s.qiblaDeg, s.qiblaRelativeDeg]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(NAMES).toContain(s.window);
    expect(s.qiblaRelativeDeg).toBeGreaterThanOrEqual(-180);
    expect(s.qiblaRelativeDeg).toBeLessThanOrEqual(180);
    expect(typeof s.tz).toBe('string');
  }
  let prev = -Infinity;
  for (const e of r.events) {
    const t = e.time.getTime();
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(prev);
    expect(t).toBeGreaterThanOrEqual(a);
    expect(t).toBeLessThanOrEqual(b);
    expect(NAMES).toContain(e.prayer);
    expect(Number.isFinite(e.state.lat) && Number.isFinite(e.state.lon)).toBe(true);
    prev = t;
  }
  for (const an of r.anomalies) {
    expect(Number.isFinite(an.time.getTime())).toBe(true);
    expect(an.message.length).toBeGreaterThan(10);
    expect(an.message).not.toMatch(/NaN|undefined/);
  }
}

describe('computeInflight: stationary sanity', () => {
  it('on the ground at Karachi for 24 h reproduces the static prayer times (within 1 min)', () => {
    const lat = 24.8607, lon = 67.0011;
    const j = stationary(lat, lon, '2026-03-21T00:00:00Z', 24);
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expectSane(r, j);
    expect(r.events.length).toBeGreaterThanOrEqual(5);
    expect(r.events.length).toBeLessThanOrEqual(7);
    const statics = ['2026-03-20', '2026-03-21', '2026-03-22'].map((d) =>
      computeStaticTimes({ lat, lon, elevationM: 0 }, d, DEFAULT_SETTINGS),
    );
    for (const e of r.events) {
      const diffs = statics.map((st) => Math.abs((st[e.prayer].time as Date).getTime() - e.time.getTime()));
      expect(Math.min(...diffs)).toBeLessThanOrEqual(60_000);
      expect(e.anomaly).toBeUndefined();
    }
    // window sequence follows the cycle with no anomalies
    expect(r.anomalies.filter((a) => a.kind === 'windowRepeated' || a.kind === 'windowSkipped')).toEqual([]);
    // samples every minute, exact end included
    expect(r.samples.length).toBe(24 * 60 + 1);
    expect(r.samples[0].state.time.getTime()).toBe(j.start.getTime());
    expect(r.samples[r.samples.length - 1].state.time.getTime()).toBe(j.end.getTime());
    expect(r.samples[0].tz).toBe('Asia/Karachi');
  });

  it('initialWindow matches windowAt at departure', () => {
    const j = stationary(51.47, -0.45, '2026-10-12T15:30:00Z', 2);
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expect(r.initialWindow).toBe(windowAt(j.start, { lat: 51.47, lon: -0.45, elevationM: 0 }, DEFAULT_SETTINGS).window);
  });
});

describe('computeInflight: long-haul flights', () => {
  it('westbound DXB→SFO: sensible, chronological, no NaN', () => {
    const j = journeyOf(leg('DXB', 'SFO', '2026-10-12T05:55:00Z', '2026-10-12T22:05:00Z'));
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expectSane(r, j);
    expect(r.events.length).toBeGreaterThanOrEqual(2);
    expect(r.events.length).toBeLessThanOrEqual(14);
    const tasks = prayerTasks(r, j);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((t) => t.inAir)).toBe(true);
  });

  it('eastbound SFO→DXB (Arctic routing): sensible, chronological, no NaN', () => {
    const j = journeyOf(leg('SFO', 'DXB', '2026-10-12T23:35:00Z', '2026-10-13T15:25:00Z'));
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expectSane(r, j);
    expect(r.events.length).toBeGreaterThanOrEqual(2);
    expect(r.events.length).toBeLessThanOrEqual(14);
    expect(Math.max(...r.samples.map((s) => Math.abs(s.state.lat)))).toBeGreaterThan(60);
  });

  it('multi-leg itinerary including a layover: ground samples sit still', () => {
    const j = journeyOf(
      leg('KHI', 'DXB', '2026-10-11T22:30:00Z', '2026-10-12T00:40:00Z'),
      leg('DXB', 'LHR', '2026-10-12T05:40:00Z', '2026-10-12T13:10:00Z'),
    );
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expectSane(r, j);
    const lay = r.samples.filter((s) => s.state.onGround && s.state.airport === 'DXB' && s.state.phase === 'ground');
    expect(lay.length).toBeGreaterThan(100);
    expect(new Set(lay.map((s) => s.state.lat.toFixed(4))).size).toBe(1);
    // events during the layover are reported as on the ground
    const tasks = prayerTasks(r, j);
    expect(tasks.some((t) => t.notes.some((n) => /on the ground at DXB/.test(n)))).toBe(true);
  });
});

describe('computeInflight: high latitude, anomalies, polar', () => {
  it('westbound faster than the sun at 65°N near the equinox: windowRepeated is reported', () => {
    const j = parallel(65, 0, 950, '2026-09-22T18:00:00Z', 10, -1);
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expectSane(r, j);
    const rep = r.anomalies.filter((a) => a.kind === 'windowRepeated');
    expect(rep.length).toBeGreaterThan(0);
    expect(rep[0].message).toMatch(/Flying west faster than the sun/);
    expect(rep[0].message).toMatch(/rise again/);
    expect(rep[0].message).toMatch(/remains valid/);
    expect(r.events.some((e) => e.anomaly === 'windowRepeated')).toBe(true);
    // and the same journey flown east produces no repeats
    const east = computeInflight(parallel(65, 0, 950, '2026-09-22T18:00:00Z', 10, 1), DEFAULT_SETTINGS);
    expect(east.anomalies.filter((a) => a.kind === 'windowRepeated')).toEqual([]);
  });

  it('synthetic 70°N westbound leg at 950 km/h in June does not crash and flags polar day', () => {
    for (const rule of ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude', 'none'] as const) {
      const j = parallel(70, 20, 950, '2026-06-21T06:00:00Z', 12, -1);
      const r = computeInflight(j, withMethod({ highLatitudeRule: rule }));
      expectSane(r, j);
      expect(r.anomalies.some((a) => a.kind === 'polarDay')).toBe(true);
    }
    // polar day is reported once per contiguous stretch
    const r = computeInflight(parallel(70, 20, 950, '2026-06-21T06:00:00Z', 12, -1), DEFAULT_SETTINGS);
    expect(r.anomalies.filter((a) => a.kind === 'polarDay').length).toBe(1);
  });

  it('LHR→SFO in June (Greenland/Canadian Arctic) is computed with high-latitude handling', () => {
    const j = journeyOf(leg('LHR', 'SFO', '2026-06-21T10:00:00Z', '2026-06-21T21:20:00Z'));
    for (const rule of ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude'] as const) {
      const r = computeInflight(j, withMethod({ highLatitudeRule: rule }));
      expectSane(r, j);
    }
  });

  it('does not lose a window shorter than the sampling step (2-min Maghrib at a 5-min step)', () => {
    // Umm al-Qura: Isha = Maghrib + 90 min; an Isha offset of -88 min makes the Maghrib window 2 min long.
    const s = withMethod({
      method: { ...METHODS.ummAlQura },
      offsets: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: -88 },
    });
    const j = stationary(52, 0, '2026-06-21T18:00:00Z', 6);
    const fine = computeInflight(j, s, { stepMinutes: 1 });
    const coarse = computeInflight(j, s, { stepMinutes: 5 });
    const fm = fine.events.find((e) => e.prayer === 'maghrib')!;
    const cm = coarse.events.find((e) => e.prayer === 'maghrib');
    const ci = coarse.events.find((e) => e.prayer === 'isha');
    expect(fm).toBeDefined();
    expect(cm).toBeDefined();
    expect(ci).toBeDefined();
    expect(Math.abs(cm!.time.getTime() - fm.time.getTime())).toBeLessThanOrEqual(2000);
    const dur = (ci!.time.getTime() - cm!.time.getTime()) / 60000;
    expect(dur).toBeGreaterThan(1.9);
    expect(dur).toBeLessThan(2.1);
    expect(coarse.anomalies.filter((a) => a.kind === 'windowSkipped')).toEqual([]);
    // the short window is surfaced to the UI
    const t = prayerTasks(coarse, j).find((x) => x.prayer === 'maghrib')!;
    expect(t.notes.some((n) => /shorter than 10 minutes/.test(n))).toBe(true);
  });

  it('reports windowSkipped when two windows open at the same instant', () => {
    // Isha offset pulls Isha exactly onto Maghrib: Maghrib never gets a window of its own.
    const s = withMethod({
      method: { ...METHODS.ummAlQura },
      offsets: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: -90 },
    });
    const j = stationary(30, 0, '2026-03-20T10:00:00Z', 10);
    const r = computeInflight(j, s);
    expectSane(r, j);
    const sk = r.anomalies.find((a) => a.kind === 'windowSkipped');
    expect(sk).toBeDefined();
    expect(sk!.message).toMatch(/Maghrib/);
  });

  it('antimeridian: SFO→AKL and LAX→SYD', () => {
    for (const [a, b, dep, arr] of [
      ['SFO', 'AKL', '2026-06-21T03:25:00Z', '2026-06-21T16:20:00Z'],
      ['LAX', 'SYD', '2026-06-21T05:35:00Z', '2026-06-21T19:30:00Z'],
    ] as const) {
      const j = journeyOf(leg(a, b, dep, arr));
      const r = computeInflight(j, DEFAULT_SETTINGS);
      expectSane(r, j);
      const lons = r.samples.map((s) => s.state.lon);
      expect(lons.some((x) => x > 170)).toBe(true);
      expect(lons.some((x) => x < -170)).toBe(true);
    }
  });

  it('polar route JFK→HKG in December and June', () => {
    for (const [dep, arr] of [
      ['2026-12-21T06:10:00Z', '2026-12-21T21:55:00Z'],
      ['2026-06-21T05:10:00Z', '2026-06-21T20:55:00Z'],
    ] as const) {
      const j = journeyOf(leg('JFK', 'HKG', dep, arr));
      for (const rule of ['angleBased', 'middleOfNight', 'nearestLatitude'] as const) {
        const r = computeInflight(j, withMethod({ highLatitudeRule: rule }));
        expectSane(r, j);
        expect(Math.max(...r.samples.map((s) => s.state.lat))).toBeGreaterThan(60);
        prayerTasks(r, j);
        windowTimeline(r);
      }
    }
  });
});

describe('computeInflight: dip effect', () => {
  it('at 11 km Maghrib is later and Sunrise earlier when the horizon dip is applied', () => {
    const start = '2026-03-20T00:00:00Z';
    const air = stationary(40, 0, start, 24, { altitudeM: 11000, onGround: false });
    const on = computeInflight(air, withMethod({ dipForSunriseSunset: true }));
    const off = computeInflight(air, withMethod({ dipForSunriseSunset: false }));
    const get = (r: InflightResult, p: PrayerName) => r.events.find((e) => e.prayer === p)!.time.getTime();
    const maghribLater = (get(on, 'maghrib') - get(off, 'maghrib')) / 60000;
    const sunriseEarlier = (get(off, 'sunrise') - get(on, 'sunrise')) / 60000;
    expect(maghribLater).toBeGreaterThan(5);
    expect(maghribLater).toBeLessThan(40);
    expect(sunriseEarlier).toBeGreaterThan(5);
    expect(sunriseEarlier).toBeLessThan(40);
    // twilight times are unaffected unless dipForTwilight is set
    expect(Math.abs(get(on, 'fajr') - get(off, 'fajr'))).toBeLessThanOrEqual(1000);
    const tw = computeInflight(air, withMethod({ dipForTwilight: true }));
    expect(get(tw, 'fajr')).toBeLessThan(get(on, 'fajr'));
  });
});

describe('computeInflight: settings variety', () => {
  const lat = 24.8607, lon = 67.0011;
  const j = stationary(lat, lon, '2026-03-21T00:00:00Z', 24);
  const at = (r: InflightResult, p: PrayerName) => r.events.find((e) => e.prayer === p)!.time.getTime();

  it('Hanafi Asr is later than Shafi\'i Asr', () => {
    const han = computeInflight(j, withMethod({ madhab: 'hanafi' }));
    const shf = computeInflight(j, withMethod({ madhab: 'shafii' }));
    const diff = (at(han, 'asr') - at(shf, 'asr')) / 60000;
    expect(diff).toBeGreaterThan(30);
    expect(diff).toBeLessThan(90);
    expect(at(han, 'dhuhr')).toBe(at(shf, 'dhuhr'));
  });

  it('custom angles 15/15 vs 18/18 move Fajr later and Isha earlier', () => {
    const c15 = computeInflight(j, withMethod({ method: { ...METHODS.custom, fajrAngle: 15, ishaAngle: 15 } }));
    const c18 = computeInflight(j, withMethod({ method: { ...METHODS.custom, fajrAngle: 18, ishaAngle: 18 } }));
    expect(at(c15, 'fajr')).toBeGreaterThan(at(c18, 'fajr'));
    expect(at(c15, 'isha')).toBeLessThan(at(c18, 'isha'));
    expect((at(c15, 'fajr') - at(c18, 'fajr')) / 60000).toBeGreaterThan(5);
  });

  it('Umm al-Qura: Isha is exactly 90 min after Maghrib', () => {
    const r = computeInflight(j, withMethod({ method: { ...METHODS.ummAlQura } }));
    const gap = (at(r, 'isha') - at(r, 'maghrib')) / 60000;
    expect(Math.abs(gap - 90)).toBeLessThan(0.05);
    expect(r.events.find((e) => e.prayer === 'isha')!.note).toBe('interval');
  });

  it('Ja\'fari: Maghrib (4° below the horizon) is later than sunset', () => {
    const jf = computeInflight(j, withMethod({ madhab: 'jafari', method: { ...METHODS.jafari } }));
    const std = computeInflight(j, DEFAULT_SETTINGS);
    expect(at(jf, 'maghrib')).toBeGreaterThan(at(std, 'maghrib') + 5 * 60000);
  });
});

describe('computeInflight: edge cases and options', () => {
  it('zero-duration journey: one sample, no events', () => {
    const j = stationary(24.86, 67, '2026-03-21T12:00:00Z', 0);
    const r = computeInflight(j, DEFAULT_SETTINGS);
    expect(r.samples.length).toBe(1);
    expect(r.events).toEqual([]);
    expect(NAMES).toContain(r.initialWindow);
    expect(windowTimeline(r)).toHaveLength(1);
    expect(prayerTasks(r, j).length).toBeLessThanOrEqual(1);
  });

  it('invalid dates and silly options never produce NaN', () => {
    const bad: Journey = { legs: [], start: new Date(NaN), end: new Date(NaN), stateAt: () => { throw new Error('x'); } };
    expect(computeInflight(bad, DEFAULT_SETTINGS).samples).toEqual([]);
    const j = stationary(10, 10, '2026-03-21T00:00:00Z', 3);
    for (const o of [{ stepMinutes: 0 }, { stepMinutes: -5 }, { stepMinutes: NaN }, { refineSeconds: 0 }, { refineSeconds: NaN }, { stepMinutes: 0.001 }]) {
      const r = computeInflight(j, DEFAULT_SETTINGS, o);
      expectSane(r, j);
    }
  });

  it('stepMinutes and the final sample', () => {
    const j = stationary(10, 10, '2026-03-21T00:00:00Z', 1.25);
    const r = computeInflight(j, DEFAULT_SETTINGS, { stepMinutes: 10 });
    expect(r.samples.length).toBe(9); // 0,10,...,70 + exact end at 75
    expect(r.samples[r.samples.length - 1].state.time.getTime()).toBe(j.end.getTime());
  });

  it('tzUnderAircraft:false skips the lookup', () => {
    const j = stationary(10, 10, '2026-03-21T00:00:00Z', 1);
    expect(computeInflight(j, DEFAULT_SETTINGS, { tzUnderAircraft: false }).samples.every((s) => s.tz === 'UTC')).toBe(true);
    expect(computeInflight(j, DEFAULT_SETTINGS).samples[0].tz).not.toBe('UTC');
  });

  it('qibla fields: relative bearing is qibla minus heading', () => {
    const j = journeyOf(leg('DXB', 'SFO', '2026-10-12T05:55:00Z', '2026-10-12T22:05:00Z'));
    const r = computeInflight(j, DEFAULT_SETTINGS, { stepMinutes: 30 });
    const mid = r.samples[Math.floor(r.samples.length / 2)];
    let d = (mid.qiblaDeg - mid.state.headingDeg + 540) % 360 - 180;
    if (d === -180) d = 180;
    expect(mid.qiblaRelativeDeg).toBeCloseTo(d, 6);
  });

  it('formatLatLon', () => {
    expect(formatLatLon(64.24, -22.1)).toBe('64.2°N 22.1°W');
    expect(formatLatLon(-33.9, 151.2)).toBe('33.9°S 151.2°E');
    expect(formatLatLon(NaN, NaN)).toBe('0.0°N 0.0°E');
  });
});

describe('computeInflight: refinement precision', () => {
  it('every event is within 2 s of a brute-force 1-second scan', () => {
    const j = journeyOf(leg('SFO', 'DXB', '2026-10-12T23:35:00Z', '2026-10-13T15:25:00Z'));
    // 3 h slice of the journey around the first part of the flight, scanned every second.
    const slice: Journey = { ...j, start: new Date(j.start.getTime() + 2 * HOUR), end: new Date(j.start.getTime() + 8 * HOUR) };
    const r = computeInflight(slice, DEFAULT_SETTINGS);
    const brute: { ms: number; w: PrayerWindow }[] = [];
    let prev: PrayerWindow | null = null;
    for (let ms = slice.start.getTime(); ms <= slice.end.getTime(); ms += 1000) {
      const s = j.stateAt(new Date(ms));
      const w = windowAt(new Date(ms), { lat: s.lat, lon: s.lon, elevationM: s.altitudeM }, DEFAULT_SETTINGS).window;
      if (prev !== null && w !== prev) brute.push({ ms, w });
      prev = w;
    }
    expect(r.events.length).toBe(brute.length);
    expect(r.events.length).toBeGreaterThanOrEqual(1);
    r.events.forEach((e, i) => {
      expect(e.prayer).toBe(brute[i].w);
      expect(Math.abs(e.time.getTime() - brute[i].ms)).toBeLessThanOrEqual(2000);
    });
  }, 60_000);

  it('a coarse refineSeconds still brackets the true time', () => {
    const j = journeyOf(leg('DXB', 'SFO', '2026-10-12T05:55:00Z', '2026-10-12T22:05:00Z'));
    const fine = computeInflight(j, DEFAULT_SETTINGS, { refineSeconds: 1 });
    const coarse = computeInflight(j, DEFAULT_SETTINGS, { refineSeconds: 30, stepMinutes: 5 });
    expect(coarse.events.length).toBe(fine.events.length);
    coarse.events.forEach((e, i) => expect(Math.abs(e.time.getTime() - fine.events[i].time.getTime())).toBeLessThanOrEqual(31_000));
  });
});

describe('summary helpers', () => {
  const j = journeyOf(leg('DXB', 'SFO', '2026-10-12T05:55:00Z', '2026-10-12T22:05:00Z'));
  const r = computeInflight(j, DEFAULT_SETTINGS);

  it('windowTimeline is contiguous and covers the journey', () => {
    const tl = windowTimeline(r);
    expect(tl[0].start.getTime()).toBe(j.start.getTime());
    expect(tl[tl.length - 1].end.getTime()).toBe(j.end.getTime());
    for (let i = 0; i + 1 < tl.length; i++) expect(tl[i].end.getTime()).toBe(tl[i + 1].start.getTime());
    for (const seg of tl) expect(seg.end.getTime()).toBeGreaterThan(seg.start.getTime());
    expect(tl[0].window).toBe(r.initialWindow);
  });

  it('prayerTasks: ends line up with the next event and durations add up', () => {
    const tasks = prayerTasks(r, j);
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']).toContain(t.prayer);
      if (t.windowEnd) {
        expect(t.endState).not.toBeNull();
        expect(t.durationMin).not.toBeNull();
        const start = t.windowStart ? t.windowStart.time.getTime() : j.start.getTime();
        expect((t.windowEnd.getTime() - start) / 60000).toBeCloseTo(t.durationMin as number, 6);
      } else {
        expect(t.endState).toBeNull();
        expect(t.durationMin).toBeNull();
        expect(t.notes).toContain('window still open at arrival');
      }
    }
    if (r.initialWindow !== 'sunrise') {
      expect(tasks[0].windowStart).toBeNull();
      expect(tasks[0].notes).toContain('window already open at departure');
    }
  });
});

describe('computeInflight: performance', () => {
  it('a 17 h leg at 1-minute steps completes quickly', () => {
    const j = journeyOf(leg('DFW', 'SYD', '2026-06-21T05:00:00Z', '2026-06-21T22:00:00Z'));
    const t0 = performance.now();
    const r = computeInflight(j, DEFAULT_SETTINGS, { stepMinutes: 1 });
    const ms = performance.now() - t0;
    expect(r.samples.length).toBe(17 * 60 + 1);
    expectSane(r, j);
    // eslint-disable-next-line no-console
    console.log(`[perf] 17 h DFW→SYD, 1-min steps: ${ms.toFixed(0)} ms, ${r.samples.length} samples, ${r.events.length} events`);
    expect(ms).toBeLessThan(3000);
  });
});

