import type { Ctx, Env, Handler } from '../env';
import { TRACK_TTL, cached } from '../lib/cache';
import { callsignCandidates, parseFlightNumber } from '../lib/airlines';
import { errorResponse, isIsoDate, json, warnUpstream } from '../lib/http';
import { cleanTrack, filterWindow } from '../lib/track';
import type { TrackPointOut, TrackResult } from '../lib/types';
import { fetchAdsbLolHexForCallsign, fetchAdsbLolTrace, lastAirborneRun } from '../providers/adsblol';
import { fetchAeroApiFlights, fetchAeroApiTrack } from '../providers/flightaware';
import { fetchOpenSkyTrack } from '../providers/opensky';
import { lookupFlightLegs } from './flight';

export const ATTRIBUTION = {
  flightaware: 'Track data from FlightAware AeroAPI (https://www.flightaware.com)',
  opensky: 'The OpenSky Network, https://opensky-network.org',
  adsblol: 'Contains data from adsb.lol (https://www.adsb.lol), licensed under the Open Database License (ODbL) 1.0',
} as const;

/** Accepts unix seconds, unix ms or ISO strings. Returns ms or undefined. */
export function parseTimeParam(v: string | null): number | undefined {
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n > 1e11 ? n : n * 1000;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

const MIN_POINTS = 2;

function ok(source: TrackResult['source'], points: TrackPointOut[]): TrackResult | null {
  const cleaned = cleanTrack(points);
  return cleaned.length >= MIN_POINTS ? { source, attribution: ATTRIBUTION[source], points: cleaned } : null;
}

async function trackByNumber(env: Env, number: string, date: string): Promise<{ r: TrackResult | null; errored: boolean }> {
  let errored = false;
  const fn = parseFlightNumber(number)!;

  // 1. FlightAware
  if (env.FLIGHTAWARE_API_KEY) {
    try {
      const flights = await fetchAeroApiFlights(env, fn.normalized, date);
      const candidates = (flights ?? []).filter((f) => f.faFlightId && !f.cancelled && (f.actualDepartureUtc || f.actualArrivalUtc));
      for (const f of candidates) {
        const pts = await fetchAeroApiTrack(env, f.faFlightId!);
        const r = pts && ok('flightaware', pts);
        if (r) return { r, errored };
      }
    } catch (e) {
      errored = true;
      warnUpstream(e);
    }
  }

  // 2. OpenSky (needs icao24 + a time within the flight, resolved via the flight lookup)
  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) {
    try {
      const { result } = await lookupFlightLegs(env, fn.normalized, date);
      const leg = result?.legs.find((l) => l.aircraftIcao24);
      if (leg?.aircraftIcao24) {
        const dep = Date.parse(leg.actualDepartureUtc ?? leg.scheduledDepartureUtc ?? '');
        const arr = Date.parse(leg.actualArrivalUtc ?? leg.scheduledArrivalUtc ?? '');
        const mid = Number.isFinite(dep) ? (Number.isFinite(arr) ? (dep + arr) / 2 : dep + 3600_000) : NaN;
        if (Number.isFinite(mid)) {
          const pts = await fetchOpenSkyTrack(env, leg.aircraftIcao24, mid / 1000);
          const r = pts && ok('opensky', pts);
          if (r) return { r, errored };
        }
      }
    } catch (e) {
      errored = true;
      warnUpstream(e);
    }
  }

  // 3. adsb.lol (live aircraft only; trace covers the current UTC day)
  try {
    const { icao, iata } = callsignCandidates(fn);
    for (const cs of [icao, iata]) {
      if (!cs) continue;
      const hex = await fetchAdsbLolHexForCallsign(cs);
      if (!hex) continue;
      const trace = await fetchAdsbLolTrace(hex);
      if (!trace) continue;
      const r = ok('adsblol', lastAirborneRun(trace.points, trace.onGround));
      if (r) return { r, errored };
    }
  } catch (e) {
    errored = true;
    warnUpstream(e);
  }
  return { r: null, errored };
}

async function trackByIcao24(env: Env, icao24: string, begin: number, end: number): Promise<{ r: TrackResult | null; errored: boolean }> {
  let errored = false;
  if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) {
    try {
      const pts = await fetchOpenSkyTrack(env, icao24, (begin + end) / 2000);
      const r = pts && ok('opensky', filterWindow(pts, begin, end));
      if (r) return { r, errored };
    } catch (e) {
      errored = true;
      warnUpstream(e);
    }
  }
  try {
    const trace = await fetchAdsbLolTrace(icao24);
    const r = trace && ok('adsblol', filterWindow(trace.points, begin, end));
    if (r) return { r, errored };
  } catch (e) {
    errored = true;
    warnUpstream(e);
  }
  return { r: null, errored };
}

export const track: Handler = async (req: Request, env: Env, ctx: Ctx) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  const icao24 = q.get('icao24')?.toLowerCase();

  if (icao24) {
    if (!/^[0-9a-f]{6}$/.test(icao24)) return errorResponse(400, 'Invalid "icao24" (expected 6 hex characters).');
    const begin = parseTimeParam(q.get('begin'));
    const end = parseTimeParam(q.get('end'));
    if (begin == null || end == null || end <= begin) return errorResponse(400, '"begin" and "end" (unix seconds or ISO) are required, end > begin.');
    if (end - begin > 48 * 3600_000) return errorResponse(400, 'Time window too large (max 48 h).');
    return cached(ctx, 'track', { icao24, begin: String(Math.floor(begin / 1000)), end: String(Math.floor(end / 1000)) }, TRACK_TTL, async () => {
      const { r, errored } = await trackByIcao24(env, icao24, begin, end);
      if (r) return json(r);
      return errored ? errorResponse(502, 'Track providers are currently unavailable.') : errorResponse(404, 'No track found.');
    });
  }

  const fn = parseFlightNumber(q.get('number'));
  const date = q.get('date');
  if (!fn) return errorResponse(400, 'Provide "number" and "date", or "icao24", "begin" and "end".');
  if (!isIsoDate(date)) return errorResponse(400, 'Invalid or missing "date" (expected YYYY-MM-DD).');
  return cached(ctx, 'track', { number: fn.normalized, date }, TRACK_TTL, async () => {
    const { r, errored } = await trackByNumber(env, fn.normalized, date);
    if (r) return json(r);
    return errored ? errorResponse(502, 'Track providers are currently unavailable.') : errorResponse(404, 'No track found for that flight.');
  });
};
