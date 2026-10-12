import { upstreamJson } from '../lib/http';
import type { TrackPointOut } from '../lib/types';

interface TraceFile {
  timestamp?: number;
  trace?: unknown[];
}

const FT_TO_M = 0.3048;

/** tar1090 trace: [secondsOffset, lat, lon, altFt|"ground", gs, track, flags, ...] relative to `timestamp`. */
export function normalizeAdsbLolTrace(data: unknown): { points: TrackPointOut[]; onGround: boolean[] } {
  const f = data as TraceFile | null;
  const points: TrackPointOut[] = [];
  const onGround: boolean[] = [];
  if (!f || typeof f.timestamp !== 'number' || !Array.isArray(f.trace)) return { points, onGround };
  for (const e of f.trace) {
    if (!Array.isArray(e)) continue;
    const [off, lat, lon, alt] = e as [unknown, unknown, unknown, unknown];
    if (typeof off !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const pt: TrackPointOut = { lat, lon, time: new Date((f.timestamp + off) * 1000).toISOString() };
    const ground = alt === 'ground';
    if (ground) pt.altitudeM = 0;
    else if (typeof alt === 'number') pt.altitudeM = Math.round(alt * FT_TO_M);
    points.push(pt);
    onGround.push(ground);
  }
  return { points, onGround };
}

/**
 * The trace covers the whole UTC day, possibly several flights. Keep the last
 * contiguous airborne run (plus one ground point either side).
 */
export function lastAirborneRun(points: TrackPointOut[], onGround: boolean[]): TrackPointOut[] {
  let end = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (!onGround[i]) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  while (start > 0 && !onGround[start - 1]) start--;
  return points.slice(Math.max(0, start - 1), Math.min(points.length, end + 2));
}

export async function fetchAdsbLolHexForCallsign(callsign: string): Promise<string | null> {
  const data = await upstreamJson<{ ac?: { hex?: string }[] }>(
    'adsblol',
    `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`,
  );
  const hex = data?.ac?.[0]?.hex?.toLowerCase();
  return hex && /^[0-9a-f]{6}$/.test(hex) ? hex : null;
}

export async function fetchAdsbLolTrace(hex: string): Promise<{ points: TrackPointOut[]; onGround: boolean[] } | null> {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const data = await upstreamJson('adsblol', `https://globe.adsb.lol/data/traces/${h.slice(-2)}/trace_full_${h}.json`, {}, 15_000);
  if (data == null) return null;
  return normalizeAdsbLolTrace(data);
}
