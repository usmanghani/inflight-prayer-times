/**
 * FlightAware AeroAPI v4 (commercial, per-query pricing). Set FLIGHTAWARE_API_KEY.
 * History is limited by the plan (typically the last 10 days). Data may not be redistributed: the resulting
 * fixtures (`*_flightaware.json`) are gitignored by default.
 */
import { http } from '../lib/http';
import { ftToM, type RawPoint } from '../lib/fixture';
import { getAirport } from '../../../src/data/airports';

const API = 'https://aeroapi.flightaware.com/aeroapi';

export const ENV_VARS = ['FLIGHTAWARE_API_KEY'];

export function isConfigured(): boolean {
  return !!process.env.FLIGHTAWARE_API_KEY;
}

export const missingMessage = 'FlightAware skipped: set FLIGHTAWARE_API_KEY (AeroAPI key, https://www.flightaware.com/aeroapi/).';

async function api<T>(path: string, ttlMs: number): Promise<{ status: number; json?: T; error?: string }> {
  const res = await http(`${API}${path}`, {
    headers: { 'x-apikey': process.env.FLIGHTAWARE_API_KEY ?? '' },
    ttlMs,
    timeoutMs: 60_000,
  });
  return { status: res.status, json: res.json<T>(), error: res.error };
}

interface FaAirport { code?: string | null; code_icao?: string | null; code_iata?: string | null }
export interface FaFlight {
  ident: string;
  ident_icao?: string;
  ident_iata?: string;
  fa_flight_id: string;
  origin?: FaAirport | null;
  destination?: FaAirport | null;
  scheduled_out?: string | null;
  actual_off?: string | null;
  actual_on?: string | null;
  registration?: string | null;
}

/** `/flights/{ident}`: recent flights for an ident (IATA or ICAO) within [start, end] ISO times. */
export async function listFlights(ident: string, startIso: string, endIso: string): Promise<FaFlight[]> {
  const r = await api<{ flights?: FaFlight[] }>(
    `/flights/${encodeURIComponent(ident)}?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
    24 * 3_600_000,
  );
  if (r.status === 404) return [];
  if (r.status !== 200) throw new Error(`AeroAPI /flights/${ident} → HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  return r.json?.flights ?? [];
}

interface FaPosition { altitude?: number | null; groundspeed?: number | null; latitude?: number; longitude?: number; timestamp?: string; update_type?: string }

/** `/flights/{fa_flight_id}/track`; altitude is in hundreds of feet. */
export async function flightTrack(faFlightId: string): Promise<RawPoint[]> {
  const r = await api<{ positions?: FaPosition[] }>(`/flights/${encodeURIComponent(faFlightId)}/track`, 7 * 24 * 3_600_000);
  if (r.status === 404) return [];
  if (r.status !== 200) throw new Error(`AeroAPI track → HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  const out: RawPoint[] = [];
  for (const p of r.json?.positions ?? []) {
    if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number' || !p.timestamp) continue;
    const t = Date.parse(p.timestamp);
    if (!Number.isFinite(t)) continue;
    out.push({ t, lat: p.latitude, lon: p.longitude, altM: typeof p.altitude === 'number' ? ftToM(p.altitude * 100) : null });
  }
  return out;
}

export interface HistoricalRequest { flightNumber: string; callsign: string; from: string; to: string; date: string }

export async function fetchFlightTrack(q: HistoricalRequest): Promise<{ points: RawPoint[]; notes: string[] } | null> {
  const start = `${q.date}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 2 * 86400_000).toISOString().replace('.000Z', 'Z');
  const flights = await listFlights(q.flightNumber, start, end);
  const fromIcao = getAirport(q.from)?.icao;
  const hit = flights
    .filter((f) => f.actual_off && f.actual_off.slice(0, 10) === q.date)
    .filter((f) => !f.origin || [f.origin.code_iata, f.origin.code_icao, f.origin.code].includes(q.from) || (fromIcao && f.origin.code_icao === fromIcao))
    .sort((a, b) => (a.actual_off ?? '').localeCompare(b.actual_off ?? ''))[0];
  if (!hit) return null;
  const points = await flightTrack(hit.fa_flight_id);
  return points.length ? { points, notes: [`FlightAware id ${hit.fa_flight_id}`] } : null;
}
