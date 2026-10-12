import type { Env } from '../env';
import { upstreamJson } from '../lib/http';
import { dayRangeUtc, toIso } from '../lib/time';
import type { FlightLegInfo, TrackPointOut } from '../lib/types';

interface FaFlight {
  ident?: string;
  ident_iata?: string;
  fa_flight_id?: string;
  cancelled?: boolean;
  origin?: { code_iata?: string; code?: string } | null;
  destination?: { code_iata?: string; code?: string } | null;
  scheduled_out?: string | null;
  scheduled_off?: string | null;
  scheduled_on?: string | null;
  scheduled_in?: string | null;
  actual_out?: string | null;
  actual_off?: string | null;
  actual_on?: string | null;
  actual_in?: string | null;
  aircraft_type?: string | null;
}

export interface FaFlightWithId extends FlightLegInfo {
  faFlightId?: string;
  cancelled?: boolean;
}

export function normalizeAeroApi(data: unknown, fallbackNumber: string): FaFlightWithId[] {
  const flights: FaFlight[] = (data as { flights?: FaFlight[] } | null)?.flights ?? [];
  const out: FaFlightWithId[] = [];
  for (const f of flights) {
    const from = f.origin?.code_iata?.toUpperCase();
    const to = f.destination?.code_iata?.toUpperCase();
    if (!from || !to) continue;
    const leg: FaFlightWithId = {
      flightNumber: (f.ident_iata ?? f.ident ?? fallbackNumber).toUpperCase(),
      from,
      to,
    };
    const sd = toIso(f.scheduled_out ?? f.scheduled_off);
    const sa = toIso(f.scheduled_in ?? f.scheduled_on);
    const ad = toIso(f.actual_off ?? f.actual_out);
    const aa = toIso(f.actual_on ?? f.actual_in);
    if (sd) leg.scheduledDepartureUtc = sd;
    if (sa) leg.scheduledArrivalUtc = sa;
    if (ad) leg.actualDepartureUtc = ad;
    if (aa) leg.actualArrivalUtc = aa;
    if (f.aircraft_type) leg.aircraftType = f.aircraft_type;
    if (f.fa_flight_id) leg.faFlightId = f.fa_flight_id;
    if (f.cancelled) leg.cancelled = true;
    out.push(leg);
  }
  return out;
}

const BASE = 'https://aeroapi.flightaware.com/aeroapi';

export async function fetchAeroApiFlights(env: Env, ident: string, date: string): Promise<FaFlightWithId[] | null> {
  if (!env.FLIGHTAWARE_API_KEY) return null;
  const { start, end } = dayRangeUtc(date);
  const url = `${BASE}/flights/${encodeURIComponent(ident)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const data = await upstreamJson('flightaware', url, { headers: { 'x-apikey': env.FLIGHTAWARE_API_KEY, Accept: 'application/json' } });
  if (data == null) return [];
  return normalizeAeroApi(data, ident);
}

interface FaPosition {
  altitude?: number | null; // hundreds of feet
  latitude?: number | null;
  longitude?: number | null;
  timestamp?: string | null;
}

/** Pure normaliser for /flights/{id}/track (exported for tests). Altitude is in hundreds of feet. */
export function normalizeAeroApiTrack(data: unknown): TrackPointOut[] {
  const positions: FaPosition[] = (data as { positions?: FaPosition[] } | null)?.positions ?? [];
  const out: TrackPointOut[] = [];
  for (const p of positions) {
    const time = toIso(p.timestamp);
    if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number' || !time) continue;
    const pt: TrackPointOut = { lat: p.latitude, lon: p.longitude, time };
    if (typeof p.altitude === 'number' && Number.isFinite(p.altitude)) {
      pt.altitudeM = Math.round(p.altitude * 100 * 0.3048);
    }
    out.push(pt);
  }
  return out;
}

export async function fetchAeroApiTrack(env: Env, faFlightId: string): Promise<TrackPointOut[] | null> {
  if (!env.FLIGHTAWARE_API_KEY) return null;
  const url = `${BASE}/flights/${encodeURIComponent(faFlightId)}/track`;
  const data = await upstreamJson('flightaware', url, { headers: { 'x-apikey': env.FLIGHTAWARE_API_KEY, Accept: 'application/json' } });
  if (data == null) return [];
  return normalizeAeroApiTrack(data);
}
