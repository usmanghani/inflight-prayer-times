import { FLIGHT_LIBRARY, normalizeFlightNumber } from '../../../src/data/flights';

/** IATA 2-letter airline code → ICAO 3-letter telephony prefix used in ADS-B callsigns. */
export const IATA_TO_ICAO_AIRLINE: Record<string, string> = {
  AA: 'AAL', // American Airlines
  AF: 'AFR', // Air France
  AI: 'AIC', // Air India
  AT: 'RAM', // Royal Air Maroc
  AV: 'AVA', // Avianca
  BA: 'BAW', // British Airways
  BR: 'EVA', // EVA Air
  CX: 'CPA', // Cathay Pacific
  DL: 'DAL', // Delta
  EK: 'UAE', // Emirates
  ET: 'ETH', // Ethiopian
  EY: 'ETD', // Etihad
  FZ: 'FDB', // flydubai
  IB: 'IBE', // Iberia
  JL: 'JAL', // Japan Airlines
  KE: 'KAL', // Korean Air
  KL: 'KLM', // KLM
  KQ: 'KQA', // Kenya Airways
  LA: 'LAN', // LATAM (Chile; LATAM Brasil uses TAM)
  LH: 'DLH', // Lufthansa
  MS: 'MSR', // EgyptAir
  MU: 'CES', // China Eastern
  NH: 'ANA', // All Nippon Airways
  NZ: 'ANZ', // Air New Zealand
  PK: 'PIA', // Pakistan International Airlines
  PR: 'PAL', // Philippine Airlines
  QF: 'QFA', // Qantas
  QR: 'QTR', // Qatar Airways
  SA: 'SAA', // South African
  SQ: 'SIA', // Singapore Airlines
  SV: 'SVA', // Saudia
  TK: 'THY', // Turkish Airlines
  UA: 'UAL', // United
  // extras (not in the library yet, handy when it grows)
  AC: 'ACA', AY: 'FIN', CA: 'CCA', CZ: 'CSN', GF: 'GFA', GA: 'GIA', JJ: 'TAM', MH: 'MAS',
  OZ: 'AAR', QQ: 'UTY', SK: 'SAS', TG: 'THA', VS: 'VIR', WY: 'OMA', XY: 'KNE', J2: 'AHY',
  PS: 'AUI', RJ: 'RJA', ME: 'MEA', SU: 'AFL', KU: 'KAC', G9: 'ABY', AZ: 'ITY', LX: 'SWR',
};

export interface SplitFlight { airline: string; number: string }

export function splitFlightNumber(flightNumber: string): SplitFlight | undefined {
  const m = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(normalizeFlightNumber(flightNumber));
  return m ? { airline: m[1], number: m[2] } : undefined;
}

/** "EK226" → "UAE226" (undefined when the airline has no mapping). */
export function toIcaoCallsign(flightNumber: string): string | undefined {
  const s = splitFlightNumber(flightNumber);
  if (!s) return undefined;
  const icao = IATA_TO_ICAO_AIRLINE[s.airline];
  return icao ? `${icao}${s.number}` : undefined;
}

/** Airlines used by the library that have no ICAO mapping (should be empty; checked by verify-library). */
export function unmappedLibraryAirlines(): string[] {
  const missing = new Set<string>();
  for (const f of FLIGHT_LIBRARY) {
    const s = splitFlightNumber(f.flightNumber);
    if (!s || !IATA_TO_ICAO_AIRLINE[s.airline]) missing.add(s?.airline ?? f.flightNumber);
  }
  return [...missing];
}
