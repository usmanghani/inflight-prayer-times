import type { Env } from '../env';
import { UpstreamError, upstreamFetch, upstreamJson } from '../lib/http';
import type { TrackPointOut } from '../lib/types';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let tokenCache: { token: string; expiresAt: number; clientId: string } | null = null;

/** Test helper. */
export function resetOpenSkyTokenCache(): void {
  tokenCache = null;
}

export async function getOpenSkyToken(env: Env, now = Date.now()): Promise<string> {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) throw new UpstreamError('opensky', 0);
  if (tokenCache && tokenCache.clientId === env.OPENSKY_CLIENT_ID && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token;
  }
  const res = await upstreamFetch('opensky-auth', TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENSKY_CLIENT_ID,
      client_secret: env.OPENSKY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new UpstreamError('opensky-auth', res.status);
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) throw new UpstreamError('opensky-auth', res.status);
  tokenCache = {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? 1800) * 1000,
    clientId: env.OPENSKY_CLIENT_ID,
  };
  return tokenCache.token;
}

/** path entries: [time, lat, lon, baro_altitude_m, true_track, on_ground] */
export function normalizeOpenSky(data: unknown): TrackPointOut[] {
  const path = (data as { path?: unknown[] } | null)?.path;
  if (!Array.isArray(path)) return [];
  const out: TrackPointOut[] = [];
  for (const e of path) {
    if (!Array.isArray(e)) continue;
    const [t, lat, lon, alt, , onGround] = e as [unknown, unknown, unknown, unknown, unknown, unknown];
    if (typeof t !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const pt: TrackPointOut = { lat, lon, time: new Date(t * 1000).toISOString() };
    if (typeof alt === 'number') pt.altitudeM = alt;
    else if (onGround === true) pt.altitudeM = 0;
    out.push(pt);
  }
  return out;
}

/** `time` = any unix time (seconds) inside the flight; 0 = live. */
export async function fetchOpenSkyTrack(env: Env, icao24: string, time: number): Promise<TrackPointOut[] | null> {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  const token = await getOpenSkyToken(env);
  const url = `https://opensky-network.org/api/tracks/all?icao24=${encodeURIComponent(icao24.toLowerCase())}&time=${Math.floor(time)}`;
  const data = await upstreamJson('opensky', url, { headers: { Authorization: `Bearer ${token}` } }, 15_000);
  if (data == null) return [];
  return normalizeOpenSky(data);
}
