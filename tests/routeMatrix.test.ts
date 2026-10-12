/**
 * Route-matrix regression: every flight in FLIGHT_LIBRARY (both directions are in the library) and every
 * SAMPLE_ITINERARIES entry is pushed through the in-flight engine on four dates and several settings.
 *
 *   base variants  (all flights x 4 dates):   DEFAULT_SETTINGS, { shafii + MWL }
 *   rule variants  (flights that reach > 48.5° |lat| on the solstice dates): angleBased / oneSeventh /
 *                  middleOfNight / nearestLatitude   (the rules only differ at high latitude)
 *   itineraries    (all 14 x 4 dates x all 6 variants)
 *
 * We assert the invariants that must hold for ANY input: no NaN, strictly chronological events inside the
 * journey, valid windows, prayerTasks/windowTimeline never throw. DEFAULT_SETTINGS runs at a 2-minute step; the other
 * variants at 6 minutes to keep the whole file under a minute.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { computeInflight } from '../src/prayer/inflight';
import { prayerTasks, windowTimeline } from '../src/prayer/summary';
import { DEFAULT_SETTINGS, METHODS } from '../src/prayer/methods';
import { buildJourney } from '../src/flight/journey';
import { resolveAirport } from '../src/data/airports';
import {
  FLIGHT_LIBRARY,
  SAMPLE_ITINERARIES,
  itineraryToLegs,
  libraryFlightToLeg,
  type LibraryFlight,
} from '../src/data/flights';
import type { HighLatitudeRule, InflightResult, Journey, PrayerName, PrayerSettings } from '../src/types';

const DATES = ['2026-03-20', '2026-06-21', '2026-09-22', '2026-12-21'] as const;
const SOLSTICES = ['2026-06-21', '2026-12-21'];
const STEP = 2;
const COARSE_STEP = 6;
const NAMES: readonly PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const RULES: HighLatitudeRule[] = ['angleBased', 'oneSeventh', 'middleOfNight', 'nearestLatitude', 'redTwilight'];

const SHAFII_MWL: PrayerSettings = { ...DEFAULT_SETTINGS, madhab: 'shafii', method: { ...METHODS.mwl } };
const ruleVariant = (rule: HighLatitudeRule): PrayerSettings => ({ ...DEFAULT_SETTINGS, highLatitudeRule: rule });

const stats = {
  runs: 0,
  flightsBuilt: 0,
  itinerariesBuilt: 0,
  samples: 0,
  events: 0,
  anomalies: { windowRepeated: 0, windowSkipped: 0, polarDay: 0, polarNight: 0, highLatitudeRuleUsed: 0 } as Record<string, number>,
  baseRuns: 0,
  ruleRuns: 0,
  itineraryRuns: 0,
  repeatedRoutes: new Set<string>(),
  skippedRoutes: new Set<string>(),
  ms: 0,
};

const f = Number.isFinite;

/** Collect every invariant violation as a string (an `expect` per sample would dominate the runtime). */
function check(label: string, r: InflightResult, j: Journey, errors: string[]): { maxAbsLat: number } {
  const a = j.start.getTime();
  const b = j.end.getTime();
  const bad = (msg: string) => { if (errors.length < 50) errors.push(`${label}: ${msg}`); };
  let maxAbsLat = 0;

  if (r.samples.length < 2) bad(`only ${r.samples.length} samples`);
  if (!NAMES.includes(r.initialWindow)) bad(`invalid initialWindow ${r.initialWindow}`);
  r.samples.forEach((s, i) => {
    const st = s.state;
    if (!f(st.lat) || !f(st.lon) || !f(st.altitudeM) || !f(st.headingDeg)) bad(`non-finite state @${i}`);
    if (!f(s.sunAltitudeDeg) || !f(s.sunAzimuthDeg) || !f(s.qiblaDeg) || !f(s.qiblaRelativeDeg)) bad(`non-finite sun/qibla @${i}`);
    if (s.sunAltitudeDeg < -90.0001 || s.sunAltitudeDeg > 90.0001) bad(`sun altitude out of range @${i}`);
    if (!NAMES.includes(s.window)) bad(`invalid window @${i}`);
    if (!s.tz) bad(`empty tz @${i}`);
    if (!f(st.time.getTime())) bad(`invalid sample time @${i}`);
    maxAbsLat = Math.max(maxAbsLat, Math.abs(st.lat));
  });
  if (r.samples[0] && r.samples[0].state.time.getTime() !== a) bad('first sample is not at journey start');
  const lastS = r.samples[r.samples.length - 1];
  if (lastS && lastS.state.time.getTime() !== b) bad('last sample is not at journey end');

  let prev = -Infinity;
  for (const e of r.events) {
    const t = e.time.getTime();
    if (!f(t)) bad('event with invalid time');
    else {
      if (!(t > prev)) bad(`events not strictly chronological at ${e.time.toISOString()}`);
      if (t < a || t > b) bad(`event ${e.prayer} outside the journey: ${e.time.toISOString()}`);
    }
    if (!NAMES.includes(e.prayer)) bad(`invalid event prayer ${e.prayer}`);
    if (!f(e.state.lat) || !f(e.state.lon) || !f(e.state.altitudeM)) bad('event state non-finite');
    prev = t;
  }
  for (const an of r.anomalies) {
    if (!f(an.time.getTime())) bad('anomaly with invalid time');
    if (!an.message || /NaN|undefined|Invalid/.test(an.message)) bad(`bad anomaly message: ${an.message}`);
  }
  // Consecutive samples must be consistent with the event list: #window changes <= #events.
  let changes = 0;
  for (let i = 1; i < r.samples.length; i++) if (r.samples[i].window !== r.samples[i - 1].window) changes++;
  if (r.events.length < changes) bad(`${changes} sample window changes but only ${r.events.length} events`);

  try {
    const tasks = prayerTasks(r, j);
    for (const t of tasks) {
      if (t.durationMin !== null && !(t.durationMin >= 0)) bad(`negative task duration ${t.durationMin}`);
      if ((t.windowEnd === null) !== (t.endState === null)) bad('windowEnd / endState mismatch');
    }
    const tl = windowTimeline(r);
    for (let i = 0; i + 1 < tl.length; i++) {
      if (tl[i].end.getTime() !== tl[i + 1].start.getTime()) bad('timeline not contiguous');
    }
    if (tl.length && tl[0].start.getTime() !== a) bad('timeline does not start at departure');
  } catch (err) {
    bad(`prayerTasks/windowTimeline threw: ${(err as Error).message}`);
  }
  return { maxAbsLat };
}

function tally(label: string, r: InflightResult): void {
  stats.runs++;
  stats.samples += r.samples.length;
  stats.events += r.events.length;
  for (const an of r.anomalies) {
    stats.anomalies[an.kind] = (stats.anomalies[an.kind] ?? 0) + 1;
    if (an.kind === 'windowRepeated') stats.repeatedRoutes.add(label.split(' ')[0]);
    if (an.kind === 'windowSkipped') stats.skippedRoutes.add(label.split(' ')[0]);
  }
}

const buildLibraryJourney = (fl: LibraryFlight, date: string): Journey =>
  buildJourney([libraryFlightToLeg(fl, date, resolveAirport)], resolveAirport);

/** Highest |latitude| along the journey (cheap: positions only, no prayer maths). */
function maxAbsLatitude(j: Journey): number {
  let m = 0;
  for (let t = j.start.getTime(); t <= j.end.getTime(); t += 10 * 60_000) m = Math.max(m, Math.abs(j.stateAt(new Date(t)).lat));
  return m;
}

interface Variant {
  name: string;
  settings: PrayerSettings;
  step: number;
  tz: boolean;
  /** Only flights that reach beyond 48.5° |lat| (where the high-latitude rules differ), on the solstice dates. */
  highLatOnly?: boolean;
  counter: 'baseRuns' | 'ruleRuns';
}

// Default settings run at the full 2-minute step; the other variants use a coarser 6-minute step so the whole
// file stays under a minute (a coarser step also stresses the skipped/short-window subdivision logic).
const LIB_VARIANTS: Variant[] = [
  { name: 'default', settings: DEFAULT_SETTINGS, step: STEP, tz: true, counter: 'baseRuns' },
  { name: 'shafii+mwl', settings: SHAFII_MWL, step: COARSE_STEP, tz: false, counter: 'baseRuns' },
  ...RULES.map((r): Variant => ({
    name: r, settings: ruleVariant(r), step: COARSE_STEP, tz: false, highLatOnly: true, counter: 'ruleRuns',
  })),
];

describe('route matrix: FLIGHT_LIBRARY', () => {
  it('library is substantial and (mostly) bidirectional', () => {
    const pairs = new Set(FLIGHT_LIBRARY.map((x) => `${x.from}-${x.to}`));
    const missing = [...pairs].filter((p) => !pairs.has(p.split('-').reverse().join('-')));
    expect(missing.length).toBeLessThan(pairs.size * 0.2);
    expect(FLIGHT_LIBRARY.length).toBeGreaterThan(100);
  });

  for (const date of DATES) {
    for (const v of LIB_VARIANTS) {
      if (v.highLatOnly && !SOLSTICES.includes(date)) continue;
      it(`all flights on ${date} [${v.name}]`, () => {
        const errors: string[] = [];
        const t0 = performance.now();
        for (const fl of FLIGHT_LIBRARY) {
          const label = `${fl.flightNumber} ${fl.from}-${fl.to} ${date}`;
          let j: Journey;
          try {
            j = buildLibraryJourney(fl, date);
          } catch (err) {
            errors.push(`${label}: cannot build journey: ${(err as Error).message}`);
            continue;
          }
          if (v.name === 'default') stats.flightsBuilt++;
          if (v.highLatOnly && maxAbsLatitude(j) <= 48.5) continue;
          const r = computeInflight(j, v.settings, { stepMinutes: v.step, tzUnderAircraft: v.tz });
          check(`${label} [${v.name}]`, r, j, errors);
          tally(label, r);
          stats[v.counter]++;
        }
        stats.ms += performance.now() - t0;
        expect(errors).toEqual([]);
      }, 240_000);
    }
  }

  it("Shafi'i Asr never opens later than Hanafi Asr (mid-latitude flights, same day)", () => {
    const errors: string[] = [];
    for (const fl of FLIGHT_LIBRARY.filter((x) => x.region !== 'polar').slice(0, 60)) {
      const j = buildLibraryJourney(fl, '2026-09-22');
      if (maxAbsLatitude(j) > 55) continue;
      const han = computeInflight(j, DEFAULT_SETTINGS, { stepMinutes: COARSE_STEP, tzUnderAircraft: false });
      const shf = computeInflight(j, SHAFII_MWL, { stepMinutes: COARSE_STEP, tzUnderAircraft: false });
      const hAsr = han.events.find((e) => e.prayer === 'asr');
      const sAsr = shf.events.find((e) => e.prayer === 'asr');
      // Asr depends only on the madhab, so a Shafi'i Asr window opens earlier (aircraft position at that moment differs a little).
      if (hAsr && sAsr && sAsr.time.getTime() > hAsr.time.getTime() + 60_000) errors.push(`${fl.flightNumber}: Shafi'i Asr later than Hanafi Asr`);
    }
    expect(errors).toEqual([]);
  }, 120_000);
});

describe('route matrix: SAMPLE_ITINERARIES', () => {
  const variants: [string, PrayerSettings, number][] = [
    ['default', DEFAULT_SETTINGS, STEP],
    ['shafii+mwl', SHAFII_MWL, COARSE_STEP],
    ...RULES.map((r): [string, PrayerSettings, number] => [r, ruleVariant(r), COARSE_STEP]),
  ];

  for (const date of DATES) {
    it(`all itineraries on ${date}`, () => {
      const errors: string[] = [];
      const t0 = performance.now();
      for (const it of SAMPLE_ITINERARIES) {
        const label = `${it.id} ${date}`;
        let j: Journey;
        try {
          j = buildJourney(itineraryToLegs(it, date, resolveAirport), resolveAirport);
        } catch (err) {
          errors.push(`${label}: cannot build journey: ${(err as Error).message}`);
          continue;
        }
        stats.itinerariesBuilt++;
        for (const [name, settings, step] of variants) {
          const r = computeInflight(j, settings, { stepMinutes: step, tzUnderAircraft: name === 'default' });
          check(`${label} [${name}]`, r, j, errors);
          tally(label, r);
          stats.itineraryRuns++;
        }
      }
      stats.ms += performance.now() - t0;
      expect(errors).toEqual([]);
    }, 240_000);
  }
});

describe('route matrix: snapshot of DEFAULT_SETTINGS events on 2026-10-12', () => {
  it('sample itineraries produce a stable event list', () => {
    const snap: Record<string, string[]> = {};
    for (const it of SAMPLE_ITINERARIES) {
      const j = buildJourney(itineraryToLegs(it, '2026-10-12', resolveAirport), resolveAirport);
      const r = computeInflight(j, DEFAULT_SETTINGS, { stepMinutes: STEP, tzUnderAircraft: false });
      snap[it.id] = [
        `initial ${r.initialWindow}`,
        ...r.events.map((e) => {
          const min = e.time.toISOString().slice(0, 16) + 'Z';
          const where = e.state.onGround ? `ground ${e.state.airport ?? ''}`.trim() : 'air';
          return `${e.prayer} ${min} ${e.state.lat.toFixed(1)},${e.state.lon.toFixed(1)} ${where}${e.anomaly ? ` !${e.anomaly}` : ''}`;
        }),
      ];
    }
    expect(snap).toMatchSnapshot();
  }, 120_000);
});

afterAll(() => {
  const a = stats.anomalies;
  // eslint-disable-next-line no-console
  console.log(
    [
      '[routeMatrix] summary',
      `  library flights: ${FLIGHT_LIBRARY.length} x ${DATES.length} dates; built OK: ${stats.flightsBuilt}`,
      `  base runs (default + shafii/mwl): ${stats.baseRuns}; high-lat rule runs: ${stats.ruleRuns}; itinerary runs: ${stats.itineraryRuns} (${SAMPLE_ITINERARIES.length} itineraries x ${DATES.length} dates x 6 variants)`,
      `  total engine runs: ${stats.runs}, samples: ${stats.samples}, events: ${stats.events}`,
      `  anomalies: repeated ${a.windowRepeated}, skipped ${a.windowSkipped}, polarDay ${a.polarDay}, polarNight ${a.polarNight}, highLat ${a.highLatitudeRuleUsed}`,
      `  routes with windowRepeated: ${[...stats.repeatedRoutes].sort().join(' ') || '-'}`,
      `  routes with windowSkipped: ${[...stats.skippedRoutes].sort().join(' ') || '-'}`,
      `  engine time: ${(stats.ms / 1000).toFixed(1)} s`,
    ].join('\n'),
  );
});
