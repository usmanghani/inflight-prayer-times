import type { Ctx, Env, Handler } from '../env';
import { FLIGHT_TTL, cached } from '../lib/cache';
import { parseFlightNumber } from '../lib/airlines';
import { errorResponse, isIsoDate, json, warnUpstream } from '../lib/http';
import type { FlightResult } from '../lib/types';
import { lookupAdsbdb } from '../providers/adsbdb';
import { lookupAeroDataBox } from '../providers/aerodatabox';
import { fetchAeroApiFlights } from '../providers/flightaware';

/** Run the provider chain. `errored` = at least one provider failed (as opposed to "not found"). */
export async function lookupFlightLegs(
  env: Env,
  number: string,
  date: string,
): Promise<{ result: FlightResult | null; errored: boolean }> {
  let errored = false;
  const attempts: Array<[FlightResult['source'], () => Promise<FlightResult['legs'] | null>]> = [
    ['aerodatabox', () => lookupAeroDataBox(env, number, date)],
    ['flightaware', async () => (await fetchAeroApiFlights(env, number, date))?.map(stripFa) ?? null],
    ['adsbdb', () => lookupAdsbdb(number)],
  ];
  for (const [source, run] of attempts) {
    try {
      const legs = await run();
      if (legs && legs.length) return { result: { source, legs }, errored };
    } catch (e) {
      errored = true;
      warnUpstream(e);
    }
  }
  return { result: null, errored };
}

function stripFa<T extends { faFlightId?: string; cancelled?: boolean }>(
  leg: T,
): Omit<T, 'faFlightId' | 'cancelled'> {
  const { faFlightId: _a, cancelled: _b, ...rest } = leg;
  return rest;
}

export const flight: Handler = async (req: Request, env: Env, ctx: Ctx) => {
  const url = new URL(req.url);
  const fn = parseFlightNumber(url.searchParams.get('number'));
  const date = url.searchParams.get('date');
  if (!fn) return errorResponse(400, 'Invalid or missing "number" (expected e.g. EK226).');
  if (!isIsoDate(date)) return errorResponse(400, 'Invalid or missing "date" (expected YYYY-MM-DD).');

  return cached(ctx, 'flight', { number: fn.normalized, date }, FLIGHT_TTL, async () => {
    const { result, errored } = await lookupFlightLegs(env, fn.normalized, date);
    if (result) return json(result);
    if (errored) return errorResponse(502, 'Flight data providers are currently unavailable.');
    return errorResponse(404, 'No flight found for that number and date.');
  });
};
