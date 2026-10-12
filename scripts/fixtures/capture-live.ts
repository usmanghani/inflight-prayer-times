/**
 * Capture real tracks of library flights that are airborne right now (adsb.lol, ODbL).
 *
 *   NODE_USE_ENV_PROXY=1 npx vite-node scripts/fixtures/capture-live.ts [--watch <minutes>] [--flight EK1,QR8] [--poll <minutes>]
 *
 * One pass: scan every library flight's callsign on adsb.lol, and for each airborne aircraft download the full
 * trace, cut the segment belonging to this flight and save a (partial) fixture.
 * --all: scan every library flight, not just those scheduled around now (slow: ~1 req/s, ~4 min).
 * --watch N: keep polling (default every 5 min) for N minutes; flights that have landed are re-saved with their
 * complete track (complete: true when the track runs origin → destination without a coverage hole > 6 h).
 */
import { FLIGHT_LIBRARY, libraryFlightToLeg, normalizeFlightNumber, type LibraryFlight } from '../../src/data/flights';
import { allAirports, getAirport } from '../../src/data/airports';
import { haversineKm } from '../../src/geo/geodesy';
import { parseArgs, num, str } from './lib/args';
import { toIcaoCallsign } from './lib/airlines';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixture, readFixture, saveFixture, TRACK_DIR, type RawPoint } from './lib/fixture';
import { mergePoints, pickRun, splitRuns } from './lib/tar1090';
import { lookupCallsign } from './sources/adsbdb';
import { fetchTrace, isAirborne, liveByCallsign, type LiveAircraft } from './sources/adsblol';

interface Tracked {
  flight: LibraryFlight;
  callsign: string;
  hex: string;
  from: string;
  to: string;
  notes: string[];
  lastSeenMs: number;
  points: RawPoint[];
  registration?: string;
  type?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const min = (ms: number) => Math.round(ms / 60000);

async function resolveRoute(fl: LibraryFlight, callsign: string): Promise<{ from: string; to: string; notes: string[] }> {
  const notes: string[] = [];
  const r = await lookupCallsign(callsign);
  if (r.status === 'ok' && r.route.originIata && r.route.destinationIata && getAirport(r.route.originIata) && getAirport(r.route.destinationIata)) {
    if (r.route.originIata !== fl.from || r.route.destinationIata !== fl.to) {
      notes.push(`adsbdb route ${r.route.originIata}-${r.route.destinationIata} differs from library ${fl.from}-${fl.to}; fixture uses the adsbdb route`);
    }
    return { from: r.route.originIata, to: r.route.destinationIata, notes };
  }
  notes.push('route taken from the library (adsbdb has no usable route)');
  return { from: fl.from, to: fl.to, notes };
}

function nearestAirport(p: { lat: number; lon: number }, maxKm: number): string | undefined {
  let best: string | undefined;
  let bestKm = maxKm;
  for (const a of allAirports()) {
    const d = haversineKm(a, p);
    if (d < bestKm) { bestKm = d; best = a.iata; }
  }
  return best;
}

/** Download the trace for a tracked aircraft, update its points and save the fixture. */
async function capture(tr: Tracked, airborneNow: boolean, nearMs: number): Promise<{ saved: string; complete: boolean } | null> {
  const { points, error } = await fetchTrace(tr.hex, airborneNow ? 60_000 : 0);
  if (error || points.length === 0) {
    console.warn(`  ! ${tr.flight.flightNumber}: trace unavailable (${error ?? 'empty'})`);
    return null;
  }
  const run = pickRun(splitRuns(points), tr.callsign, nearMs);
  if (!run) {
    console.warn(`  ! ${tr.flight.flightNumber}: no airborne segment found in trace`);
    return null;
  }
  tr.points = tr.points.length && tr.points[0].t < run.startMs ? mergePoints(tr.points, run.points) : run.points;
  // A flight that has landed tells us its real route: first/last point on the ground at an airport.
  if (!airborneNow && tr.points.length > 1) {
    const a = nearestAirport(tr.points[0], 15);
    const b = nearestAirport(tr.points[tr.points.length - 1], 15);
    if (a && b && (a !== tr.from || b !== tr.to)) {
      tr.notes = [...tr.notes.filter((n) => !n.startsWith('route from track')), `route from track ${a}-${b} (library/adsbdb said ${tr.from}-${tr.to})`];
      tr.from = a;
      tr.to = b;
    }
  }
  const fx = buildFixture({
    flightNumber: normalizeFlightNumber(tr.flight.flightNumber),
    callsign: tr.callsign,
    from: tr.from,
    to: tr.to,
    source: 'adsblol',
    points: tr.points,
    icao24: tr.hex,
    forcePartial: airborneNow,
    notes: [
      ...tr.notes,
      ...(tr.registration ? [`aircraft ${tr.registration}${tr.type ? ` (${tr.type})` : ''}`] : []),
      ...(airborneNow ? ['captured while airborne'] : []),
      ...(run.maxGapMin > 30 ? [`coverage hole(s), largest ${min(run.maxGapMin * 60000)} min (linear interpolation across them)`] : []),
    ],
  });
  const res = saveFixture(fx);
  console.log(
    `  ${res.action.padEnd(13)} ${tr.flight.flightNumber} ${tr.from}-${tr.to} ${fx.meta.date} ${res.points} pts ${res.complete ? 'COMPLETE' : 'partial'}` +
      `${fx.meta.notes?.includes('partial:') ? ` (${fx.meta.notes.split('partial: ')[1]?.split(' | ')[0]})` : ''}`,
  );
  return { saved: res.path, complete: res.complete };
}

/**
 * Library flights whose scheduled airborne window (± `slackH` hours, the library times are representative, not live
 * schedules) contains `nowMs`. Cuts a scan from ~220 lookups to a few dozen.
 */
function plausiblyAirborne(flights: LibraryFlight[], nowMs: number, slackH = 1.5): LibraryFlight[] {
  const day = (offset: number) => new Date(nowMs + offset * 86_400_000).toISOString().slice(0, 10);
  return flights.filter((fl) =>
    [-1, 0, 1].some((o) => {
      try {
        const leg = libraryFlightToLeg(fl, day(o), getAirport);
        return leg.departureUtc.getTime() - slackH * 3_600_000 <= nowMs && nowMs <= leg.arrivalUtc.getTime() + slackH * 3_600_000;
      } catch { return false; }
    }),
  );
}

/**
 * Partial adsb.lol fixtures saved by earlier runs (< 2 days old) are put back under observation: if their flight has
 * landed meanwhile, the full trace completes them.
 */
function reviveSaved(only: string[] | undefined): Map<string, Tracked> {
  const out = new Map<string, Tracked>();
  let files: string[] = [];
  try { files = readdirSync(TRACK_DIR).filter((f) => f.endsWith('_adsblol.json')); } catch { /* no fixtures yet */ }
  for (const f of files) {
    const fx = readFixture(join(TRACK_DIR, f));
    if (!fx || fx.meta.complete || !fx.meta.icao24) continue;
    const fl = FLIGHT_LIBRARY.find((l) => normalizeFlightNumber(l.flightNumber) === fx.meta.flightNumber);
    const lastMs = Date.parse(fx.points[fx.points.length - 1].t);
    if (!fl || Date.now() - lastMs > 2 * 86_400_000 || (only && !only.includes(fx.meta.flightNumber))) continue;
    out.set(fl.flightNumber, { flight: fl, callsign: fx.meta.callsign, hex: fx.meta.icao24, from: fx.meta.from, to: fx.meta.to, notes: [], lastSeenMs: lastMs, points: [] });
  }
  return out;
}

async function scan(candidates: LibraryFlight[]): Promise<Map<string, { fl: LibraryFlight; callsign: string; ac: LiveAircraft }>> {
  const found = new Map<string, { fl: LibraryFlight; callsign: string; ac: LiveAircraft }>();
  let errors = 0;
  let n = 0;
  for (const fl of candidates) {
    if (++n % 50 === 0) console.log(`  …${n}/${candidates.length}`);
    const callsign = toIcaoCallsign(fl.flightNumber);
    if (!callsign) continue;
    const { aircraft, error } = await liveByCallsign(callsign);
    if (error) { errors++; continue; }
    // several aircraft can share a callsign (rare): take the first airborne one
    const ac = aircraft.find((a) => isAirborne(a) && a.flight.toUpperCase() === callsign);
    if (ac) found.set(`${fl.flightNumber}`, { fl, callsign, ac });
  }
  if (errors) console.warn(`  ! ${errors} live lookups failed`);
  return found;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const watchMin = num(args, 'watch') ?? 0;
  const pollMin = num(args, 'poll') ?? 5;
  const fullEvery = num(args, 'full-every') ?? 6;
  const only = str(args, 'flight')?.split(',').map(normalizeFlightNumber);
  const candidates = FLIGHT_LIBRARY.filter((f) => !only || only.includes(normalizeFlightNumber(f.flightNumber)));
  const deadline = Date.now() + watchMin * 60000;
  const tracked = reviveSaved(only);
  if (tracked.size) console.log(`resuming ${tracked.size} partial fixture(s) from earlier runs: ${[...tracked.keys()].join(', ')}`);
  const finished: { flight: string; complete: boolean; path: string }[] = [];
  let pass = 0;

  for (;;) {
    pass++;
    const started = Date.now();
    console.log(`\n[${new Date().toISOString()}] pass ${pass}: scanning adsb.lol…`);
    // Full scan on the first pass and every `fullEvery` passes; in between only the flights already being tracked
    // (adsb.lol rate-limits us to roughly one lookup per 1.5-3 s, so a full scan takes ~15 min).
    const fullScan = pass === 1 || pass % fullEvery === 0 || tracked.size === 0;
    const scanList = !fullScan
      ? [...tracked.values()].map((t) => t.flight)
      : [...new Set([...(args.flags.all || only ? candidates : plausiblyAirborne(candidates, Date.now())), ...[...tracked.values()].map((t) => t.flight)])];
    console.log(`  ${fullScan ? 'full scan of' : 'tracked flights only:'} ${scanList.length} flights${fullScan && !args.flags.all && !only ? ' scheduled around now (--all scans the whole library)' : ''}`);
    const live = await scan(scanList);
    console.log(`  ${live.size} airborne: ${[...live.keys()].join(', ') || 'none'}`);

    // 1. currently airborne: (re)capture partial tracks
    for (const [key, { fl, callsign, ac }] of live) {
      let tr = tracked.get(key);
      if (!tr || tr.hex !== ac.hex) {
        const route = await resolveRoute(fl, callsign);
        tr = { flight: fl, callsign, hex: ac.hex, from: route.from, to: route.to, notes: route.notes, lastSeenMs: ac.nowMs, points: [], registration: ac.registration, type: ac.type };
        tracked.set(key, tr);
      }
      tr.lastSeenMs = ac.nowMs;
      await capture(tr, true, ac.nowMs);
    }

    // 2. tracked but no longer airborne: landed (or lost coverage)
    for (const [key, tr] of [...tracked]) {
      if (live.has(key)) continue;
      if (!scanList.some((f) => f.flightNumber === tr.flight.flightNumber)) continue; // not looked up this pass
      const r = await capture(tr, false, tr.lastSeenMs);
      const unseen = Date.now() - tr.lastSeenMs;
      if (r?.complete) {
        console.log(`  ✓ ${tr.flight.flightNumber} landed: complete track saved`);
        finished.push({ flight: tr.flight.flightNumber, complete: true, path: r.saved });
        tracked.delete(key);
      } else if (unseen > 90 * 60000) {
        console.log(`  - ${tr.flight.flightNumber}: unseen for ${min(unseen)} min, keeping the partial track`);
        if (r) finished.push({ flight: tr.flight.flightNumber, complete: false, path: r.saved });
        tracked.delete(key);
      }
    }

    if (watchMin <= 0 || Date.now() + pollMin * 60000 > deadline) break;
    const wait = started + pollMin * 60000 - Date.now();
    if (wait > 0) { console.log(`  sleeping ${Math.round(wait / 1000)} s…`); await sleep(wait); }
  }

  // watch window over: final save of whatever is still being tracked
  for (const tr of tracked.values()) {
    const r = watchMin > 0 ? await capture(tr, Date.now() - tr.lastSeenMs < 6 * 60000, tr.lastSeenMs) : { saved: '', complete: false };
    if (r) finished.push({ flight: tr.flight.flightNumber, complete: r.complete, path: r.saved });
  }
  tracked.clear();
  console.log('\nSummary:');
  if (finished.length === 0 && tracked.size === 0) console.log('  nothing captured.');
  for (const f of finished) console.log(`  ${f.flight}: ${f.complete ? 'complete' : 'partial'}`);
  for (const tr of tracked.values()) if (!finished.some((f) => f.flight === tr.flight.flightNumber)) console.log(`  ${tr.flight.flightNumber}: partial (still airborne)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
