/**
 * Real-track regression: replay recorded flights (tests/fixtures/tracks, see docs/REGRESSION.md) through the
 * in-flight engine and compare with the great-circle + profile model for the same route and times.
 *
 * Tolerances (override with env REAL_TRACK_TOL_MIN, minutes): a prayer-window transition computed along the real
 * track may differ from the great-circle model by up to 25 min. The actual deltas are printed for every fixture
 * so we learn the real error of the model.
 */
import { describe, expect, it } from 'vitest';
import { getAirport } from '../src/data/airports';
import { buildJourney } from '../src/flight/journey';
import { haversineKm, initialBearingDeg } from '../src/geo/geodesy';
import { computeInflight } from '../src/prayer/inflight';
import { DEFAULT_SETTINGS } from '../src/prayer/methods';
import type { FlightLeg, InflightResult, PrayerEvent } from '../src/types';
import tolerances from './fixtures/tolerances.json';
import { loadTrackFixtures, toTrackPoints, type LoadedFixture } from './fixtures/loadFixtures';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const TOL_MIN = Number(env.REAL_TRACK_TOL_MIN) > 0 ? Number(env.REAL_TRACK_TOL_MIN) : 25;
/** Window transitions this close to departure/arrival may legitimately appear in one model and not the other. */
const BOUNDARY_MIN = 10;
/**
 * When the flown route is further than this from the great circle (e.g. EWR-SIN flown over Europe instead of the pole,
 * 4700 km off) the great-circle model is expected to disagree wildly: the comparison is then printed but not asserted.
 */
const COMPARABLE_LATERAL_KM = 600;
/** Sanity bound: a real track should never be this far from the great circle between its airports (mislabelled file). */
const MAX_LATERAL_KM = 7000;
const R_KM = 6371.0088;
const MIN_MS = 60_000;

/** Documented per-fixture exceptions (tests/fixtures/tolerances.json): { "<fixture name>": { toleranceMin, reason } }. */
const KNOWN = tolerances as Record<string, { toleranceMin: number; reason: string }>;

const fixtures = loadTrackFixtures();
const complete = fixtures.filter((f) => f.meta.complete === true);
const partial = fixtures.filter((f) => f.meta.complete !== true);

function legsFor(fx: LoadedFixture): { real: FlightLeg; gc: FlightLeg } {
  const track = toTrackPoints(fx.points);
  const base = {
    flightNumber: fx.meta.flightNumber,
    from: fx.meta.from,
    to: fx.meta.to,
    departureUtc: track[0].time as Date,
    arrivalUtc: track[track.length - 1].time as Date,
  };
  return {
    real: { id: `${fx.name}-real`, ...base, track },
    gc: { id: `${fx.name}-gc`, ...base },
  };
}

const run = (leg: FlightLeg): InflightResult => computeInflight(buildJourney([leg], getAirport), DEFAULT_SETTINGS);

function assertNoNaN(res: InflightResult): void {
  expect(res.samples.length).toBeGreaterThan(0);
  for (const s of res.samples) {
    for (const v of [s.state.lat, s.state.lon, s.state.altitudeM, s.state.headingDeg, s.sunAltitudeDeg, s.sunAzimuthDeg, s.qiblaDeg, s.qiblaRelativeDeg]) {
      if (!Number.isFinite(v)) throw new Error(`non-finite sample value at ${s.state.time.toISOString()}: ${JSON.stringify(s.state)}`);
    }
    expect(Number.isNaN(s.state.time.getTime())).toBe(false);
  }
  for (const e of res.events) {
    expect(Number.isNaN(e.time.getTime())).toBe(false);
    expect(Number.isFinite(e.state.lat) && Number.isFinite(e.state.lon)).toBe(true);
  }
}

const airEvents = (res: InflightResult): PrayerEvent[] => res.events.filter((e) => !e.state.onGround);

/** Distance of p from the great-circle arc a→b (km); beyond the ends: distance to the nearest end. */
function distToArcKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }, p: { lat: number; lon: number }): number {
  const d12 = haversineKm(a, b) / R_KM;
  const d13 = haversineKm(a, p) / R_KM;
  if (d13 === 0) return 0;
  const th13 = (initialBearingDeg(a, p) * Math.PI) / 180;
  const th12 = (initialBearingDeg(a, b) * Math.PI) / 180;
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(th13 - th12))));
  const along = Math.cos(th13 - th12) < 0 ? -1 : Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))));
  if (along < 0) return haversineKm(a, p);
  if (along > d12) return haversineKm(b, p);
  return Math.abs(xt) * R_KM;
}

function lateralDeviation(fx: LoadedFixture): { maxKm: number; meanKm: number } {
  const a = getAirport(fx.meta.from)!;
  const b = getAirport(fx.meta.to)!;
  const d = fx.points.map((p) => distToArcKm(a, b, p));
  return { maxKm: Math.max(...d), meanKm: d.reduce((x, y) => x + y, 0) / d.length };
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const fmtPos = (e: PrayerEvent) => `${Math.abs(e.state.lat).toFixed(1)}${e.state.lat >= 0 ? 'N' : 'S'} ${Math.abs(e.state.lon).toFixed(1)}${e.state.lon >= 0 ? 'E' : 'W'}`;

function snapshotText(fx: LoadedFixture, res: InflightResult): string {
  const lines = [`${fx.meta.flightNumber} ${fx.meta.from}-${fx.meta.to} ${fx.points[0].t} → ${fx.points[fx.points.length - 1].t} (${fx.meta.source}, real track, DEFAULT_SETTINGS)`];
  lines.push(`initial window: ${res.initialWindow}`);
  for (const e of res.events) lines.push(`${e.prayer.padEnd(8)} ${e.time.toISOString().slice(0, 16)}Z  ${fmtPos(e)}${e.anomaly ? `  [${e.anomaly}]` : ''}`);
  return `${lines.join('\n')}\n`;
}

describe('fixture files', () => {
  if (fixtures.length === 0) {
    it('no fixtures yet (run scripts/fixtures/capture-live.ts)', () => expect(fixtures).toHaveLength(0));
  }
  for (const fx of fixtures) {
    it(`${fx.name}: well-formed`, () => {
      expect(fx.meta.attribution.length).toBeGreaterThan(5);
      expect(fx.meta.license.length).toBeGreaterThan(2);
      expect(getAirport(fx.meta.from), `unknown airport ${fx.meta.from}`).toBeDefined();
      expect(getAirport(fx.meta.to), `unknown airport ${fx.meta.to}`).toBeDefined();
      expect(fx.points.length).toBeGreaterThanOrEqual(2);
      let prev = -Infinity;
      for (const p of fx.points) {
        const t = Date.parse(p.t);
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThan(prev);
        prev = t;
        expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
        expect(p.altM).toBeGreaterThanOrEqual(0);
        expect(p.altM).toBeLessThan(20000);
      }
      // thinned to <= 1 point / minute (the last point may be closer)
      const times = fx.points.map((p) => Date.parse(p.t));
      const tooClose = times.slice(1, -1).filter((t, i) => t - times[i] < MIN_MS - 1);
      expect(tooClose).toHaveLength(0);
    });
  }
});

describe('real tracks vs great-circle model', () => {
  if (complete.length === 0) {
    it('no complete fixtures available yet: nothing to compare (run scripts/fixtures/capture-live.ts --watch)', () => {
      expect(complete).toHaveLength(0);
    });
  }

  for (const fx of complete) {
    describe(fx.name, () => {
      const { real, gc } = legsFor(fx);
      const realRes = run(real);
      const gcRes = run(gc);

      it('has no NaN anywhere', () => {
        assertNoNaN(realRes);
        assertNoNaN(gcRes);
      });

      const tolMin = Math.max(TOL_MIN, KNOWN[fx.name]?.toleranceMin ?? 0);
      const dev0 = lateralDeviation(fx);
      const comparable = dev0.maxKm <= COMPARABLE_LATERAL_KM;
      it(`prayer windows opened in the air match (tolerance ${tolMin} min${comparable ? '' : `; informational: route ${Math.round(dev0.maxKm)} km off the great circle`})`, () => {
        const dep = real.departureUtc.getTime();
        const arr = real.arrivalUtc.getTime();
        const nearBoundary = (e: PrayerEvent) =>
          Math.abs(e.time.getTime() - dep) <= BOUNDARY_MIN * MIN_MS || Math.abs(e.time.getTime() - arr) <= BOUNDARY_MIN * MIN_MS;
        const r = airEvents(realRes).filter((e) => !nearBoundary(e));
        const g = airEvents(gcRes).filter((e) => !nearBoundary(e));

        const lines = [`\n[${fx.name}] ${fx.meta.from}→${fx.meta.to}, ${((arr - dep) / 3_600_000).toFixed(2)} h, ${fx.points.length} pts, largest source gap ${fx.meta.maxGapMin ?? '?'} min`];
        if (KNOWN[fx.name]) lines.push(`  known deviation, tolerance ${tolMin} min: ${KNOWN[fx.name].reason}`);
        const dev = lateralDeviation(fx);
        lines.push(`  lateral deviation from great circle: max ${dev.maxKm.toFixed(0)} km, mean ${dev.meanKm.toFixed(0)} km`);
        const n = Math.max(r.length, g.length);
        for (let i = 0; i < n; i++) {
          const a = r[i], b = g[i];
          const delta = a && b ? (a.time.getTime() - b.time.getTime()) / MIN_MS : NaN;
          lines.push(
            `  ${(a?.prayer ?? '-').padEnd(8)} real ${a ? hhmm(a.time) : '--:--'}  gc ${b ? hhmm(b.time) : '--:--'}  Δ ${Number.isNaN(delta) ? 'n/a' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} min`}` +
              `${a && b && a.prayer !== b.prayer ? `  (gc: ${b.prayer})` : ''}`,
          );
        }
        if (n === 0) lines.push('  (no prayer window transitions in the air)');
        console.log(lines.join('\n'));

        if (!comparable) {
          console.log(`  → not asserted: the real route is up to ${dev.maxKm.toFixed(0)} km from the great circle (> ${COMPARABLE_LATERAL_KM} km)`);
          return;
        }
        expect(r.map((e) => e.prayer), 'sequence of windows opened in the air').toEqual(g.map((e) => e.prayer));
        for (let i = 0; i < r.length; i++) {
          const delta = Math.abs(r[i].time.getTime() - g[i].time.getTime()) / MIN_MS;
          expect(delta, `${r[i].prayer} real vs great-circle`).toBeLessThanOrEqual(tolMin);
        }
      });

      it(`stays within ${MAX_LATERAL_KM} km of the great circle (sanity)`, () => {
        const dev = lateralDeviation(fx);
        expect(Number.isFinite(dev.maxKm)).toBe(true);
        expect(dev.maxKm).toBeLessThan(MAX_LATERAL_KM);
      });

      it('real-track events match the stored snapshot', async () => {
        await expect(snapshotText(fx, realRes)).toMatchFileSnapshot(`./fixtures/snapshots/${fx.name}.events.txt`);
      });
    });
  }
});

describe.skipIf(partial.length === 0)('partial tracks', () => {
  if (partial.length === 0) it('none', () => undefined);
  for (const fx of partial) {
    it(`${fx.name}: engine runs without NaN`, () => {
      const { real } = legsFor(fx);
      assertNoNaN(run(real));
    });
  }
});
