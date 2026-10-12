import type { Env } from '../env';
import { upstreamJson } from '../lib/http';
import { toIso } from '../lib/time';
import type { FlightLegInfo } from '../lib/types';

interface AdbTime {
  utc?: string;
  local?: string;
}
interface AdbEndpoint {
  airport?: { iata?: string; icao?: string };
  scheduledTime?: AdbTime;
  scheduledTimeUtc?: string; // older response shape
  revisedTime?: AdbTime;
  runwayTime?: AdbTime;
  actualTimeUtc?: string; // older response shape
}
interface AdbFlight {
  number?: string;
  departure?: AdbEndpoint;
  arrival?: AdbEndpoint;
  aircraft?: { reg?: string; modeS?: string; model?: string };
  codeshareStatus?: string;
  status?: string;
}

/** Pure normaliser (exported for tests). */
export function normalizeAeroDataBox(data: unknown, fallbackNumber: string): FlightLegInfo[] {
  const list: AdbFlight[] = Array.isArray(data) ? data : [];
  const hasOperator = list.some((f) => f.codeshareStatus === 'IsOperator');
  const out: FlightLegInfo[] = [];
  for (const f of list) {
    if (hasOperator && f.codeshareStatus && f.codeshareStatus !== 'IsOperator') continue;
    const from = f.departure?.airport?.iata?.toUpperCase();
    const to = f.arrival?.airport?.iata?.toUpperCase();
    if (!from || !to) continue;
    const leg: FlightLegInfo = {
      flightNumber: (f.number ?? fallbackNumber).replace(/\s+/g, '').toUpperCase(),
      from,
      to,
    };
    const sd = toIso(f.departure?.scheduledTime?.utc ?? f.departure?.scheduledTimeUtc);
    const sa = toIso(f.arrival?.scheduledTime?.utc ?? f.arrival?.scheduledTimeUtc);
    const ad = toIso(f.departure?.runwayTime?.utc ?? f.departure?.actualTimeUtc);
    const aa = toIso(f.arrival?.runwayTime?.utc ?? f.arrival?.actualTimeUtc);
    if (sd) leg.scheduledDepartureUtc = sd;
    if (sa) leg.scheduledArrivalUtc = sa;
    if (ad) leg.actualDepartureUtc = ad;
    if (aa) leg.actualArrivalUtc = aa;
    const modeS = f.aircraft?.modeS?.toLowerCase();
    if (modeS && /^[0-9a-f]{6}$/.test(modeS)) leg.aircraftIcao24 = modeS;
    if (f.aircraft?.model) leg.aircraftType = f.aircraft.model;
    out.push(leg);
  }
  return out;
}

export async function lookupAeroDataBox(env: Env, number: string, date: string): Promise<FlightLegInfo[] | null> {
  if (!env.AERODATABOX_API_KEY) return null;
  const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(number)}/${date}`;
  const data = await upstreamJson('aerodatabox', url, {
    headers: {
      'X-RapidAPI-Key': env.AERODATABOX_API_KEY,
      'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
      Accept: 'application/json',
    },
  });
  if (data == null) return [];
  return normalizeAeroDataBox(data, number);
}
