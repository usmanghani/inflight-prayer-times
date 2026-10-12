import { callsignCandidates, parseFlightNumber } from '../lib/airlines';
import { upstreamJson } from '../lib/http';
import type { FlightLegInfo } from '../lib/types';

interface AdsbdbAirport {
  iata_code?: string;
}
interface AdsbdbRoute {
  callsign_iata?: string;
  callsign_icao?: string;
  origin?: AdsbdbAirport;
  destination?: AdsbdbAirport;
}

export function normalizeAdsbdb(data: unknown, fallbackNumber: string): FlightLegInfo[] {
  const r = (data as { response?: { flightroute?: AdsbdbRoute } } | null)?.response;
  const fr = r && typeof r === 'object' ? r.flightroute : undefined;
  const from = fr?.origin?.iata_code?.toUpperCase();
  const to = fr?.destination?.iata_code?.toUpperCase();
  if (!from || !to) return [];
  return [{ flightNumber: (fr?.callsign_iata ?? fallbackNumber).toUpperCase(), from, to }];
}

/** Route-only lookup (free, no key). Tries ICAO callsign first, then IATA form. */
export async function lookupAdsbdb(number: string): Promise<FlightLegInfo[] | null> {
  const fn = parseFlightNumber(number);
  if (!fn) return [];
  const { icao, iata } = callsignCandidates(fn);
  for (const cs of [icao, iata]) {
    if (!cs) continue;
    const data = await upstreamJson('adsbdb', `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`);
    const legs = normalizeAdsbdb(data, fn.normalized);
    if (legs.length) return legs;
  }
  return [];
}
