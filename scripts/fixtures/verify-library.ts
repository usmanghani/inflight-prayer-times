/**
 * Verify every FLIGHT_LIBRARY entry against adsbdb.com (callsign → origin/destination).
 *
 *   npx vite-node scripts/fixtures/verify-library.ts [--limit N] [--no-docs] [--refresh]
 *
 * Writes tests/fixtures/library-verification.json and the "Library verification" section of docs/REGRESSION.md.
 * Does NOT modify src/data/flights.ts: fix mismatches by hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLIGHT_LIBRARY } from '../../src/data/flights';
import { parseArgs, has, num } from './lib/args';
import { IATA_TO_ICAO_AIRLINE, splitFlightNumber, toIcaoCallsign, unmappedLibraryAirlines } from './lib/airlines';
import { replaceDocSection } from './lib/docsSection';
import { FIXTURE_ROOT } from './lib/fixture';
import { lookupCallsign, type AdsbdbLookup } from './sources/adsbdb';

type Status = 'match' | 'mismatch' | 'not-found' | 'error';

interface Row {
  flightNumber: string;
  libraryRoute: string;
  adsbdbRoute: string | null;
  status: Status;
  checkedAt: string;
  /** mismatch only: same city pair in the opposite direction, or a different pair altogether */
  mismatchKind?: 'reversed' | 'different-route';
  /** which identifier found the route */
  via?: string;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const limit = num(args, 'limit');
  const ttl = has(args, 'refresh') ? 0 : undefined;
  const flights = FLIGHT_LIBRARY.slice(0, limit ?? FLIGHT_LIBRARY.length);

  const unmapped = unmappedLibraryAirlines();
  if (unmapped.length) console.warn(`! airlines without ICAO mapping: ${unmapped.join(', ')} (IATA callsign fallback only)`);

  const rows: Row[] = [];
  let i = 0;
  for (const fl of flights) {
    i++;
    const libraryRoute = `${fl.from}-${fl.to}`;
    const icao = toIcaoCallsign(fl.flightNumber);
    const tried: [string, AdsbdbLookup][] = [];
    if (icao) tried.push([icao, await lookupCallsign(icao, ttl)]);
    if (!tried[0] || tried[0][1].status === 'not-found') tried.push([fl.flightNumber, await lookupCallsign(fl.flightNumber, ttl)]);

    const found = tried.find(([, r]) => r.status === 'ok');
    const checkedAt = new Date().toISOString();
    let row: Row;
    if (found && found[1].status === 'ok') {
      const r = found[1].route;
      const adsbdbRoute = `${r.originIata ?? '?'}-${r.destinationIata ?? '?'}`;
      const status: Status = adsbdbRoute === libraryRoute ? 'match' : 'mismatch';
      const reversed = adsbdbRoute === `${fl.to}-${fl.from}`;
      row = { flightNumber: fl.flightNumber, libraryRoute, adsbdbRoute, status, ...(status === 'mismatch' ? { mismatchKind: reversed ? 'reversed' : 'different-route' } : {}), checkedAt, via: found[0] };
    } else if (tried.some(([, r]) => r.status === 'error')) {
      const e = tried.find(([, r]) => r.status === 'error')![1];
      row = { flightNumber: fl.flightNumber, libraryRoute, adsbdbRoute: null, status: 'error', checkedAt, error: e.status === 'error' ? e.error : undefined };
    } else {
      row = { flightNumber: fl.flightNumber, libraryRoute, adsbdbRoute: null, status: 'not-found', checkedAt };
    }
    rows.push(row);
    if (row.status !== 'match' || i % 25 === 0) {
      console.log(`[${i}/${flights.length}] ${fl.flightNumber} ${libraryRoute} → ${row.status}${row.adsbdbRoute ? ` (adsbdb ${row.adsbdbRoute})` : ''}${row.error ? ` ${row.error}` : ''}`);
    }
  }

  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  console.log(`\nmatch ${count('match')} · mismatch ${count('mismatch')} · not-found ${count('not-found')} · error ${count('error')} (of ${rows.length})`);

  mkdirSync(FIXTURE_ROOT, { recursive: true });
  writeFileSync(
    join(FIXTURE_ROOT, 'library-verification.json'),
    `${JSON.stringify({ source: 'api.adsbdb.com', checkedAt: new Date().toISOString(), rows }, null, 1)}\n`,
  );

  if (!has(args, 'no-docs') && limit === undefined) replaceDocSection('LIBRARY-VERIFICATION', docSection(rows));
}

function docSection(rows: Row[]): string {
  const count = (s: Status, rs = rows) => rs.filter((r) => r.status === s).length;
  const date = rows[0]?.checkedAt.slice(0, 10) ?? '';
  const out: string[] = [];
  out.push('## Library verification', '');
  out.push(
    `Every \`FLIGHT_LIBRARY\` entry was looked up on [adsbdb.com](https://www.adsbdb.com) by ICAO callsign (IATA number as fallback) on ${date}, ` +
      'and the origin/destination was compared with the library. Raw data: `tests/fixtures/library-verification.json`. ' +
      'adsbdb is crowd-sourced and describes the route *currently* associated with a callsign, so a `mismatch` means "check this", not necessarily "wrong"; ' +
      '`not-found` usually means the flight is seasonal/retired or simply missing from adsbdb.',
    '',
    `**${count('match')} match · ${count('mismatch')} mismatch · ${count('not-found')} not found · ${count('error')} error** (of ${rows.length}).`,
    '',
  );
  // per airline
  const airlines = [...new Set(rows.map((r) => splitFlightNumber(r.flightNumber)?.airline ?? '??'))].sort();
  out.push('| Airline | ICAO | Flights | Match | Mismatch | Not found | Error |', '|---|---|---:|---:|---:|---:|---:|');
  for (const a of airlines) {
    const rs = rows.filter((r) => splitFlightNumber(r.flightNumber)?.airline === a);
    out.push(`| ${a} | ${IATA_TO_ICAO_AIRLINE[a] ?? '?'} | ${rs.length} | ${count('match', rs)} | ${count('mismatch', rs)} | ${count('not-found', rs)} | ${count('error', rs)} |`);
  }
  out.push('');
  const bad = rows.filter((r) => r.status === 'mismatch');
  if (bad.length) {
    const rev = bad.filter((r) => r.mismatchKind === 'reversed').length;
    out.push(
      '### Mismatches', '',
      `${rev} are the same city pair in the opposite direction (the library numbers the two directions the other way round, or adsbdb has it inverted), ` +
        `${bad.length - rev} are a different pair (seasonal re-routing, retimed / renumbered flight, or a wrong adsbdb entry). Verify against an airline timetable before changing the library.`,
      '', '| Flight | Library | adsbdb | Kind |', '|---|---|---|---|',
    );
    for (const r of bad) out.push(`| ${r.flightNumber} | ${r.libraryRoute} | ${r.adsbdbRoute} | ${r.mismatchKind === 'reversed' ? 'reversed' : 'different'} |`);
    out.push('');
  }
  const nf = rows.filter((r) => r.status === 'not-found' || r.status === 'error');
  if (nf.length) {
    out.push(`<details><summary>Not found / error (${nf.length})</summary>`, '', '| Flight | Library route | Status |', '|---|---|---|');
    for (const r of nf) out.push(`| ${r.flightNumber} | ${r.libraryRoute} | ${r.status}${r.error ? `: ${r.error}` : ''} |`);
    out.push('', '</details>', '');
  }
  out.push(`<details><summary>All ${rows.length} flights</summary>`, '', '| Flight | Library | adsbdb | Status |', '|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.flightNumber} | ${r.libraryRoute} | ${r.adsbdbRoute ?? ''} | ${r.status} |`);
  out.push('', '</details>');
  return out.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
