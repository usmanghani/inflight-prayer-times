import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index';
import type { Env } from '../src/env';
import { cleanTrack } from '../src/lib/track';
import { lastAirborneRun, normalizeAdsbLolTrace } from '../src/providers/adsblol';
import { normalizeAeroApiTrack } from '../src/providers/flightaware';
import { getOpenSkyToken, normalizeOpenSky, resetOpenSkyTokenCache } from '../src/providers/opensky';
import { ctx, jsonRes, mockFetch, req } from './helpers';
import { fx } from './fixtures';

beforeEach(() => resetOpenSkyTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('cleanTrack', () => {
  it('drops invalid points, sorts, dedupes timestamps, rounds', () => {
    const out = cleanTrack([
      { lat: 10.1234567, lon: 20, time: '2026-10-12T10:00:10Z', altitudeM: 100.4 },
      { lat: 10, lon: 20, time: '2026-10-12T10:00:00Z' },
      { lat: 10, lon: 20, time: '2026-10-12T10:00:00Z' }, // duplicate time
      { lat: NaN, lon: 20, time: '2026-10-12T10:00:20Z' },
      { lat: 91, lon: 20, time: '2026-10-12T10:00:30Z' },
      { lat: 10, lon: 181, time: '2026-10-12T10:00:30Z' },
      { lat: 10, lon: 20, time: 'garbage' },
      { lat: 11, lon: 21, time: '2026-10-12T10:01:00Z', altitudeM: -5 },
    ]);
    expect(out.map((p) => p.time)).toEqual(['2026-10-12T10:00:00.000Z', '2026-10-12T10:00:10.000Z', '2026-10-12T10:01:00.000Z']);
    expect(out[1]).toEqual({ lat: 10.12346, lon: 20, time: '2026-10-12T10:00:10.000Z', altitudeM: 100 });
    expect(out[2]!.altitudeM).toBe(0);
  });

  it('decimates long tracks keeping first and last', () => {
    const pts = Array.from({ length: 10000 }, (_, i) => ({ lat: 0, lon: i / 100, time: new Date(Date.UTC(2026, 9, 12) + i * 1000).toISOString() }));
    const out = cleanTrack(pts, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]!.lon).toBe(0);
    expect(out[out.length - 1]!.lon).toBe(99.99);
  });
});

describe('provider normalisers', () => {
  it('AeroAPI track converts hundreds of feet to metres and skips null coords', () => {
    const pts = normalizeAeroApiTrack(fx('aeroapi-track.json'));
    expect(pts).toHaveLength(3);
    expect(pts[2]).toEqual({ lat: 45.1, lon: -121.2, altitudeM: Math.round(380 * 100 * 0.3048), time: '2026-10-12T19:50:00.000Z' });
    expect(pts[2]!.altitudeM).toBe(11582);
  });

  it('OpenSky path entries', () => {
    const pts = normalizeOpenSky(fx('opensky-track.json'));
    expect(pts).toHaveLength(6); // null coordinate row skipped
    expect(pts[0]).toEqual({ lat: 37.6188, lon: -122.375, altitudeM: 0, time: new Date(1760296080 * 1000).toISOString() });
    // clean pass removes duplicate time and invalid lat 95
    const cleaned = cleanTrack(pts);
    expect(cleaned).toHaveLength(4);
  });

  it('adsb.lol trace: offsets, ground, feet->m, last airborne run', () => {
    const { points, onGround } = normalizeAdsbLolTrace(fx('adsblol-trace.json'));
    expect(points).toHaveLength(11);
    expect(points[0]).toMatchObject({ altitudeM: 0, time: new Date(1760270000 * 1000).toISOString() });
    expect(points[2]!.altitudeM).toBe(Math.round(31000 * 0.3048));
    expect(onGround.filter(Boolean)).toHaveLength(5);
    const run = lastAirborneRun(points, onGround);
    expect(run).toHaveLength(4); // one ground point + 3 airborne
    expect(run[0]!.altitudeM).toBe(0);
    expect(run[3]!.lat).toBe(55);
  });
});

describe('OpenSky OAuth token', () => {
  it('requests a client-credentials token and caches it until expiry', async () => {
    const m = mockFetch(() => jsonRes({ access_token: 'tok1', expires_in: 1800 }));
    const env: Env = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'sec' };
    const now = 1_000_000;
    expect(await getOpenSkyToken(env, now)).toBe('tok1');
    expect(await getOpenSkyToken(env, now + 600_000)).toBe('tok1');
    expect(m.fn).toHaveBeenCalledTimes(1);
    expect(m.calls[0]!.url).toBe('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token');
    const body = new URLSearchParams(m.calls[0]!.init!.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('id');
    await getOpenSkyToken(env, now + 1_800_000); // expired -> refetch
    expect(m.fn).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/track', () => {
  it('validates input', async () => {
    expect((await handleRequest(req('/api/track'), {}, ctx)).status).toBe(400);
    expect((await handleRequest(req('/api/track?icao24=zzz&begin=1&end=2'), {}, ctx)).status).toBe(400);
    expect((await handleRequest(req('/api/track?icao24=896183&begin=2000&end=1000'), {}, ctx)).status).toBe(400);
    expect((await handleRequest(req('/api/track?number=EK226'), {}, ctx)).status).toBe(400);
  });

  it('FlightAware: flights then track, with attribution', async () => {
    const m = mockFetch(
      (u) => (u.includes('/flights/EK226?') ? jsonRes(fx('aeroapi-EK226.json')) : undefined),
      (u) => (u.includes('/track') ? jsonRes(fx('aeroapi-track.json')) : undefined),
    );
    const res = await handleRequest(req('/api/track?number=EK226&date=2026-10-12'), { FLIGHTAWARE_API_KEY: 'k' }, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.source).toBe('flightaware');
    expect(body.attribution).toMatch(/FlightAware/);
    expect(body.points).toHaveLength(3);
    expect(m.calls[1]!.url).toBe('https://aeroapi.flightaware.com/aeroapi/flights/UAE226-1760000000-schedule-1234p/track');
    // cancelled flight must not be tried
    expect(m.calls).toHaveLength(2);
  });

  it('OpenSky by icao24 + window, filters to the window', async () => {
    mockFetch(
      (u) => (u.includes('auth.opensky') ? jsonRes({ access_token: 't', expires_in: 1800 }) : undefined),
      (u) => (u.startsWith('https://opensky-network.org/api/tracks/all?icao24=896183&time=') ? jsonRes(fx('opensky-track.json')) : undefined),
    );
    const env: Env = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 's' };
    const res = await handleRequest(req('/api/track?icao24=896183&begin=1760296000&end=1760301000'), env, ctx);
    const body = (await res.json()) as any;
    expect(body.source).toBe('opensky');
    expect(body.attribution).toMatch(/OpenSky/);
    expect(body.points).toHaveLength(3);
  });

  it('OpenSky via flight lookup (icao24 from AeroDataBox) for number+date', async () => {
    const m = mockFetch(
      (u) => (u.includes('aerodatabox') ? jsonRes(fx('aerodatabox-EK226.json')) : undefined),
      (u) => (u.includes('auth.opensky') ? jsonRes({ access_token: 't', expires_in: 1800 }) : undefined),
      (u) => (u.includes('opensky-network.org/api/tracks') ? jsonRes(fx('opensky-track.json')) : undefined),
    );
    const env: Env = { AERODATABOX_API_KEY: 'a', OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 's' };
    const body = (await (await handleRequest(req('/api/track?number=EK226&date=2026-10-12'), env, ctx)).json()) as any;
    expect(body.source).toBe('opensky');
    expect(m.calls.some((c) => c.url.includes('icao24=896183'))).toBe(true);
  });

  it('adsb.lol (free): callsign -> hex -> trace, last flight only', async () => {
    const m = mockFetch(
      (u) => (u === 'https://api.adsb.lol/v2/callsign/UAE226' ? jsonRes(fx('adsblol-callsign.json')) : undefined),
      (u) => (u === 'https://globe.adsb.lol/data/traces/83/trace_full_896183.json' ? jsonRes(fx('adsblol-trace.json')) : undefined),
    );
    const res = await handleRequest(req('/api/track?number=ek226&date=2026-10-12'), {}, ctx);
    const body = (await res.json()) as any;
    expect(body.source).toBe('adsblol');
    expect(body.attribution).toMatch(/ODbL/);
    expect(body.points).toHaveLength(4);
    expect(body.points[0]).toMatchObject({ lat: 37.62, lon: -122.38, altitudeM: 0 });
    expect(m.calls).toHaveLength(2);
  });

  it('404 when no provider has the flight', async () => {
    mockFetch((u) => (u.includes('adsb.lol') ? jsonRes({ ac: [], total: 0 }) : undefined));
    const res = await handleRequest(req('/api/track?number=EK226&date=2026-10-12'), {}, ctx);
    expect(res.status).toBe(404);
  });
});
