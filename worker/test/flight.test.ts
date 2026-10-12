import { afterEach, describe, expect, it, vi } from 'vitest';
import { callsignCandidates, parseFlightNumber } from '../src/lib/airlines';
import { handleRequest } from '../src/index';
import { normalizeAdsbdb } from '../src/providers/adsbdb';
import { normalizeAeroDataBox } from '../src/providers/aerodatabox';
import { normalizeAeroApi } from '../src/providers/flightaware';
import type { Env } from '../src/env';
import { ctx, jsonRes, mockFetch, req } from './helpers';
import { fx } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('flight number helpers', () => {
  it('parses and maps IATA -> ICAO callsigns', () => {
    const fn = parseFlightNumber('ek 0226')!;
    expect(fn.normalized).toBe('EK0226');
    expect(callsignCandidates(fn)).toEqual({ icao: 'UAE226', iata: 'EK226' });
    expect(callsignCandidates(parseFlightNumber('UAE226')!)).toEqual({ icao: 'UAE226' });
    expect(callsignCandidates(parseFlightNumber('QR701')!).icao).toBe('QTR701');
    expect(callsignCandidates(parseFlightNumber('PK203')!).icao).toBe('PIA203');
    expect(parseFlightNumber('hello world')).toBeNull();
    expect(parseFlightNumber('')).toBeNull();
    expect(parseFlightNumber('12345')).toBeNull();
  });
});

describe('normalisers', () => {
  it('AeroDataBox: normalises times, drops codeshares, lowercases modeS', () => {
    const legs = normalizeAeroDataBox(fx('aerodatabox-EK226.json'), 'EK226');
    expect(legs).toEqual([
      {
        flightNumber: 'EK226',
        from: 'SFO',
        to: 'DXB',
        scheduledDepartureUtc: '2026-10-12T18:35:00.000Z',
        scheduledArrivalUtc: '2026-10-13T11:25:00.000Z',
        actualDepartureUtc: '2026-10-12T19:08:00.000Z',
        aircraftIcao24: '896183',
        aircraftType: 'Boeing 777-300ER',
      },
    ]);
  });

  it('AeroAPI: picks scheduled gate times and actual wheels-off, keeps ids internally', () => {
    const legs = normalizeAeroApi(fx('aeroapi-EK226.json'), 'EK226');
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      flightNumber: 'EK226', from: 'SFO', to: 'DXB',
      scheduledDepartureUtc: '2026-10-12T18:35:00.000Z',
      scheduledArrivalUtc: '2026-10-13T11:25:00.000Z',
      actualDepartureUtc: '2026-10-12T19:08:00.000Z',
      aircraftType: 'B77W',
    });
    expect(legs[0]!.actualArrivalUtc).toBeUndefined();
  });

  it('adsbdb (real captured fixture): route only', () => {
    expect(normalizeAdsbdb(fx('adsbdb-UAE226.json'), 'UAE226')).toEqual([{ flightNumber: 'EK226', from: 'SFO', to: 'DXB' }]);
    expect(normalizeAdsbdb({ response: 'unknown callsign' }, 'X')).toEqual([]);
  });
});

describe('GET /api/flight', () => {
  const url = '/api/flight?number=ek226&date=2026-10-12';

  it('validates input', async () => {
    expect((await handleRequest(req('/api/flight?date=2026-10-12'), {}, ctx)).status).toBe(400);
    expect((await handleRequest(req('/api/flight?number=EK226&date=2026-13-45'), {}, ctx)).status).toBe(400);
    expect((await handleRequest(req('/api/flight?number=EK226'), {}, ctx)).status).toBe(400);
  });

  it('prefers AeroDataBox and sends the RapidAPI headers (without leaking the key)', async () => {
    const m = mockFetch((u) => (u.includes('aerodatabox') ? jsonRes(fx('aerodatabox-EK226.json')) : undefined));
    const env: Env = { AERODATABOX_API_KEY: 'secret-key' };
    const res = await handleRequest(req(url), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.source).toBe('aerodatabox');
    expect(body.legs[0].from).toBe('SFO');
    expect(JSON.stringify(body)).not.toContain('secret-key');
    expect(m.calls[0]!.url).toBe('https://aerodatabox.p.rapidapi.com/flights/number/EK226/2026-10-12');
    const h = new Headers(m.calls[0]!.init!.headers);
    expect(h.get('X-RapidAPI-Key')).toBe('secret-key');
    expect(h.get('X-RapidAPI-Host')).toBe('aerodatabox.p.rapidapi.com');
  });

  it('falls through AeroDataBox failure -> FlightAware', async () => {
    const m = mockFetch(
      (u) => (u.includes('aerodatabox') ? new Response('nope', { status: 500 }) : undefined),
      (u) => (u.startsWith('https://aeroapi.flightaware.com/aeroapi/flights/EK226?') ? jsonRes(fx('aeroapi-EK226.json')) : undefined),
    );
    const env: Env = { AERODATABOX_API_KEY: 'a', FLIGHTAWARE_API_KEY: 'b' };
    const res = await handleRequest(req(url), env, ctx);
    const body = (await res.json()) as any;
    expect(body.source).toBe('flightaware');
    expect(body.legs[0].faFlightId).toBeUndefined();
    const fa = m.calls.find((c) => c.url.includes('flightaware'))!;
    expect(new Headers(fa.init!.headers).get('x-apikey')).toBe('b');
    expect(fa.url).toContain('start=2026-10-12T00%3A00%3A00Z');
    expect(fa.url).toContain('end=2026-10-13T00%3A00%3A00Z');
  });

  it('uses free adsbdb with no keys: ICAO callsign first, then IATA form', async () => {
    const m = mockFetch(
      (u) => (u.endsWith('/callsign/UAE226') ? jsonRes({ response: 'unknown callsign' }, 404) : undefined),
      (u) => (u.endsWith('/callsign/EK226') ? jsonRes(fx('adsbdb-UAE226.json')) : undefined),
    );
    const res = await handleRequest(req(url), {}, ctx);
    const body = (await res.json()) as any;
    expect(body).toEqual({ source: 'adsbdb', legs: [{ flightNumber: 'EK226', from: 'SFO', to: 'DXB' }] });
    expect(m.calls.map((c) => c.url)).toEqual([
      'https://api.adsbdb.com/v0/callsign/UAE226',
      'https://api.adsbdb.com/v0/callsign/EK226',
    ]);
  });

  it('404 when nothing is found, 502 (generic) when providers error', async () => {
    mockFetch(() => jsonRes({ response: 'unknown callsign' }, 404));
    const nf = await handleRequest(req(url), {}, ctx);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: expect.any(String) });

    mockFetch(() => new Response('upstream says: key=abc leaked', { status: 500 }));
    const bad = await handleRequest(req(url), {}, ctx);
    expect(bad.status).toBe(502);
    expect(JSON.stringify(await bad.json())).not.toContain('leaked');
  });
});
