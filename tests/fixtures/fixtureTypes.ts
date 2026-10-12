/** Shared fixture format (see docs/REGRESSION.md). Pure types: safe to import from tests and scripts. */

export type FixtureSource = 'adsblol' | 'opensky' | 'flightaware' | (string & {});

export interface FixtureMeta {
  /** Normalised flight number, e.g. "EK226". */
  flightNumber: string;
  /** ICAO callsign as seen by the source, e.g. "UAE226". */
  callsign: string;
  /** Origin / destination IATA. */
  from: string;
  to: string;
  /** UTC date (YYYY-MM-DD) of the first point. */
  date: string;
  source: FixtureSource;
  attribution: string;
  license: string;
  /** ISO time the data was downloaded. */
  fetchedAt: string;
  icao24?: string;
  /** true = wheels-up area at origin to touchdown area at destination, no coverage hole longer than 6 h. */
  complete: boolean;
  /** Largest time gap between consecutive source fixes before thinning, minutes (coverage holes). */
  maxGapMin?: number;
  notes?: string;
}

export interface FixturePoint {
  /** ISO 8601 UTC. */
  t: string;
  lat: number;
  lon: number;
  /** Altitude above mean sea level, metres, rounded to 10 m. */
  altM: number;
}

export interface TrackFixture {
  meta: FixtureMeta;
  points: FixturePoint[];
}
