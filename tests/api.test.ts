import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setEnvApiBaseForTests, getApiBase, setApiBase } from '../src/api/config';
import {
  ApiError,
  ApiUnavailableError,
  extractItinerary,
  fetchTrack,
  fetchTrackDetailed,
  getHealth,
  lookupFlight,
  parseRoute,
  prepareImage,
  toTrackPoints,
} from '../src/api/client';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setEnvBase(v: string | undefined) {
  __setEnvApiBaseForTests(v ?? null);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setEnvApiBaseForTests(undefined);
});

describe('api config', () => {
  it('is null when unset', () => {
    setEnvBase(undefined);
    expect(getApiBase()).toBeNull();
  });
  it('reads VITE_API_BASE, strips trailing slashes, localStorage override wins', () => {
    setEnvBase('https://env.example/');
    expect(getApiBase()).toBe('https://env.example');
    expect(setApiBase('https://override.example///')).toBe(true);
    expect(getApiBase()).toBe('https://override.example');
    setApiBase(null);
    expect(getApiBase()).toBe('https://env.example');
  });
  it('tolerates storage throwing / missing', () => {
    setEnvBase('https://env.example');
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(getApiBase()).toBe('https://env.example');
    expect(setApiBase('https://x.example')).toBe(false);
  });
});

describe('api client', () => {
  beforeEach(() => setApiBase('https://api.example'));

  it('throws ApiUnavailableError without a base, without calling fetch', async () => {
    setApiBase(null);
    setEnvBase(undefined);
    await expect(getHealth()).rejects.toBeInstanceOf(ApiUnavailableError);
    await expect(lookupFlight('EK226', '2026-10-12')).rejects.toBeInstanceOf(ApiError);
    await expect(extractItinerary({ text: 'x' })).rejects.toBeInstanceOf(ApiUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getHealth builds the URL', async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, providers: { anthropic: false, openai: false, aerodatabox: false, flightaware: false, opensky: false, adsbdb: true, adsblol: true } }));
    const h = await getHealth();
    expect(h.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example/api/health');
  });

  it('lookupFlight encodes query params', async () => {
    fetchMock.mockResolvedValue(ok({ source: 'adsbdb', legs: [{ flightNumber: 'EK226', from: 'SFO', to: 'DXB' }] }));
    const r = await lookupFlight(' ek 226 ', '2026-10-12');
    expect(r.legs[0]!.from).toBe('SFO');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example/api/flight?number=ek+226&date=2026-10-12');
  });

  it('maps HTTP errors to ApiError with status and server message', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'No flight found for that number and date.' }, 404));
    const err = await lookupFlight('EK226', '2026-10-12').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('No flight found for that number and date.');

    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const e2 = await getHealth().catch((e) => e);
    expect(e2.status).toBe(502);
    expect(e2.message).toMatch(/502/);
  });

  it('maps network failure to ApiError(0)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await getHealth().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('fetchTrack converts to TrackPoint[] with Date times', async () => {
    fetchMock.mockResolvedValue(
      ok({
        source: 'opensky',
        attribution: 'The OpenSky Network',
        points: [
          { lat: 1, lon: 2, altitudeM: 100, time: '2026-10-12T10:00:00.000Z' },
          { lat: 3, lon: 4, time: '2026-10-12T10:01:00.000Z' },
          { lat: null, lon: 4, time: '2026-10-12T10:02:00.000Z' },
          { lat: 5, lon: 6, time: 'garbage' },
        ],
      }),
    );
    const pts = await fetchTrack('EK226', '2026-10-12');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example/api/track?number=EK226&date=2026-10-12');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ lat: 1, lon: 2, altitudeM: 100, time: new Date('2026-10-12T10:00:00.000Z') });
    expect(pts[1]!.altitudeM).toBeUndefined();
    expect(pts[2]!.time).toBeUndefined();
    fetchMock.mockResolvedValue(ok({ source: 'adsblol', attribution: 'adsb.lol ODbL', points: [] }));
    expect((await fetchTrackDetailed('EK226', '2026-10-12')).attribution).toBe('adsb.lol ODbL');
    expect(toTrackPoints([])).toEqual([]);
  });

  it('extractItinerary (text) posts JSON and leaves provider unset by default', async () => {
    fetchMock.mockResolvedValue(ok({ provider: 'openrouter', model: 'm', legs: [], warnings: [] }));
    await extractItinerary({ text: 'EK226 SFO-DXB' }, { referenceDate: '2026-10-12' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/itinerary/extract');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'EK226 SFO-DXB', referenceDate: '2026-10-12' });
  });

  it('extractItinerary (blob) sends base64 + mediaType as-is when image APIs are unavailable (node)', async () => {
    expect(typeof createImageBitmap).toBe('undefined');
    fetchMock.mockResolvedValue(ok({ provider: 'anthropic', model: 'm', legs: [], warnings: [] }));
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    await extractItinerary(blob, { provider: 'anthropic' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({ provider: 'anthropic', image: 'iVBORw==', mediaType: 'image/png' });
    expect(await prepareImage(blob)).toBe(blob);
  });

  it('extractItinerary rejects oversize and unsupported files client-side', async () => {
    const big = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], { type: 'application/pdf' });
    await expect(extractItinerary(big)).rejects.toMatchObject({ status: 413 });
    await expect(extractItinerary(new Blob(['x'], { type: 'text/plain' }))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parseRoute posts text to /api/route/parse', async () => {
    fetchMock.mockResolvedValue(ok({ provider: 'openrouter', model: 'm', legs: [], waypoints: [{ lat: 1, lon: 2 }], warnings: [] }));
    const r = await parseRoute('OPKC DCT OMDB', { model: 'qwen/qwen3.8-flash' });
    expect(r.waypoints).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/api/route/parse');
    expect(JSON.parse(init.body)).toEqual({ text: 'OPKC DCT OMDB', model: 'qwen/qwen3.8-flash' });
  });
});
