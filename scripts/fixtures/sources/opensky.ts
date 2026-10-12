/**
 * OpenSky Network (https://opensky-network.org). Historical data needs a (free) account:
 * create an API client at https://opensky-network.org/my-opensky/account and export
 *   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET
 * (OAuth2 client-credentials). Terms: research / non-commercial, attribution required.
 */
import { getAirport } from '../../../src/data/airports';
import { http } from '../lib/http';
import type { RawPoint } from '../lib/fixture';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const API = 'https://opensky-network.org/api';

export const ENV_VARS = ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'];

export function isConfigured(): boolean {
  return !!process.env.OPENSKY_CLIENT_ID && !!process.env.OPENSKY_CLIENT_SECRET;
}

export const missingMessage =
  'OpenSky skipped: set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (free API client, https://opensky-network.org/my-opensky/account).';

let token: { value: string; expiresAt: number } | undefined;

async function getToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 30_000) return token.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.OPENSKY_CLIENT_ID ?? '',
    client_secret: process.env.OPENSKY_CLIENT_SECRET ?? '',
  }).toString();
  const res = await http(TOKEN_URL, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ttlMs: 0,
  });
  const j = res.json<{ access_token?: string; expires_in?: number }>();
  if (res.status !== 200 || !j?.access_token) throw new Error(`OpenSky token request failed (HTTP ${res.status}${res.error ? ` ${res.error}` : ''})`);
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 300) * 1000 };
  return token.value;
}

async function api<T>(path: string, ttlMs: number): Promise<{ status: number; json?: T; error?: string }> {
  const tk = await getToken();
  const res = await http(`${API}${path}`, { headers: { Authorization: `Bearer ${tk}` }, ttlMs, timeoutMs: 60_000 });
  return { status: res.status, json: res.json<T>(), error: res.error };
}

export interface OpenSkyFlight {
  icao24: string;
  firstSeen: number;
  estDepartureAirport: string | null;
  lastSeen: number;
  estArrivalAirport: string | null;
  callsign: string | null;
}

/** `/flights/departure` or `/flights/arrival` (interval must be <= 2 days; unix seconds). */
export async function flightsAtAirport(kind: 'departure' | 'arrival', icaoAirport: string, begin: number, end: number): Promise<OpenSkyFlight[]> {
  const r = await api<OpenSkyFlight[]>(`/flights/${kind}?airport=${icaoAirport}&begin=${begin}&end=${end}`, 24 * 3_600_000);
  if (r.status === 404) return []; // "no flights found"
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`OpenSky /flights/${kind} → HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  return r.json;
}

interface TrackResp { icao24?: string; callsign?: string; startTime?: number; endTime?: number; path?: (number | boolean | null)[][] }

/** `/tracks/all?icao24&time` : path rows are [time, lat, lon, baro_altitude_m, true_track, on_ground]. */
export async function trackAll(icao24: string, timeSec: number): Promise<{ points: RawPoint[]; callsign?: string }> {
  const r = await api<TrackResp>(`/tracks/all?icao24=${icao24}&time=${timeSec}`, 7 * 24 * 3_600_000);
  if (r.status === 404) return { points: [] };
  if (r.status !== 200 || !r.json) throw new Error(`OpenSky /tracks/all → HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
  const points: RawPoint[] = [];
  for (const row of r.json.path ?? []) {
    const [t, lat, lon, alt, , ground] = row as [number, number | null, number | null, number | null, unknown, boolean];
    if (typeof t !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    points.push({ t: t * 1000, lat, lon, altM: typeof alt === 'number' ? alt : null, ground: ground === true });
  }
  return { points, callsign: r.json.callsign?.trim() };
}

export interface HistoricalRequest { flightNumber: string; callsign: string; from: string; to: string; date: string }

/** Find the flight (callsign at origin's departures on `date`, UTC) and download its track. */
export async function fetchFlightTrack(q: HistoricalRequest): Promise<{ points: RawPoint[]; icao24?: string; notes: string[] } | null> {
  const orig = getAirport(q.from)?.icao;
  if (!orig) throw new Error(`no ICAO code for ${q.from}`);
  const begin = Math.floor(Date.parse(`${q.date}T00:00:00Z`) / 1000);
  // Dep. times may be a few hours either side of the UTC date: query the 2-day window starting at date 00:00 UTC.
  const flights = await flightsAtAirport('departure', orig, begin, begin + 2 * 86400 - 1);
  const hits = flights.filter((f) => (f.callsign ?? '').trim().toUpperCase() === q.callsign);
  if (hits.length === 0) return null;
  const f = hits.sort((a, b) => a.firstSeen - b.firstSeen)[0];
  const tr = await trackAll(f.icao24, Math.floor((f.firstSeen + f.lastSeen) / 2));
  if (tr.points.length === 0) return null;
  return { points: tr.points, icao24: f.icao24, notes: [`OpenSky estimated arrival airport: ${f.estArrivalAirport ?? 'unknown'}`] };
}
