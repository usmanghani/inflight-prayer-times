/**
 * Fetch historical tracks (needs credentials; sources without credentials are skipped with a message).
 *
 *   NODE_USE_ENV_PROXY=1 npx vite-node scripts/fixtures/fetch-history.ts --date 2026-10-10 [--flight EK226[,QR8]] [--source opensky|flightaware] [--max N]
 *
 *   OpenSky      env OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET   (free account; /flights/departure + /tracks/all)
 *   FlightAware  env FLIGHTAWARE_API_KEY                         (AeroAPI /flights/{ident} + /flights/{id}/track)
 *
 * Without --flight, every library flight is tried (--max caps the number of flights, useful with paid APIs).
 * `--date` is the UTC date of departure. Tracks that run origin → destination without a big hole are marked complete.
 */
import { FLIGHT_LIBRARY, normalizeFlightNumber } from '../../src/data/flights';
import { has, num, parseArgs, str } from './lib/args';
import { toIcaoCallsign } from './lib/airlines';
import { buildFixture, saveFixture, type RawPoint } from './lib/fixture';
import * as flightaware from './sources/flightaware';
import * as opensky from './sources/opensky';

type SourceId = 'opensky' | 'flightaware';

async function main(): Promise<void> {
  const args = parseArgs();
  const date = str(args, 'date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || has(args, 'help')) {
    console.log('usage: fetch-history.ts --date YYYY-MM-DD [--flight EK226[,QR8]] [--source opensky|flightaware] [--max N]');
    process.exit(date ? 0 : 1);
  }
  const wanted = str(args, 'source');
  if (wanted && wanted !== 'opensky' && wanted !== 'flightaware') throw new Error(`unknown --source "${wanted}" (opensky | flightaware)`);
  const sources: SourceId[] = (wanted ? [wanted] : ['opensky', 'flightaware']) as SourceId[];

  const active: SourceId[] = [];
  for (const s of sources) {
    const mod = s === 'opensky' ? opensky : flightaware;
    if (mod.isConfigured()) active.push(s);
    else console.log(mod.missingMessage);
  }
  if (active.length === 0) {
    console.log('No source with credentials: nothing to do. (capture-live.ts needs no credentials but only sees flights airborne now.)');
    return;
  }

  const only = str(args, 'flight')?.split(',').map(normalizeFlightNumber);
  let flights = FLIGHT_LIBRARY.filter((f) => !only || only.includes(normalizeFlightNumber(f.flightNumber)));
  if (only) {
    const unknown = only.filter((n) => !FLIGHT_LIBRARY.some((f) => normalizeFlightNumber(f.flightNumber) === n));
    if (unknown.length) console.warn(`! not in the library (skipped): ${unknown.join(', ')}`);
  }
  const max = num(args, 'max');
  if (max !== undefined) flights = flights.slice(0, max);

  let saved = 0, complete = 0, missing = 0, failed = 0;
  for (const fl of flights) {
    const callsign = toIcaoCallsign(fl.flightNumber);
    if (!callsign) { console.warn(`! ${fl.flightNumber}: no ICAO airline mapping`); continue; }
    const flightNumber = normalizeFlightNumber(fl.flightNumber);
    for (const s of [...active]) {
      try {
        let points: RawPoint[] = [];
        let icao24: string | undefined;
        let notes: string[] = [];
        if (s === 'opensky') {
          const r = await opensky.fetchFlightTrack({ flightNumber, callsign, from: fl.from, to: fl.to, date });
          if (r) ({ points, icao24, notes } = r);
        } else {
          const r = await flightaware.fetchFlightTrack({ flightNumber, callsign, from: fl.from, to: fl.to, date });
          if (r) ({ points, notes } = r);
        }
        if (points.length < 2) { missing++; console.log(`  ${flightNumber} ${date} ${s}: no track`); continue; }
        const fx = buildFixture({ flightNumber, callsign, from: fl.from, to: fl.to, source: s, points, icao24, notes });
        const res = saveFixture(fx);
        saved++;
        if (res.complete) complete++;
        console.log(`  ${res.action.padEnd(13)} ${flightNumber} ${fl.from}-${fl.to} ${fx.meta.date} ${s} ${res.points} pts ${res.complete ? 'COMPLETE' : 'partial'}`);
      } catch (e) {
        failed++;
        console.warn(`  ! ${flightNumber} ${s}: ${(e as Error).message}`);
        if (/token request failed|HTTP 40[13]/.test((e as Error).message)) { console.warn('  credentials or plan problem: stopping this source.'); active.splice(active.indexOf(s), 1); }
      }
    }
    if (active.length === 0) break;
  }
  console.log(`\nsaved ${saved} (${complete} complete), no data ${missing}, failed ${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
