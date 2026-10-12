/**
 * tar1090 / readsb trace format (globe.adsb.lol `trace_full_<hex>.json`):
 *   { icao, timestamp, trace: [[dtSec, lat, lon, altFt | 'ground' | null, gs, track, flags, vrate, detail|null, ...]] }
 * Altitude is barometric feet. `detail` (sparse) carries { flight: 'UAE226  ', ... }.
 */
import { haversineKm } from '../../../src/geo/geodesy';
import { ftToM, type RawPoint } from './fixture';

export interface Tar1090Trace {
  icao?: string;
  r?: string;
  t?: string;
  timestamp?: number;
  trace?: unknown[][];
}

export function parseTrace(json: Tar1090Trace): RawPoint[] {
  const base = json.timestamp;
  if (typeof base !== 'number' || !Array.isArray(json.trace)) return [];
  const out: RawPoint[] = [];
  let callsign: string | undefined;
  for (const row of json.trace) {
    const dt = row[0], lat = row[1], lon = row[2], alt = row[3];
    if (typeof dt !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const detail = row[8] as { flight?: string } | null | undefined;
    if (detail && typeof detail === 'object' && typeof detail.flight === 'string' && detail.flight.trim()) callsign = detail.flight.trim();
    const ground = alt === 'ground';
    out.push({
      t: Math.round((base + dt) * 1000),
      lat, lon,
      altM: ground ? null : typeof alt === 'number' ? ftToM(alt) : null,
      ground,
      ...(callsign ? { callsign } : {}),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface Run {
  /** Airborne points plus one ground point on each side when present. */
  points: RawPoint[];
  startMs: number;
  endMs: number;
  /** Callsigns seen in the run (from sparse detail records). */
  callsigns: Set<string>;
  /** Largest time gap inside the run, minutes. */
  maxGapMin: number;
}

const MIN = 60_000;

/**
 * Is the gap between two airborne fixes just lost coverage (same flight), rather than a landing + new flight?
 * Plausible when both sides are airborne and the implied ground speed is airliner-like.
 */
function isCoverageGap(a: RawPoint, b: RawPoint): boolean {
  if (a.ground || b.ground) return false;
  const hours = (b.t - a.t) / 3_600_000;
  const kmh = haversineKm(a, b) / hours;
  return kmh >= 300 && kmh <= 1100;
}

/**
 * Cut a day-long trace into individual flights: maximal airborne runs, split at ground contact and at gaps
 * > `gapMin` minutes that are not plausible coverage holes. Each run is extended by one ground point on each side.
 */
export function splitRuns(points: RawPoint[], gapMin = 30): Run[] {
  const runs: Run[] = [];
  let cur: RawPoint[] = [];
  const flush = (trailingGround?: RawPoint) => {
    if (cur.some((p) => !p.ground) ) {
      if (trailingGround) cur.push(trailingGround);
      runs.push(mkRun(cur));
    }
    cur = [];
  };
  let lastGround: RawPoint | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (p.ground) {
      if (cur.length) { flush(p); }
      lastGround = p;
      continue;
    }
    if (prev && cur.length && p.t - prev.t > gapMin * MIN && !isCoverageGap(prev, p)) flush();
    if (!cur.length && lastGround && prev === lastGround && p.t - lastGround.t <= gapMin * MIN) cur.push(lastGround);
    cur.push(p);
  }
  flush();
  return runs;
}

function mkRun(points: RawPoint[]): Run {
  let maxGap = 0;
  const callsigns = new Set<string>();
  points.forEach((p, i) => {
    if (p.callsign) callsigns.add(p.callsign);
    if (i > 0) maxGap = Math.max(maxGap, (p.t - points[i - 1].t) / MIN);
  });
  return { points: points.slice(), startMs: points[0].t, endMs: points[points.length - 1].t, callsigns, maxGapMin: maxGap };
}

/**
 * Pick the run belonging to the flight we are interested in: callsign must match when the run carries callsign info,
 * and among those the run closest in time to `nearMs` (distance 0 when it contains it; ties → later run).
 */
export function pickRun(runs: Run[], callsign: string, nearMs: number): Run | undefined {
  const want = callsign.toUpperCase();
  const ok = runs.filter((r) => r.callsigns.size === 0 || [...r.callsigns].some((c) => c.toUpperCase() === want));
  const dist = (r: Run) => (nearMs < r.startMs ? r.startMs - nearMs : nearMs > r.endMs ? nearMs - r.endMs : 0);
  return ok.sort((a, b) => dist(a) - dist(b) || b.endMs - a.endMs)[0];
}

/** Merge two point lists by timestamp (later list wins on identical t). */
export function mergePoints(a: RawPoint[], b: RawPoint[]): RawPoint[] {
  const m = new Map<number, RawPoint>();
  for (const p of a) m.set(p.t, p);
  for (const p of b) m.set(p.t, p);
  return [...m.values()].sort((x, y) => x.t - y.t);
}
