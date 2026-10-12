/**
 * adsbdb.com: free crowd-sourced callsign → route database (no key).
 * https://www.adsbdb.com/ · https://api.adsbdb.com/v0/callsign/<callsign>
 * The route reflects what the community currently associates with a callsign, which usually (not always)
 * equals the scheduled routing. Treat it as a strong hint, not ground truth.
 */
import { http, DAY_MS } from '../lib/http';

export interface AdsbdbRoute {
  callsign: string;
  callsignIcao?: string;
  callsignIata?: string;
  airline?: string;
  originIata?: string;
  originIcao?: string;
  destinationIata?: string;
  destinationIcao?: string;
}

export type AdsbdbLookup =
  | { status: 'ok'; route: AdsbdbRoute }
  | { status: 'not-found' }
  | { status: 'error'; error: string };

interface Airp { iata_code?: string; icao_code?: string }
interface Resp {
  response?: string | { flightroute?: { callsign?: string; callsign_icao?: string; callsign_iata?: string; airline?: { name?: string }; origin?: Airp; destination?: Airp } };
}

export function isConfigured(): boolean { return true; }

/** Cached for 7 days: routes change slowly. */
export async function lookupCallsign(callsign: string, ttlMs = 7 * DAY_MS): Promise<AdsbdbLookup> {
  const url = `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`;
  const res = await http(url, { ttlMs });
  // 404 = unknown callsign; 400 = syntactically invalid callsign (e.g. an IATA number such as KQ2)
  if (res.status === 404 || res.status === 400) return { status: 'not-found' };
  if (res.status !== 200) return { status: 'error', error: res.error ?? `HTTP ${res.status}` };
  const body = res.json<Resp>();
  const fr = body && typeof body.response === 'object' ? body.response?.flightroute : undefined;
  if (!fr) return { status: 'not-found' };
  return {
    status: 'ok',
    route: {
      callsign: fr.callsign ?? callsign,
      callsignIcao: fr.callsign_icao,
      callsignIata: fr.callsign_iata,
      airline: fr.airline?.name,
      originIata: fr.origin?.iata_code,
      originIcao: fr.origin?.icao_code,
      destinationIata: fr.destination?.iata_code,
      destinationIcao: fr.destination?.icao_code,
    },
  };
}
