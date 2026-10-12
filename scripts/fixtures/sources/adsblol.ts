/**
 * adsb.lol: community ADS-B network, open data (ODbL 1.0), no key.
 *  - live:   https://api.adsb.lol/v2/callsign/<ICAO callsign>
 *  - traces: https://globe.adsb.lol/data/traces/<last 2 hex>/trace_full_<hex>.json (redirects to adsb.lol)
 * Attribution required: "Data © adsb.lol contributors, ODbL 1.0".
 */
import { http } from '../lib/http';
import { mergePoints, parseTrace, type Tar1090Trace } from '../lib/tar1090';
import type { RawPoint } from '../lib/fixture';

export interface LiveAircraft {
  hex: string;
  flight: string;
  registration?: string;
  type?: string;
  lat?: number;
  lon?: number;
  /** feet, or 'ground' */
  altBaro?: number | 'ground';
  gs?: number;
  /** ms since epoch of the API response */
  nowMs: number;
}

interface LiveResp {
  now?: number;
  ac?: { hex: string; flight?: string; r?: string; t?: string; lat?: number; lon?: number; alt_baro?: number | 'ground'; gs?: number }[];
}

export function isConfigured(): boolean { return true; }

/** Currently tracked aircraft using this callsign (never cached). */
export async function liveByCallsign(callsign: string): Promise<{ aircraft: LiveAircraft[]; error?: string }> {
  const res = await http(`https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`, { ttlMs: 0, minIntervalMs: 1500, retries: 4 }); // adsb.lol answers sporadic 429s above ~0.7 req/s
  if (res.status !== 200) return { aircraft: [], error: res.error ?? `HTTP ${res.status}` };
  const body = res.json<LiveResp>();
  const nowMs = body?.now ?? Date.now();
  return {
    aircraft: (body?.ac ?? []).map((a) => ({
      hex: a.hex.toLowerCase(), flight: (a.flight ?? '').trim(), registration: a.r, type: a.t,
      lat: a.lat, lon: a.lon, altBaro: a.alt_baro, gs: a.gs, nowMs,
    })),
  };
}

export const isAirborne = (a: LiveAircraft): boolean =>
  a.altBaro !== 'ground' && typeof a.lat === 'number' && typeof a.lon === 'number';

export function traceUrl(hex: string, kind: 'full' | 'recent' = 'full'): string {
  const h = hex.toLowerCase();
  return `https://globe.adsb.lol/data/traces/${h.slice(-2)}/trace_${kind}_${h}.json`;
}

async function fetchTraceFile(hex: string, kind: 'full' | 'recent', ttlMs: number): Promise<{ points: RawPoint[]; error?: string }> {
  const res = await http(traceUrl(hex, kind), {
    ttlMs,
    timeoutMs: 60_000,
    headers: { Referer: 'https://globe.adsb.lol/' },
  });
  if (res.status !== 200) return { points: [], error: res.error ?? `HTTP ${res.status}` };
  const json = res.json<Tar1090Trace>();
  if (!json) return { points: [], error: 'invalid JSON' };
  return { points: parseTrace(json) };
}

/**
 * Trace of an aircraft: `trace_full` (everything of the last ~day, but regenerated only every few minutes to hours)
 * merged with `trace_recent` (the last ~100 fixes, near-live). Cached for `ttlMs` (default 2 min).
 */
export async function fetchTrace(hex: string, ttlMs = 120_000): Promise<{ points: RawPoint[]; error?: string }> {
  const full = await fetchTraceFile(hex, 'full', ttlMs);
  const recent = await fetchTraceFile(hex, 'recent', ttlMs);
  if (full.points.length === 0 && recent.points.length === 0) return { points: [], error: full.error ?? recent.error };
  return { points: mergePoints(full.points, recent.points) };
}
