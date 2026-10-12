/**
 * Find real flight numbers for a route by scanning adsbdb.com callsign lookups.
 *
 *   NODE_USE_ENV_PROXY=1 npx vite-node scripts/fixtures/find-flights.ts <target>... [options]
 *
 * A target is `AIRLINE:FROM:TO[:AROUND]`, e.g. `EK:DXB:EWR:221` (IATA airline code, IATA airports).
 * Every flight number in AROUND ± SPAN (default 40; AROUND defaults to 1 and the span to 999, i.e. 1..999) is looked up
 * by ICAO callsign (UAE221 …), plus `--extra 1201,6250` for numbers outside the window and `--range 600-700`.
 * Because the lookup is cached on disk (7 days) a window scanned once is free the next time, so related targets
 * (both directions, neighbouring routes of the same airline) cost nothing extra.
 *
 * Output per target:
 *   exact    numbers whose adsbdb route is FROM-TO   (use these)
 *   reverse  numbers whose adsbdb route is TO-FROM   (the paired return flight, handy to confirm the numbering pair)
 *   related  numbers that touch FROM or TO but go somewhere else (hints at the airline's real hub / city choice)
 * `--list` prints every route found in the window, which is how alternative cities are discovered.
 * Requests go through lib/http.ts: <= 2 req/s per host, retries, on-disk cache.
 */
import { parseArgs, has, num, str } from './lib/args';
import { IATA_TO_ICAO_AIRLINE } from './lib/airlines';
import { lookupCallsign, type AdsbdbRoute } from './sources/adsbdb';

interface Hit { number: number; callsign: string; route: AdsbdbRoute; key: string }

const cache = new Map<string, Hit | null>();
const printed = new Set<string>();

async function scanNumber(icao: string, n: number, ttl: number | undefined): Promise<Hit | null> {
  const callsign = `${icao}${n}`;
  if (cache.has(callsign)) return cache.get(callsign) ?? null;
  const r = await lookupCallsign(callsign, ttl);
  let hit: Hit | null = null;
  if (r.status === 'ok') {
    hit = { number: n, callsign, route: r.route, key: `${r.route.originIata ?? '?'}-${r.route.destinationIata ?? '?'}` };
  } else if (r.status === 'error') {
    console.warn(`  ! ${callsign}: ${r.error}`);
  }
  cache.set(callsign, hit);
  return hit;
}

function candidates(around: number | undefined, span: number, range: string | undefined, extra: string | undefined): number[] {
  const out = new Set<number>();
  if (range) {
    const [a, b] = range.split('-').map(Number);
    for (let n = a; n <= b; n++) out.add(n);
  } else if (around === undefined) {
    for (let n = 1; n <= 999; n++) out.add(n);
  } else {
    for (let n = Math.max(1, around - span); n <= Math.min(9999, around + span); n++) out.add(n);
  }
  if (extra) for (const s of extra.split(',')) if (s.trim()) out.add(Number(s));
  return [...out].filter((n) => Number.isInteger(n) && n >= 1 && n <= 9999).sort((x, y) => x - y);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args._.length) {
    console.error('usage: find-flights.ts AIRLINE:FROM:TO[:AROUND] ... [--span 40] [--range a-b] [--extra n,n] [--list] [--refresh]');
    process.exit(2);
  }
  const span = num(args, 'span') ?? 40;
  const ttl = has(args, 'refresh') ? 0 : undefined;
  const list = has(args, 'list');

  for (const target of args._) {
    const [airline, from, to, aroundStr] = target.toUpperCase().split(':');
    if (!airline || !from || !to) { console.error(`bad target "${target}"`); continue; }
    const icao = IATA_TO_ICAO_AIRLINE[airline];
    if (!icao) { console.error(`no ICAO mapping for airline ${airline} (add it to lib/airlines.ts)`); continue; }
    const around = aroundStr ? Number(aroundStr) : undefined;
    const nums = candidates(around, span, str(args, 'range'), str(args, 'extra'));
    const hits: Hit[] = [];
    for (const n of nums) {
      const h = await scanNumber(icao, n, ttl);
      if (h) hits.push(h);
    }
    const exact = hits.filter((h) => h.key === `${from}-${to}`);
    const reverse = hits.filter((h) => h.key === `${to}-${from}`);
    const related = hits.filter((h) => h.key !== `${from}-${to}` && h.key !== `${to}-${from}`
      && [h.route.originIata, h.route.destinationIata].some((c) => c === from || c === to));
    console.log(`\n== ${airline} ${from}-${to}  (scanned ${nums.length} numbers ${nums[0]}..${nums[nums.length - 1]}, ${hits.length} known callsigns)`);
    console.log(`  exact   : ${exact.map((h) => `${airline}${h.number}`).join(', ') || '(none)'}`);
    console.log(`  reverse : ${reverse.map((h) => `${airline}${h.number}`).join(', ') || '(none)'}`);
    if (list) {
      // compact: 5 per line, once per airline and window (several targets share the same scan)
      const sig = `${airline} ${nums[0]}-${nums[nums.length - 1]}`;
      if (!printed.has(sig)) {
        printed.add(sig);
        console.log('  all routes found:');
        for (let i = 0; i < hits.length; i += 5) {
          console.log(`    ${hits.slice(i, i + 5).map((h) => `${airline}${h.number} ${h.key}`).join('  |  ')}`);
        }
      }
    } else if (related.length) {
      console.log(`  related : ${related.map((h) => `${airline}${h.number} ${h.key}`).join(', ')}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
