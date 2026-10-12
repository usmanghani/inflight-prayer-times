/** IATA -> ICAO airline designators for common carriers (callsign prefixes). */
export const IATA_TO_ICAO: Record<string, string> = {
  EK: 'UAE', QR: 'QTR', TK: 'THY', PK: 'PIA', EY: 'ETD', SV: 'SVA', UA: 'UAL', AA: 'AAL',
  DL: 'DAL', BA: 'BAW', LH: 'DLH', AF: 'AFR', KL: 'KLM', SQ: 'SIA', CX: 'CPA', QF: 'QFA',
  NZ: 'ANZ', NH: 'ANA', JL: 'JAL', KE: 'KAL', ET: 'ETH', KQ: 'KQA', SA: 'SAA', MS: 'MSR',
  AT: 'RAM', LA: 'LAN', AI: 'AIC', AC: 'ACA', VS: 'VIR', IB: 'IBE', AV: 'AVA', CM: 'CMP',
  BR: 'EVA', CI: 'CAL', MU: 'CES', CA: 'CCA', PR: 'PAL', GA: 'GIA', MH: 'MAS', TG: 'THA',
  WY: 'OMA', GF: 'GFA', KU: 'KAC', RJ: 'RJA',
};

export interface ParsedFlightNumber {
  /** Normalised, no spaces, upper case, e.g. "EK226". */
  normalized: string;
  prefix: string;
  digits: string;
  suffix: string;
  /** True if the prefix is a 3-letter ICAO designator. */
  isIcao: boolean;
}

/** Accepts "EK226", "ek 226", "UAE226", "EK0226". Returns null when it does not look like a flight number. */
export function parseFlightNumber(input: string | null | undefined): ParsedFlightNumber | null {
  if (!input) return null;
  const s = input.toUpperCase().replace(/[\s-]+/g, '');
  let m = /^([A-Z]{3})(\d{1,4})([A-Z]?)$/.exec(s);
  if (m) return { normalized: s, prefix: m[1]!, digits: m[2]!, suffix: m[3]!, isIcao: true };
  m = /^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/.exec(s);
  // two-char designators must contain at least one letter
  if (m && /[A-Z]/.test(m[1]!)) return { normalized: s, prefix: m[1]!, digits: m[2]!, suffix: m[3]!, isIcao: false };
  return null;
}

/** Callsign candidates for adsbdb / adsb.lol: ICAO form first, then the IATA form. */
export function callsignCandidates(fn: ParsedFlightNumber): { icao?: string; iata?: string } {
  const digits = fn.digits.replace(/^0+(?=\d)/, '');
  if (fn.isIcao) return { icao: `${fn.prefix}${digits}${fn.suffix}` };
  const icao = IATA_TO_ICAO[fn.prefix];
  return {
    icao: icao ? `${icao}${digits}${fn.suffix}` : undefined,
    iata: `${fn.prefix}${digits}${fn.suffix}`,
  };
}

/** Reverse map for turning an ICAO callsign prefix into IATA, when known. */
export function icaoToIataPrefix(icao: string): string | undefined {
  return Object.keys(IATA_TO_ICAO).find((k) => IATA_TO_ICAO[k] === icao);
}
