import { describe, it, expect } from 'vitest';
import { _searchCacheSize, computeStaticTimes, makroohIntervals, solarDateAt, windowAt } from '../src/prayer/static';
import { DEFAULT_SETTINGS, METHODS, mergeSettings } from '../src/prayer/methods';
import type { HighLatitudeRule, Madhab, MethodId, Observer, PrayerName, PrayerSettings, StaticPrayerTimes } from '../src/types';

const NAMES: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const KARACHI: Observer = { lat: 24.8607, lon: 67.0011, elevationM: 0 };
const SF: Observer = { lat: 37.6213, lon: -122.379, elevationM: 0 };

/** UTC instant for a local wall-clock time `date HH:MM` in a fixed UTC offset (hours). */
function local(date: string, hhmm: string, tz: number): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - tz * 3_600_000);
}
/** Signed difference a-b in minutes. */
const diffMin = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 60_000;

/**
 * Reference values were computed independently of the engine with the praytimes.org
 * algorithm (different Sun formulae: Astronomical Almanac low-precision) in
 * a throwaway script, and cross-checked by hand for Karachi:
 * mean solar noon = 12:00 UTC - 67.0011/15 h = 07:32:00 UTC = 12:32 PKT, equation of time
 * on 21 March ~ -7.4 min (sun late) => transit 12:39 PKT.
 * NOTE: the 12:43 / 05:23 / 06:38 ... figures in the original task brief are ~4 min too late.
 */
function expectTimes(t: StaticPrayerTimes, date: string, tz: number, ref: Partial<Record<PrayerName, string>>, tol = 2) {
  for (const k of NAMES) {
    const want = ref[k];
    if (!want) continue;
    const got = t[k].time;
    expect(got, `${k} should exist`).not.toBeNull();
    // Reference clock times are on the local civil date, but may roll over midnight (e.g. isha 00:30).
    const d = diffMin(got as Date, local(date, want, tz));
    expect(Math.abs(d), `${k}: engine ${(got as Date).toISOString()} vs ref ${want} (off by ${d.toFixed(1)} min)`).toBeLessThanOrEqual(tol);
  }
}

describe('solarDateAt', () => {
  it('is the UTC date of t + lon/15 h', () => {
    expect(solarDateAt(new Date('2026-03-21T20:00:00Z'), 67)).toBe('2026-03-22'); // +4.47 h
    expect(solarDateAt(new Date('2026-03-21T10:00:00Z'), 67)).toBe('2026-03-21');
    expect(solarDateAt(new Date('2026-03-21T03:00:00Z'), -122)).toBe('2026-03-20'); // -8.1 h
    expect(solarDateAt(new Date('2026-03-21T12:00:00Z'), 0)).toBe('2026-03-21');
  });
  it('normalises longitudes (540 == -180 == 180 - 360) and tolerates junk', () => {
    const t = new Date('2026-03-21T06:00:00Z');
    expect(solarDateAt(t, 540)).toBe(solarDateAt(t, -180));
    expect(solarDateAt(t, 540)).toBe('2026-03-20');
    expect(solarDateAt(t, NaN)).toBe('2026-03-21'); // NaN longitude -> 0
    expect(solarDateAt(new Date(NaN), 10)).toBe('invalid-date');
  });
});

describe('reference values (+/- 2 min)', () => {
  it('Karachi 2026-03-21, Karachi 18/18, Hanafi (UTC+5)', () => {
    const t = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    expect(t.dayState).toBe('normal');
    expect(t.solarDate).toBe('2026-03-21');
    expectTimes(t, '2026-03-21', 5, { fajr: '05:19', sunrise: '06:35', dhuhr: '12:39', asr: '17:02', maghrib: '18:44', isha: '20:00' });
    for (const k of NAMES) expect(t[k].note).toBe('ok');
  });
  it('Karachi Shafi Asr is about 56 min earlier than Hanafi', () => {
    const s = computeStaticTimes(KARACHI, '2026-03-21', mergeSettings({ madhab: 'shafii' }));
    expectTimes(s, '2026-03-21', 5, { asr: '16:06' });
    const h = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    expect(diffMin(h.asr.time as Date, s.asr.time as Date)).toBeGreaterThan(50);
    expect(diffMin(h.asr.time as Date, s.asr.time as Date)).toBeLessThan(62);
  });
  it('Karachi Islamic midnight is halfway between sunset and next sunrise', () => {
    const t = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    const next = computeStaticTimes(KARACHI, '2026-03-22', DEFAULT_SETTINGS);
    const mid = ((t.maghrib.time as Date).getTime() + (next.sunrise.time as Date).getTime()) / 2;
    expect(Math.abs(mid - (t.midnight.time as Date).getTime())).toBeLessThan(60_000);
  });
  it('San Francisco 2026-06-21 ISNA 15/15, Shafi (PDT = UTC-7)', () => {
    const s = mergeSettings({ madhab: 'shafii', method: METHODS.isna });
    expectTimes(computeStaticTimes(SF, '2026-06-21', s), '2026-06-21', -7, {
      fajr: '04:17', sunrise: '05:48', dhuhr: '13:11', asr: '17:05', maghrib: '20:34', isha: '22:06',
    });
  });
  it('San Francisco 2026-12-21 ISNA 15/15, Shafi (PST = UTC-8)', () => {
    const s = mergeSettings({ madhab: 'shafii', method: METHODS.isna });
    expectTimes(computeStaticTimes(SF, '2026-12-21', s), '2026-12-21', -8, {
      fajr: '06:03', sunrise: '07:21', dhuhr: '12:08', asr: '14:37', maghrib: '16:55', isha: '18:13',
    });
  });
  it('London 2026-03-21 MWL 18/17, Hanafi (UTC)', () => {
    const s = mergeSettings({ method: METHODS.mwl });
    expectTimes(computeStaticTimes({ lat: 51.5, lon: -0.12, elevationM: 0 }, '2026-03-21', s), '2026-03-21', 0, {
      fajr: '04:07', sunrise: '06:01', dhuhr: '12:08', asr: '16:17', maghrib: '18:15', isha: '20:02',
    });
  });
  it('Umm al-Qura: Isha is 90 minutes after Maghrib and noted as an interval', () => {
    const t = computeStaticTimes({ lat: 21.4225, lon: 39.8262, elevationM: 0 }, '2026-03-21', mergeSettings({ method: METHODS.ummAlQura }));
    expect(diffMin(t.isha.time as Date, t.maghrib.time as Date)).toBeCloseTo(90, 6);
    expect(t.isha.note).toBe('interval');
  });
  it("Ja'fari/Tehran: Maghrib uses a sun angle so it is later than sunset", () => {
    const std = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    const j = computeStaticTimes(KARACHI, '2026-03-21', mergeSettings({ method: METHODS.tehran, madhab: 'jafari' }));
    const gap = diffMin(j.maghrib.time as Date, std.maghrib.time as Date);
    expect(gap).toBeGreaterThan(12);
    expect(gap).toBeLessThan(25);
    expect(j.midnight.time).not.toBeNull();
  });
  it('offsets shift only the chosen prayer, by exactly that many minutes', () => {
    const base = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    const off = computeStaticTimes(KARACHI, '2026-03-21', mergeSettings({ offsets: { asr: 5, fajr: -3 } as never }));
    expect(diffMin(off.asr.time as Date, base.asr.time as Date)).toBeCloseTo(5, 6);
    expect(diffMin(off.fajr.time as Date, base.fajr.time as Date)).toBeCloseTo(-3, 6);
    expect(off.isha.time).toEqual(base.isha.time);
  });
});

describe('elevation', () => {
  it('11 000 m: dip ~3.64 deg makes sunrise earlier and Maghrib later than at sea level', () => {
    const a = computeStaticTimes({ ...KARACHI, elevationM: 0 }, '2026-03-21', DEFAULT_SETTINGS);
    const b = computeStaticTimes({ ...KARACHI, elevationM: 11000 }, '2026-03-21', DEFAULT_SETTINGS);
    const earlier = diffMin(a.sunrise.time as Date, b.sunrise.time as Date);
    const later = diffMin(b.maghrib.time as Date, a.maghrib.time as Date);
    // 3.64 deg of extra depression at lat 25 / equinox ~ 3.64*4/cos(25) ~ 16 min.
    expect(earlier).toBeGreaterThan(14);
    expect(earlier).toBeLessThan(18);
    expect(later).toBeGreaterThan(14);
    expect(later).toBeLessThan(18);
    // Twilight is unaffected by default (dipForTwilight false).
    expect(b.fajr.time).toEqual(a.fajr.time);
    expect(b.isha.time).toEqual(a.isha.time);
  });
  it('dipForTwilight moves Fajr/Isha too; dipForSunriseSunset=false disables sunrise dip', () => {
    const base = computeStaticTimes({ ...KARACHI, elevationM: 11000 }, '2026-03-21', DEFAULT_SETTINGS);
    const tw = computeStaticTimes({ ...KARACHI, elevationM: 11000 }, '2026-03-21', mergeSettings({ dipForTwilight: true }));
    expect(diffMin(base.fajr.time as Date, tw.fajr.time as Date)).toBeGreaterThan(10);
    const noDip = computeStaticTimes({ ...KARACHI, elevationM: 11000 }, '2026-03-21', mergeSettings({ dipForSunriseSunset: false }));
    const sea = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    expect(noDip.sunrise.time).toEqual(sea.sunrise.time);
  });
  it('negative elevation (-400 m, Dead Sea) behaves like 0 m', () => {
    const a = computeStaticTimes({ ...KARACHI, elevationM: -400 }, '2026-03-21', DEFAULT_SETTINGS);
    const b = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    expect(a).toEqual(b);
  });
});

describe('high latitudes', () => {
  it('Reykjavik 2026-06-21: no 18 deg twilight -> Fajr/Isha derived by the angle-based rule', () => {
    const o: Observer = { lat: 64.13, lon: -21.94, elevationM: 0 };
    const t = computeStaticTimes(o, '2026-06-21', DEFAULT_SETTINGS);
    expect(t.dayState).toBe('normal');
    expect(t.fajr.note).toBe('highLatitudeRule');
    expect(t.isha.note).toBe('highLatitudeRule');
    expect(t.sunrise.note).toBe('ok');
    const fajr = t.fajr.time as Date, isha = t.isha.time as Date;
    expect(fajr).not.toBeNull();
    expect(isha).not.toBeNull();
    // night = next sunrise - sunset; portion = 18/60 of it.
    const next = computeStaticTimes(o, '2026-06-22', DEFAULT_SETTINGS);
    const night = diffMin(next.sunrise.time as Date, t.maghrib.time as Date);
    expect(night).toBeGreaterThan(150);
    expect(night).toBeLessThan(200);
    expect(diffMin(isha, t.maghrib.time as Date)).toBeCloseTo(0.3 * night, 3);
    expect(diffMin(t.sunrise.time as Date, fajr)).toBeCloseTo(0.3 * night, 3);
    // Sunrise ~02:55, sunset ~00:03 (+1 day) UTC.
    expect(Math.abs(diffMin(t.sunrise.time as Date, new Date('2026-06-21T02:55:00Z')))).toBeLessThan(3);
    expect(Math.abs(diffMin(t.maghrib.time as Date, new Date('2026-06-22T00:03:00Z')))).toBeLessThan(3);
  });
  it('oneSeventh / middleOfNight / none / nearestLatitude at Reykjavik', () => {
    const o: Observer = { lat: 64.13, lon: -21.94, elevationM: 0 };
    const next = computeStaticTimes(o, '2026-06-22', DEFAULT_SETTINGS);
    const ref = computeStaticTimes(o, '2026-06-21', DEFAULT_SETTINGS);
    const night = diffMin(next.sunrise.time as Date, ref.maghrib.time as Date);
    const seventh = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'oneSeventh' }));
    expect(diffMin(seventh.isha.time as Date, seventh.maghrib.time as Date)).toBeCloseTo(night / 7, 3);
    const half = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'middleOfNight' }));
    expect(diffMin(half.isha.time as Date, half.maghrib.time as Date)).toBeCloseTo(night / 2, 3);
    const none = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    expect(none.fajr).toEqual({ time: null, note: 'noEvent' });
    expect(none.isha).toEqual({ time: null, note: 'noEvent' });
    expect(none.sunrise.time).not.toBeNull();
    const nl = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'nearestLatitude' }));
    expect(nl.fajr.note).toBe('nearestLatitude');
    expect(nl.isha.note).toBe('nearestLatitude');
    expect(diffMin(nl.sunrise.time as Date, nl.fajr.time as Date)).toBeGreaterThan(0);
    expect(diffMin(nl.isha.time as Date, nl.maghrib.time as Date)).toBeGreaterThan(0);
  });
  it('the rule also corrects a Fajr that exists but is too far from sunrise (London in June)', () => {
    const o: Observer = { lat: 51.5, lon: -0.12, elevationM: 0 };
    const raw = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    const ruled = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'oneSeventh' }));
    // 18 deg twilight does not occur in London mid-June, so 'none' gives null.
    expect(raw.fajr.time).toBeNull();
    expect(ruled.fajr.note).toBe('highLatitudeRule');
    expect(diffMin(ruled.sunrise.time as Date, ruled.fajr.time as Date)).toBeGreaterThan(30);
  });
  it("Tromso 2026-06-21 is polarDay; the legacy 'fixedLatitude' fallback reproduces the 48.5 N times", () => {
    const o: Observer = { lat: 69.65, lon: 18.96, elevationM: 0 };
    const t = computeStaticTimes(o, '2026-06-21', mergeSettings({ polarFallback: 'fixedLatitude' }));
    expect(t.dayState).toBe('polarDay');
    for (const k of ['sunrise', 'asr', 'maghrib'] as const) {
      expect(t[k].time).not.toBeNull();
      expect(t[k].note).toBe('nearestLatitude');
    }
    expect(t.dhuhr.note).toBe('ok'); // transit does not depend on latitude
    expect(t.fajr.time).not.toBeNull();
    expect(t.isha.time).not.toBeNull();
    expect(t.midnight.time).not.toBeNull();
    expect(t.midnight.note).toBe('nearestLatitude');
    expect(t.borrowedLatitude).toBe(48.5);
    // Same clock times as a 48.5 N observer at this longitude.
    const ref = computeStaticTimes({ lat: 48.5, lon: 18.96, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    expect(t.sunrise.time).toEqual(ref.sunrise.time);
    expect(t.maghrib.time).toEqual(ref.maghrib.time);
    expect(t.asr.time).toEqual(ref.asr.time);
  });
  it("Tromso 2026-12-21 is polarNight; 'fixedLatitude' and the southern mirror clamp to +/-48.5", () => {
    const fixed = mergeSettings({ polarFallback: 'fixedLatitude' });
    const t = computeStaticTimes({ lat: 69.65, lon: 18.96, elevationM: 0 }, '2026-12-21', fixed);
    expect(t.dayState).toBe('polarNight');
    for (const k of NAMES) expect(t[k].time, k).not.toBeNull();
    expect(t.sunrise.note).toBe('nearestLatitude');
    expect(t.borrowedLatitude).toBe(48.5);
    const s = computeStaticTimes({ lat: -69.65, lon: 18.96, elevationM: 0 }, '2026-06-21', fixed);
    expect(s.dayState).toBe('polarNight');
    expect(s.sunrise.note).toBe('nearestLatitude');
    expect(s.borrowedLatitude).toBe(-48.5);
  });
  it("rule 'none' in polar regions leaves unreachable events null with noEvent", () => {
    const o: Observer = { lat: 69.65, lon: 18.96, elevationM: 0 };
    const day = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    expect(day.dayState).toBe('polarDay');
    for (const k of ['fajr', 'sunrise', 'maghrib', 'isha', 'midnight'] as const) expect(day[k]).toEqual({ time: null, note: 'noEvent' });
    expect(day.dhuhr.time).not.toBeNull();
    const night = computeStaticTimes(o, '2026-12-21', mergeSettings({ highLatitudeRule: 'none' }));
    expect(night.dayState).toBe('polarNight');
    expect(night.sunrise.time).toBeNull();
    expect(night.asr.time).toBeNull();
    expect(night.dhuhr.time).not.toBeNull();
  });
});

describe('edge cases', () => {
  const allDates = (t: StaticPrayerTimes) =>
    [...NAMES, 'midnight' as const].map((k) => t[k].time).filter((d): d is Date => d !== null);
  const expectClean = (t: StaticPrayerTimes) => {
    for (const k of [...NAMES, 'midnight' as const]) {
      const p = t[k];
      if (p.time === null) expect(p.note, k).toBe('noEvent');
      else {
        expect(p.time instanceof Date, k).toBe(true);
        expect(Number.isNaN(p.time.getTime()), k).toBe(false);
        expect(p.note, k).not.toBe('noEvent');
      }
    }
  };

  it.each([[90, 0], [-90, 0], [89.99999, 10], [-89.99999, 10], [0, 0], [0, 180], [0, -180], [0, 540], [45, -540]])(
    'lat %s lon %s: all dates valid, in every season and rule',
    (lat, lon) => {
      for (const date of ['2026-03-20', '2026-06-21', '2026-12-21']) {
        for (const rule of ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude', 'none'] as HighLatitudeRule[]) {
          const t = computeStaticTimes({ lat, lon, elevationM: 0 }, date, mergeSettings({ highLatitudeRule: rule }));
          expectClean(t);
          expect(['normal', 'polarDay', 'polarNight']).toContain(t.dayState);
        }
      }
    },
  );

  it('exact poles are polar day/night depending on season, never NaN', () => {
    expect(computeStaticTimes({ lat: 90, lon: 0, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS).dayState).toBe('polarDay');
    expect(computeStaticTimes({ lat: 90, lon: 0, elevationM: 0 }, '2026-12-21', DEFAULT_SETTINGS).dayState).toBe('polarNight');
    expect(computeStaticTimes({ lat: -90, lon: 0, elevationM: 0 }, '2026-12-21', DEFAULT_SETTINGS).dayState).toBe('polarDay');
    expect(computeStaticTimes({ lat: -90, lon: 0, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS).dayState).toBe('polarNight');
  });

  it('longitudes 180, -180 and 540 are equivalent', () => {
    const a = computeStaticTimes({ lat: 10, lon: 180, elevationM: 0 }, '2026-03-21', DEFAULT_SETTINGS);
    const b = computeStaticTimes({ lat: 10, lon: -180, elevationM: 0 }, '2026-03-21', DEFAULT_SETTINGS);
    const c = computeStaticTimes({ lat: 10, lon: 540, elevationM: 0 }, '2026-03-21', DEFAULT_SETTINGS);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('elevations -400, 0, 11000 and absurd values stay valid', () => {
    for (const elevationM of [-400, 0, 11000, 1e7, NaN, Infinity, -Infinity]) {
      expectClean(computeStaticTimes({ lat: 30, lon: 10, elevationM }, '2026-06-21', DEFAULT_SETTINGS));
    }
  });

  it('non-finite lat/lon or a malformed date gives all-null noEvent with dayState normal', () => {
    const bad: [Observer, string][] = [
      [{ lat: NaN, lon: 10, elevationM: 0 }, '2026-03-21'],
      [{ lat: 10, lon: NaN, elevationM: 0 }, '2026-03-21'],
      [{ lat: Infinity, lon: 10, elevationM: 0 }, '2026-03-21'],
      [{ lat: 10, lon: -Infinity, elevationM: 0 }, '2026-03-21'],
      [{ lat: 10, lon: 10, elevationM: 0 }, 'not-a-date'],
    ];
    for (const [obs, date] of bad) {
      const t = computeStaticTimes(obs, date, DEFAULT_SETTINGS);
      expect(t.dayState).toBe('normal');
      for (const k of [...NAMES, 'midnight' as const]) expect(t[k]).toEqual({ time: null, note: 'noEvent' });
    }
  });

  it('works for far-past and far-future dates', () => {
    for (const date of ['1600-03-21', '1900-06-21', '2100-12-21', '3000-01-01']) {
      const t = computeStaticTimes(KARACHI, date, DEFAULT_SETTINGS);
      expectClean(t);
      expect(allDates(t).length).toBe(7);
    }
  });

  it('Asr exists on a normal day even when the noon Sun is very low (Tromso at the edge of polar night)', () => {
    const t = computeStaticTimes({ lat: 66, lon: 0, elevationM: 0 }, '2026-12-21', mergeSettings({ highLatitudeRule: 'none' }));
    expectClean(t);
  });
});

describe('property: no NaN and chronological order across the globe', () => {
  const dates = ['2026-03-20', '2026-06-21', '2026-09-23', '2026-12-21'];
  const madhabs: Madhab[] = ['hanafi', 'shafii', 'maliki', 'hanbali', 'jafari'];
  const rules: HighLatitudeRule[] = ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude', 'none'];

  it('every lat (-90..90 step 7.5) x lon (-180..180 step 45) x date x madhab x rule', () => {
    const violations: string[] = [];
    let checked = 0, ordered = 0;
    for (let lat = -90; lat <= 90; lat += 7.5) {
      for (let lon = -180; lon <= 180; lon += 45) {
        for (const date of dates) {
          for (const madhab of madhabs) {
            for (const rule of rules) {
              const s: PrayerSettings = mergeSettings({ madhab, highLatitudeRule: rule });
              const t = computeStaticTimes({ lat, lon, elevationM: 0 }, date, s);
              checked++;
              const where = `lat ${lat} lon ${lon} ${date} ${madhab} ${rule}`;
              for (const k of [...NAMES, 'midnight' as const]) {
                const p = t[k];
                if (p.time !== null && Number.isNaN(p.time.getTime())) violations.push(`${where}: ${k} Invalid Date`);
                if (p.time === null && p.note !== 'noEvent') violations.push(`${where}: ${k} null with note ${p.note}`);
              }
              const ms = NAMES.map((k) => t[k].time?.getTime() ?? null);
              // Also holds in polar states: the fallback must give a consistent day.
              if (rule !== 'none' && ms.every((x) => x !== null)) {
                ordered++;
                for (let i = 1; i < ms.length; i++) {
                  if (!((ms[i] as number) > (ms[i - 1] as number))) {
                    violations.push(`${where}: ${NAMES[i - 1]} (${new Date(ms[i - 1] as number).toISOString()}) !< ${NAMES[i]} (${new Date(ms[i] as number).toISOString()})`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(25 * 9 * 4 * 5 * 5);
    expect(ordered).toBeGreaterThan(5000);
    expect(violations.slice(0, 20)).toEqual([]);
  });

  it('every preset method stays finite and ordered at mid and high latitudes', () => {
    const violations: string[] = [];
    for (const id of Object.keys(METHODS) as MethodId[]) {
      for (const lat of [-60, -33, 0, 21.4, 40, 52, 60, 66]) {
        for (const date of dates) {
          const t = computeStaticTimes({ lat, lon: 30, elevationM: 0 }, date, mergeSettings({ method: METHODS[id] }));
          const ms = NAMES.map((k) => t[k].time?.getTime() ?? null);
          for (const k of NAMES) if (t[k].time && Number.isNaN(t[k].time!.getTime())) violations.push(`${id} ${lat} ${date} ${k} NaN`);
          if (t.dayState === 'normal' && ms.every((x) => x !== null)) {
            for (let i = 1; i < ms.length; i++) {
              if (!((ms[i] as number) > (ms[i - 1] as number))) violations.push(`${id} lat ${lat} ${date}: ${NAMES[i - 1]} !< ${NAMES[i]}`);
            }
          }
        }
      }
    }
    expect(violations.slice(0, 20)).toEqual([]);
  });
});

describe('nearest-location fallback (aqrab al-bilad)', () => {
  const REQUIRED = ['sunrise', 'asr', 'maghrib'] as const;
  /** True if sunrise, Asr, Maghrib exist and the sun rises and sets (a "normal" day) at this exact latitude. */
  const eventsExist = (lat: number, lon: number, date: string, s: PrayerSettings = DEFAULT_SETTINGS) => {
    const t = computeStaticTimes({ lat, lon, elevationM: 0 }, date, mergeSettings({ ...s, highLatitudeRule: 'none' }));
    return t.dayState === 'normal' && REQUIRED.every((k) => t[k].time !== null);
  };

  const cases: [string, number, number, string, 'polarDay' | 'polarNight'][] = [
    ['Tromso June', 69.65, 18.96, '2026-06-21', 'polarDay'],
    ['Tromso December', 69.65, 18.96, '2026-12-21', 'polarNight'],
    ['80 N June', 80, 10, '2026-06-21', 'polarDay'],
    ['80 N December', 80, 10, '2026-12-21', 'polarNight'],
    ['89.9 N June', 89.9, -120, '2026-06-21', 'polarDay'],
    ['89.9 N December', 89.9, -120, '2026-12-21', 'polarNight'],
    ['75 S June', -75, 0, '2026-06-21', 'polarNight'],
    ['75 S December', -75, 0, '2026-12-21', 'polarDay'],
  ];

  it.each(cases)('%s: borrowed latitude is the nearest place with sunrise, Asr and sunset', (_n, lat, lon, date, state) => {
    for (const rule of ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude'] as HighLatitudeRule[]) {
      const s = mergeSettings({ highLatitudeRule: rule });
      const t = computeStaticTimes({ lat, lon, elevationM: 0 }, date, s);
      expect(t.dayState).toBe(state);
      const b = t.borrowedLatitude as number;
      expect(b, rule).toBeDefined();
      // Between the observer and the equator, same hemisphere.
      expect(Math.sign(b)).toBe(Math.sign(lat));
      expect(Math.abs(b)).toBeLessThan(Math.abs(lat));
      // All events exist there ...
      expect(eventsExist(b, lon, date, s), `events exist at ${b}`).toBe(true);
      // ... but not 0.3 degrees closer to the pole (nor at the observer): it is the nearest such place.
      expect(eventsExist(b + Math.sign(lat) * 0.3, lon, date, s), `events must not exist at ${b + Math.sign(lat) * 0.3}`).toBe(false);
      // And not needlessly far: within 0.3 degrees of the boundary (0.01 tolerance + 0.05 margin).
      expect(eventsExist(b - Math.sign(lat) * 0.0, lon, date, s)).toBe(true);
      // Complete, non-null and chronologically ordered day.
      for (const k of NAMES) expect(t[k].time, `${rule} ${k}`).not.toBeNull();
      const ms = NAMES.map((k) => (t[k].time as Date).getTime());
      for (let i = 1; i < ms.length; i++) expect(ms[i], `${rule}: ${NAMES[i - 1]} < ${NAMES[i]}`).toBeGreaterThan(ms[i - 1]);
      expect(t.midnight.time).not.toBeNull();
      expect(t.midnight.note).toBe('nearestLatitude');
      for (const k of REQUIRED) expect(t[k].note, k).toBe('nearestLatitude');
      expect(t.dhuhr.note).toBe('ok');
    }
  });

  it('borrowed values: Tromso June ~65.7 N (sunset needs lat < 90-23.44-0.83), December ~66.5 N (Asr needs a noon sun above the horizon)', () => {
    const jun = computeStaticTimes({ lat: 69.65, lon: 18.96, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    expect(jun.borrowedLatitude as number).toBeGreaterThan(65.4);
    expect(jun.borrowedLatitude as number).toBeLessThan(65.8);
    const dec = computeStaticTimes({ lat: 69.65, lon: 18.96, elevationM: 0 }, '2026-12-21', DEFAULT_SETTINGS);
    expect(dec.borrowedLatitude as number).toBeGreaterThan(66.2);
    expect(dec.borrowedLatitude as number).toBeLessThan(66.6);
  });

  it('borrowed times equal the real times of an observer at the borrowed latitude, Dhuhr stays at the real place', () => {
    const o: Observer = { lat: 80, lon: 10, elevationM: 0 };
    const t = computeStaticTimes(o, '2026-06-21', DEFAULT_SETTINGS);
    const at = computeStaticTimes({ ...o, lat: t.borrowedLatitude as number }, '2026-06-21', DEFAULT_SETTINGS);
    expect(at.dayState).toBe('normal');
    for (const k of REQUIRED) expect(t[k].time).toEqual(at[k].time);
    expect(t.dhuhr.time).toEqual(at.dhuhr.time); // transit is latitude independent
  });

  it('the search keeps the observer elevation: a dip of 3.64 deg moves the borrowed latitude toward the equator', () => {
    const sea = computeStaticTimes({ lat: 80, lon: 10, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    const high = computeStaticTimes({ lat: 80, lon: 10, elevationM: 11000 }, '2026-06-21', DEFAULT_SETTINGS);
    // The sun must get 4.5 deg (0.83 + 3.64) below the horizon to set: lat < 90 - 23.44 - 4.47 ~ 62.1.
    expect(high.borrowedLatitude as number).toBeLessThan((sea.borrowedLatitude as number) - 3);
    expect(high.borrowedLatitude as number).toBeGreaterThan(61.5);
    expect(high.borrowedLatitude as number).toBeLessThan(62.1);
  });

  it('maghrib-angle methods (Tehran) also need the Maghrib angle to be reached at the borrowed latitude', () => {
    const s = mergeSettings({ method: METHODS.tehran, madhab: 'jafari' });
    const t = computeStaticTimes({ lat: 78, lon: 51, elevationM: 0 }, '2026-06-21', s);
    expect(t.maghrib.note).toBe('nearestLatitude'); // reached the angle, no sunset fallback
    const b = t.borrowedLatitude as number;
    const at = computeStaticTimes({ lat: b, lon: 51, elevationM: 0 }, '2026-06-21', mergeSettings({ ...s, highLatitudeRule: 'none' }));
    expect(at.maghrib.note).toBe('ok');
    expect(at.maghrib.time).toEqual(t.maghrib.time);
    expect(b).toBeLessThan(62.1); // sun must reach -4.5 degrees: lat < 90 - 23.44 - 4.5 ~ 62.06
  });

  it("rule 'nearestLatitude': twilight comes from the nearest latitude where that angle is reached (per event)", () => {
    const s = mergeSettings({ highLatitudeRule: 'nearestLatitude' });
    const t = computeStaticTimes({ lat: 80, lon: 10, elevationM: 0 }, '2026-06-21', s);
    expect(t.fajr.note).toBe('nearestLatitude');
    expect(t.isha.note).toBe('nearestLatitude');
    // The Fajr/Isha latitude is further south than the sunrise/sunset latitude (18 deg twilight needs lat < ~48.6).
    const twilightLat = computeStaticTimes({ lat: 48.4, lon: 10, elevationM: 0 }, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    expect(twilightLat.fajr.time).not.toBeNull();
    expect(Math.abs(diffMin(t.fajr.time as Date, twilightLat.fajr.time as Date))).toBeLessThan(15);
    // A smaller Fajr angle is reached closer to the pole, so its time differs.
    const s15 = mergeSettings({ highLatitudeRule: 'nearestLatitude', method: METHODS.isna });
    const t15 = computeStaticTimes({ lat: 80, lon: 10, elevationM: 0 }, '2026-06-21', s15);
    expect(t15.fajr.time).not.toBeNull();
    expect(diffMin(t.fajr.time as Date, t15.fajr.time as Date)).not.toBe(0);
  });

  it("non-polar rule 'nearestLatitude' (Reykjavik) borrows Fajr/Isha dynamically and reports the latitude", () => {
    const o: Observer = { lat: 64.13, lon: -21.94, elevationM: 0 };
    const dyn = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'nearestLatitude' }));
    expect(dyn.dayState).toBe('normal');
    expect(dyn.fajr.note).toBe('nearestLatitude');
    expect(dyn.isha.note).toBe('nearestLatitude');
    const b = dyn.borrowedLatitude as number;
    expect(b).toBeGreaterThan(46);
    expect(b).toBeLessThan(49.5);
    expect(computeStaticTimes({ ...o, lat: b }, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' })).fajr.time).not.toBeNull();
    expect(computeStaticTimes({ ...o, lat: b + 0.3 }, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' })).fajr.time).toBeNull();
    // Sunrise/sunset stay the real local ones.
    const real = computeStaticTimes(o, '2026-06-21', DEFAULT_SETTINGS);
    expect(dyn.sunrise.time).toEqual(real.sunrise.time);
    expect(dyn.maghrib.time).toEqual(real.maghrib.time);
    // 'fixedLatitude' keeps the legacy 48.5 behaviour exactly.
    const fixed = computeStaticTimes(o, '2026-06-21', mergeSettings({ highLatitudeRule: 'nearestLatitude', polarFallback: 'fixedLatitude' }));
    expect(fixed.borrowedLatitude).toBe(48.5);
    const ref = computeStaticTimes({ ...o, lat: 48.5 }, '2026-06-21', mergeSettings({ highLatitudeRule: 'nearestLatitude' }));
    expect(fixed.fajr.time).toEqual(ref.fajr.time);
    expect(fixed.isha.time).toEqual(ref.isha.time);
  });

  it('no borrowing (and no borrowedLatitude) at ordinary latitudes, or with rule none', () => {
    expect(computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS).borrowedLatitude).toBeUndefined();
    const none = computeStaticTimes({ lat: 80, lon: 0, elevationM: 0 }, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    expect(none.borrowedLatitude).toBeUndefined();
  });

  it('is independent of the exact observer latitude and is repeatable (memoised search)', () => {
    const a = computeStaticTimes({ lat: 70, lon: 18.96, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    const b = computeStaticTimes({ lat: 88.1, lon: 18.96, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    const c = computeStaticTimes({ lat: 70, lon: 18.96, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    expect(a.borrowedLatitude).toBe(b.borrowedLatitude);
    expect(a.sunrise.time).toEqual(c.sunrise.time);
  });

  it('the search memo is bounded', () => {
    for (let i = 0; i < 600; i++) computeStaticTimes({ lat: 85, lon: i * 0.5, elevationM: 0 }, '2026-06-21', DEFAULT_SETTINGS);
    expect(_searchCacheSize()).toBeLessThanOrEqual(256);
  });

  it('is fast near the pole (well under 2 ms per call)', () => {
    const N = 100;
    computeStaticTimes({ lat: 89.9, lon: 0, elevationM: 11000 }, '2026-06-21', DEFAULT_SETTINGS); // warm JIT
    const t0 = performance.now();
    for (let i = 0; i < N; i++) computeStaticTimes({ lat: 89.9, lon: 100 + i * 0.37, elevationM: 11000 }, '2026-06-21', DEFAULT_SETTINGS);
    expect((performance.now() - t0) / N).toBeLessThan(2);
  });

  it('never yields NaN / Invalid Date near the poles on a dense latitude grid, for both fallbacks', () => {
    for (const polarFallback of ['nearestLocation', 'fixedLatitude'] as const) {
      for (let lat = 60; lat <= 90; lat += 1.7) {
        for (const date of ['2026-03-20', '2026-06-21', '2026-12-21']) {
          for (const sgn of [1, -1]) {
            const t = computeStaticTimes({ lat: sgn * lat, lon: 33, elevationM: 11000 }, date, mergeSettings({ polarFallback }));
            for (const k of [...NAMES, 'midnight' as const]) {
              if (t[k].time) expect(Number.isNaN(t[k].time!.getTime()), `${lat} ${date} ${k}`).toBe(false);
            }
            if (t.borrowedLatitude !== undefined) expect(Number.isFinite(t.borrowedLatitude)).toBe(true);
          }
        }
      }
    }
  });
});

describe('regression: Isha is never derived at or before an angle-based Maghrib', () => {
  it.each(['angleBased', 'oneSeventh', 'middleOfNight'] as HighLatitudeRule[])(
    "Tehran method at 86.1 S, 15 Sep, rule %s",
    (rule) => {
      const t = computeStaticTimes({ lat: -86.1, lon: 58, elevationM: 0 }, '2026-09-15', mergeSettings({ method: METHODS.tehran, highLatitudeRule: rule }));
      if (t.maghrib.time && t.isha.time) expect(t.isha.time.getTime()).toBeGreaterThan(t.maghrib.time.getTime());
      expect(t.isha.time).not.toBeNull();
    },
  );
});

describe('windowAt', () => {
  const at = (hhmm: string, s: PrayerSettings = DEFAULT_SETTINGS, date = '2026-03-21') => windowAt(local(date, hhmm, 5), KARACHI, s);

  it('Karachi 2026-03-21: 13:00 -> dhuhr, 03:00 -> isha, 17:30 -> asr (Hanafi), 06:50 -> sunrise', () => {
    expect(at('13:00').window).toBe('dhuhr');
    expect(at('03:00').window).toBe('isha');
    expect(at('17:30').window).toBe('asr');
    expect(at('06:50').window).toBe('sunrise');
  });
  it('covers the remaining windows and Hanafi vs Shafi Asr start', () => {
    expect(at('05:30').window).toBe('fajr');
    expect(at('18:50').window).toBe('maghrib');
    expect(at('20:30').window).toBe('isha');
    expect(at('23:59').window).toBe('isha');
    expect(at('17:30', mergeSettings({ madhab: 'shafii' })).window).toBe('asr');
    expect(at('16:30').window).toBe('dhuhr'); // Hanafi Asr begins ~17:01
    expect(at('16:30', mergeSettings({ madhab: 'shafii' })).window).toBe('asr');
  });
  it('reports the opening event, its time and note, and the day state', () => {
    const w = at('13:00');
    expect(w.openedBy?.prayer).toBe('dhuhr');
    expect(w.openedBy?.note).toBe('ok');
    expect(Math.abs(diffMin(w.openedBy!.time, local('2026-03-21', '12:39', 5)))).toBeLessThanOrEqual(2);
    expect(w.dayState).toBe('normal');
  });
  it('is exact at the boundary: the instant of an event already belongs to the window it opens', () => {
    const times = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    const maghrib = times.maghrib.time as Date;
    expect(windowAt(maghrib, KARACHI, DEFAULT_SETTINGS).window).toBe('maghrib');
    expect(windowAt(new Date(maghrib.getTime() - 1), KARACHI, DEFAULT_SETTINGS).window).toBe('asr');
  });
  it('uses the previous / next solar day across midnight and across the solar-date line', () => {
    // 00:30 PKT on 22 March is still Isha of 21 March (before Fajr).
    expect(windowAt(local('2026-03-22', '00:30', 5), KARACHI, DEFAULT_SETTINGS).window).toBe('isha');
    // San Francisco: 2026-03-21T03:00Z is ~19:00 PDT on the 20th -> Isha/Maghrib area, never throws.
    const w = windowAt(new Date('2026-03-21T03:00:00Z'), SF, DEFAULT_SETTINGS);
    expect(['maghrib', 'isha']).toContain(w.window);
  });
  it('polar fallback: Tromso still resolves a window; rule none only ever has dhuhr/asr', () => {
    const o: Observer = { lat: 69.65, lon: 18.96, elevationM: 0 };
    const w = windowAt(new Date('2026-06-21T12:00:00Z'), o, DEFAULT_SETTINGS);
    expect(w.dayState).toBe('polarDay');
    expect(NAMES).toContain(w.window);
    const n = windowAt(new Date('2026-06-21T20:00:00Z'), o, mergeSettings({ highLatitudeRule: 'none' }));
    expect(['dhuhr', 'asr']).toContain(n.window); // no sunrise/sunset/twilight events exist at all
  });
  it('invalid input never throws', () => {
    expect(windowAt(new Date(NaN), KARACHI, DEFAULT_SETTINGS).openedBy).toBeNull();
    const w = windowAt(new Date('2026-03-21T00:00:00Z'), { lat: NaN, lon: 0, elevationM: 0 }, DEFAULT_SETTINGS);
    expect(w.openedBy).toBeNull();
    expect(w.dayState).toBe('normal');
  });
});

describe('makroohIntervals', () => {
  it('~15 min after sunrise, 5 min before dhuhr, 15 min before maghrib', () => {
    const t = computeStaticTimes(KARACHI, '2026-03-21', DEFAULT_SETTINGS);
    const m = makroohIntervals(t);
    expect(m.length).toBe(3);
    expect(m[0].start).toEqual(t.sunrise.time);
    expect(diffMin(m[0].end, m[0].start)).toBe(15);
    expect(m[1].end).toEqual(t.dhuhr.time);
    expect(diffMin(m[1].end, m[1].start)).toBe(5);
    expect(m[2].end).toEqual(t.maghrib.time);
    expect(diffMin(m[2].end, m[2].start)).toBe(15);
    for (const x of m) expect(x.label.length).toBeGreaterThan(0);
  });
  it('skips events that are null', () => {
    const t = computeStaticTimes({ lat: 69.65, lon: 18.96, elevationM: 0 }, '2026-06-21', mergeSettings({ highLatitudeRule: 'none' }));
    const m = makroohIntervals(t);
    expect(m.length).toBe(1); // only the zawal at dhuhr
    expect(m[0].end).toEqual(t.dhuhr.time);
  });
});
