import { describe, it, expect } from 'vitest';
import {
  FLIGHT_LIBRARY, LIVE_TRACK_FIXTURES, SAMPLE_ID_ALIASES, SAMPLE_ITINERARIES, findLibraryFlight, findSampleItinerary,
  itineraryToLegs, libraryFlightToLeg, resolveSampleId,
  type RouteRegion,
} from '../src/data/flights';
import { getAirport, resolveAirport } from '../src/data/airports';
import verificationRun from './fixtures/library-verification.json';
import { loadTrackFixtures } from './fixtures/loadFixtures';

const US_EAST = new Set(['JFK', 'EWR', 'IAD', 'BOS', 'ATL', 'MIA', 'PHL']);
const US_WEST = new Set(['SFO', 'LAX', 'SEA']);
const US_CENTRAL = new Set(['DFW', 'IAH', 'ORD']);
const isUS = (c: string): boolean => US_EAST.has(c) || US_WEST.has(c) || US_CENTRAL.has(c);

/**
 * City pairs that exist in only one direction in the library, because the reverse flight could not be
 * confirmed (adsbdb + live ADS-B) — never padded with an unconfirmed flight number.
 */
const ONE_WAY_PAIRS: Record<string, string> = {
  'IST-SFO': 'Turkish IST->SFO (TK79) is confirmed; adsbdb maps TK80 (the SFO->IST number) to IST-JNB and knows no other SFO->IST Turkish flight. LAX<->IST is covered both ways (TK9/TK10).',
  'IAD-ADD': 'Ethiopian IAD->ADD (ET501) is confirmed; adsbdb has no ADD->IAD flight (the return is ET500, which it maps to DUB-IAD, a stopover leg).',
};

/**
 * Region x US coast x direction combinations that have no confirmed nonstop flight (no scheduled nonstop exists,
 * or adsbdb knows none). direction is relative to the US: 'outbound' leaves the US, 'return' heads back to it.
 */
const COVERAGE_GAPS: Record<string, string> = {
  'north-africa|west|outbound': 'no nonstop US west coast - North Africa flight',
  'north-africa|west|return': 'no nonstop US west coast - North Africa flight',
  'east-africa|west|outbound': 'no nonstop US west coast - East Africa flight',
  'east-africa|west|return': 'no nonstop US west coast - East Africa flight',
  'east-africa|east|return': 'ADD->US has no confirmed nonstop (ET500 is a DUB-IAD stopover leg in adsbdb); Kenya Airways JFK-NBO is not in adsbdb',
  'west-africa|west|outbound': 'no nonstop US west coast - West Africa flight',
  'west-africa|west|return': 'no nonstop US west coast - West Africa flight',
  'south-africa|west|outbound': 'no nonstop US west coast - South Africa flight',
  'south-africa|west|return': 'no nonstop US west coast - South Africa flight',
  'australia|east|outbound': 'no nonstop US east coast - Australia flight (shortest are one-stop via LAX/DFW/Doha)',
  'australia|east|return': 'no nonstop US east coast - Australia flight (shortest are one-stop via LAX/DFW/Doha)',
  'new-zealand|east|outbound': 'no confirmed nonstop US east coast - New Zealand flight (adsbdb knows only NZ1-12 via LAX/SFO/HNL)',
  'new-zealand|east|return': 'no confirmed nonstop US east coast - New Zealand flight (adsbdb knows only NZ1-12 via LAX/SFO/HNL)',
};

const REQUIRED_COVERAGE_REGIONS: RouteRegion[] = [
  'south-asia', 'middle-east', 'europe', 'north-africa', 'east-africa', 'west-africa', 'south-africa',
  'south-america', 'east-asia', 'southeast-asia', 'australia', 'new-zealand', 'polar',
];

const REGIONS: RouteRegion[] = [
  'south-asia', 'middle-east', 'east-asia', 'southeast-asia', 'europe', 'north-africa', 'east-africa',
  'west-africa', 'south-africa', 'south-america', 'australia', 'new-zealand', 'polar', 'domestic-us',
];

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Highest latitude (degrees) reached by the great circle between two airports. */
function maxGreatCircleLat(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const v = (p: { lat: number; lon: number }): number[] => [Math.cos(p.lat * r) * Math.cos(p.lon * r), Math.cos(p.lat * r) * Math.sin(p.lon * r), Math.sin(p.lat * r)];
  const p = v(a);
  const q = v(b);
  const omega = Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
  let best = -90;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const z = (Math.sin((1 - t) * omega) * p[2] + Math.sin(t * omega) * q[2]) / Math.sin(omega);
    best = Math.max(best, Math.asin(Math.max(-1, Math.min(1, z))) / r);
  }
  return best;
}

describe('FLIGHT_LIBRARY data integrity', () => {
  it('is large enough and has unique flight numbers', () => {
    expect(FLIGHT_LIBRARY.length).toBeGreaterThanOrEqual(70);
    const nums = FLIGHT_LIBRARY.map((f) => f.flightNumber);
    expect(new Set(nums).size).toBe(nums.length);
    for (const n of nums) expect(n).toMatch(/^[A-Z0-9]{2}\d{1,4}$/);
  });

  it('every IATA code exists in the airport database', () => {
    for (const f of FLIGHT_LIBRARY) {
      expect(getAirport(f.from), `${f.flightNumber} from ${f.from}`).toBeDefined();
      expect(getAirport(f.to), `${f.flightNumber} to ${f.to}`).toBeDefined();
      expect(f.from).not.toBe(f.to);
    }
  });

  it('has valid enums and HH:mm times', () => {
    for (const f of FLIGHT_LIBRARY) {
      expect(f.depLocal).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(f.arrLocal).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect([-1, 0, 1, 2]).toContain(f.arrDayOffset);
      expect(REGIONS).toContain(f.region);
      expect(['east', 'west', 'none']).toContain(f.usCoast);
      expect(['outbound', 'return']).toContain(f.direction);
      expect(f.airline.length).toBeGreaterThan(1);
    }
  });

  it('usCoast matches the US airport used', () => {
    for (const f of FLIGHT_LIBRARY) {
      const us = isUS(f.from) ? f.from : isUS(f.to) ? f.to : undefined;
      const expected = !us ? 'none' : US_EAST.has(us) ? 'east' : US_WEST.has(us) ? 'west' : 'none';
      expect(f.usCoast, f.flightNumber).toBe(expected);
    }
  });

  it('direction: outbound leaves the US/Pakistan side, return heads back', () => {
    const home = (c: string): boolean => isUS(c) || ['KHI', 'LHE', 'ISB'].includes(c);
    for (const f of FLIGHT_LIBRARY) {
      if (home(f.from) && !home(f.to)) expect(f.direction, f.flightNumber).toBe('outbound');
      if (home(f.to) && !home(f.from)) expect(f.direction, f.flightNumber).toBe('return');
    }
  });

  it('covers both directions of every city pair (except the documented one-way pairs)', () => {
    const pairs = new Set(FLIGHT_LIBRARY.map((f) => `${f.from}-${f.to}`));
    const oneWay = [...pairs].filter((p) => !pairs.has(p.split('-').reverse().join('-'))).sort();
    // Every exception must be explained, and the list must not go stale.
    expect(oneWay).toEqual(Object.keys(ONE_WAY_PAIRS).sort());
    for (const [pair, reason] of Object.entries(ONE_WAY_PAIRS)) expect(reason.length, pair).toBeGreaterThan(20);
  });

  it('covers every region and both US coasts', () => {
    for (const r of REGIONS) {
      expect(FLIGHT_LIBRARY.filter((f) => f.region === r).length, r).toBeGreaterThanOrEqual(2);
    }
    expect(FLIGHT_LIBRARY.filter((f) => f.usCoast === 'east').length).toBeGreaterThan(20);
    expect(FLIGHT_LIBRARY.filter((f) => f.usCoast === 'west').length).toBeGreaterThan(20);
    expect(FLIGHT_LIBRARY.filter((f) => f.region === 'polar').length).toBeGreaterThanOrEqual(4);
    const has = (a: string, b: string): boolean => FLIGHT_LIBRARY.some((f) => f.from === a && f.to === b);
    for (const [a, b] of [
      ['KHI', 'DXB'], ['KHI', 'DOH'], ['KHI', 'IST'], ['KHI', 'JED'], ['KHI', 'AUH'], ['LHE', 'DXB'], ['ISB', 'DXB'],
      ['JFK', 'HKG'], ['EWR', 'HKG'], ['SFO', 'DXB'], ['EWR', 'SIN'], ['LAX', 'SYD'], ['JFK', 'JNB'], ['SFO', 'AKL'],
      ['JFK', 'CMN'], ['JFK', 'CAI'], ['JFK', 'ACC'], ['ATL', 'LOS'],
      ['JFK', 'GRU'], ['JFK', 'EZE'], ['JFK', 'SCL'], ['JFK', 'BOG'], ['JFK', 'LIM'], ['LAX', 'LIM'], ['SFO', 'HND'],
      ['JFK', 'HND'], ['JFK', 'ICN'], ['LAX', 'TPE'], ['LAX', 'PVG'], ['LAX', 'MEL'], ['LAX', 'BNE'],
      ['EWR', 'DEL'], ['SFO', 'LHR'], ['JFK', 'CDG'], ['JFK', 'FRA'], ['JFK', 'AMS'], ['JFK', 'MAD'], ['DXB', 'BOM'],
      ['DXB', 'BLR'], ['SFO', 'MNL'], ['DXB', 'CPT'], ['KHI', 'RUH'], ['DOH', 'PHL'], ['AUH', 'JFK'],
    ] as const) {
      expect(has(a, b), `${a}-${b}`).toBe(true);
      expect(has(b, a), `${b}-${a}`).toBe(true);
    }
  });
});

describe('region x US coast x direction coverage', () => {
  const count = (region: RouteRegion, coast: 'east' | 'west', direction: 'outbound' | 'return'): number =>
    FLIGHT_LIBRARY.filter((f) => f.region === region && f.usCoast === coast && f.direction === direction).length;

  for (const region of REQUIRED_COVERAGE_REGIONS) {
    for (const coast of ['east', 'west'] as const) {
      for (const direction of ['outbound', 'return'] as const) {
        const key = `${region}|${coast}|${direction}`;
        if (COVERAGE_GAPS[key]) continue;
        it(`${region}: US ${coast} coast, ${direction}`, () => {
          expect(count(region, coast, direction), key).toBeGreaterThanOrEqual(1);
        });
      }
    }
  }

  it('the documented coverage gaps are real gaps (the allow-list does not go stale)', () => {
    for (const [key, reason] of Object.entries(COVERAGE_GAPS)) {
      const [region, coast, direction] = key.split('|') as [RouteRegion, 'east' | 'west', 'outbound' | 'return'];
      expect(REQUIRED_COVERAGE_REGIONS, key).toContain(region);
      expect(count(region, coast, direction), `${key} now has flights: remove it from COVERAGE_GAPS`).toBe(0);
      expect(reason.length, key).toBeGreaterThan(15);
    }
  });

  it('Karachi is connected both ways to the Gulf, Istanbul and Jeddah/Riyadh with real flights', () => {
    const has = (a: string, b: string): boolean => FLIGHT_LIBRARY.some((f) => f.from === a && f.to === b);
    for (const hub of ['DXB', 'DOH', 'AUH', 'IST', 'JED', 'RUH']) {
      expect(has('KHI', hub), `KHI-${hub}`).toBe(true);
      expect(has(hub, 'KHI'), `${hub}-KHI`).toBe(true);
    }
  });

  it('the polar region really is high-latitude (great circle >= 78 N) and SQ21/SQ22 are not called polar', () => {
    for (const fl of FLIGHT_LIBRARY.filter((x) => x.region === 'polar')) {
      const a = getAirport(fl.from)!;
      const b = getAirport(fl.to)!;
      expect(maxGreatCircleLat(a, b), fl.flightNumber).toBeGreaterThanOrEqual(78);
    }
    for (const n of ['SQ21', 'SQ22']) expect(findLibraryFlight(n)!.region).not.toBe('polar'); // live ADS-B: via Europe/Canada, max 54-63 N
  });
});

describe('route verification (adsbdb / adsb.lol / manual)', () => {
  const rows = (verificationRun as { rows: { flightNumber: string; libraryRoute: string; adsbdbRoute: string | null; status: string; checkedAt: string }[] }).rows;
  const rowByFlight = new Map(rows.map((r) => [r.flightNumber, r]));

  it('every entry has a verification record with a valid source and date', () => {
    for (const f of FLIGHT_LIBRARY) {
      expect(f.verification, f.flightNumber).toBeDefined();
      expect(['adsbdb', 'adsb.lol', 'manual'], f.flightNumber).toContain(f.verification!.source);
      expect(f.verification!.checkedAt, f.flightNumber).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("'manual' verification always explains why adsbdb is overridden", () => {
    for (const f of FLIGHT_LIBRARY.filter((x) => x.verification?.source === 'manual')) {
      expect((f.verification!.note ?? '').length, `${f.flightNumber} manual override needs a note`).toBeGreaterThan(20);
    }
  });

  it('library-verification.json covers exactly the library, and every non-manual entry is an adsbdb match', () => {
    expect(rows.map((r) => r.flightNumber).sort()).toEqual(FLIGHT_LIBRARY.map((f) => f.flightNumber).sort());
    for (const f of FLIGHT_LIBRARY) {
      const row = rowByFlight.get(f.flightNumber)!;
      expect(row.libraryRoute, f.flightNumber).toBe(`${f.from}-${f.to}`);
      if (f.verification!.source === 'manual') {
        expect(row.status, `${f.flightNumber}: manual override of an adsbdb answer`).not.toBe('match');
      } else {
        expect(row.status, `${f.flightNumber} ${f.from}-${f.to} vs adsbdb ${row.adsbdbRoute}`).toBe('match');
      }
    }
  });

  it("'adsb.lol' entries are backed by a live track fixture with the same flight and route", () => {
    const fixtures = loadTrackFixtures();
    for (const f of FLIGHT_LIBRARY.filter((x) => x.verification?.source === 'adsb.lol')) {
      const file = LIVE_TRACK_FIXTURES[f.flightNumber];
      expect(file, f.flightNumber).toBeDefined();
      const fx = fixtures.find((x) => x.file === file);
      expect(fx, `${f.flightNumber}: fixture ${file}`).toBeDefined();
      expect(fx!.meta.flightNumber).toBe(f.flightNumber);
      expect(`${fx!.meta.from}-${fx!.meta.to}`, f.flightNumber).toBe(`${f.from}-${f.to}`);
      expect(f.verification!.checkedAt).toBe(fx!.meta.date);
    }
    expect(Object.keys(LIVE_TRACK_FIXTURES).sort()).toEqual(
      FLIGHT_LIBRARY.filter((x) => x.verification?.source === 'adsb.lol').map((x) => x.flightNumber).sort(),
    );
  });

  it('every live track fixture of a library flight agrees with the library route (no silent contradictions)', () => {
    for (const fx of loadTrackFixtures()) {
      const lib = findLibraryFlight(fx.meta.flightNumber);
      if (lib) expect(`${lib.from}-${lib.to}`, fx.file).toBe(`${fx.meta.from}-${fx.meta.to}`);
    }
  });

  it('flight numbers corrected from the adsbdb audit now point the right way', () => {
    const route = (n: string): string => { const f = findLibraryFlight(n)!; return `${f.from}-${f.to}`; };
    expect(route('JL5')).toBe('JFK-HND');   // live ADS-B 2026-10-11
    expect(route('LH400')).toBe('FRA-JFK');
    expect(route('LH401')).toBe('JFK-FRA');
    expect(route('UA82')).toBe('EWR-DEL');  // live ADS-B 2026-10-12
    expect(route('QR727')).toBe('DOH-PHL'); // live ADS-B 2026-10-12
    expect(route('NZ8')).toBe('AKL-SFO');   // live ADS-B 2026-10-12
    expect(route('EK201')).toBe('DXB-JFK');
    expect(route('EK202')).toBe('JFK-DXB');
    expect(route('BA117')).toBe('LHR-JFK');
    expect(route('BA112')).toBe('JFK-LHR');
    expect(route('QR7')).toBe('DOH-LHR');
    expect(route('QR8')).toBe('LHR-DOH');
    expect(route('TK719')).toBe('KHI-IST');
    expect(route('TK718')).toBe('IST-KHI');
  });
});

describe('findLibraryFlight', () => {
  it('normalises case and spaces', () => {
    const a = findLibraryFlight('EK226')!;
    expect(a).toBeDefined();
    expect(findLibraryFlight('EK 226')).toBe(a);
    expect(findLibraryFlight('ek 226')).toBe(a);
    expect(findLibraryFlight('EK-226')).toBe(a);
    expect(findLibraryFlight('XX999')).toBeUndefined();
    expect(findLibraryFlight('')).toBeUndefined();
  });
});

describe('libraryFlightToLeg', () => {
  it('converts local times to UTC with the airport time zones (DST in force: US summer time)', () => {
    const ek226 = findLibraryFlight('EK226')!; // SFO 16:35 -> DXB 19:25 +1
    const leg = libraryFlightToLeg(ek226, '2026-10-12', resolveAirport);
    expect(leg.from).toBe('SFO');
    expect(leg.to).toBe('DXB');
    expect(leg.flightNumber).toBe('EK226');
    expect(leg.departureUtc.toISOString()).toBe('2026-10-12T23:35:00.000Z'); // PDT = UTC-7
    expect(leg.arrivalUtc.toISOString()).toBe('2026-10-13T15:25:00.000Z'); // GST = UTC+4
    expect(leg.id).toBe('EK226-2026-10-12');
    expect(libraryFlightToLeg(ek226, '2026-10-12', resolveAirport, 'custom').id).toBe('custom');
  });

  it('is DST-correct in winter (US standard time)', () => {
    const leg = libraryFlightToLeg(findLibraryFlight('EK226')!, '2026-12-15', resolveAirport);
    expect(leg.departureUtc.toISOString()).toBe('2026-12-16T00:35:00.000Z'); // PST = UTC-8
    expect(leg.arrivalUtc.toISOString()).toBe('2026-12-16T15:25:00.000Z');
  });

  it('handles the US fall-back and spring-forward days', () => {
    // 2026-11-01 DST ends in the US at 02:00 local; 23:00 is EST (UTC-5)
    const jfk = libraryFlightToLeg(findLibraryFlight('EK202')!, '2026-11-01', resolveAirport); // JFK 23:00 -> DXB
    expect(jfk.departureUtc.toISOString()).toBe('2026-11-02T04:00:00.000Z');
    // 2026-03-08 DST starts at 02:00 local; 22:35 is PDT (UTC-7)
    const lax = libraryFlightToLeg(findLibraryFlight('QF12')!, '2026-03-08', resolveAirport);
    expect(lax.departureUtc.toISOString()).toBe('2026-03-09T05:35:00.000Z');
  });

  it('handles the European change (London) and zones without DST (Karachi, Dubai)', () => {
    const ek2 = findLibraryFlight('EK2')!; // LHR 14:20
    expect(libraryFlightToLeg(ek2, '2026-10-24', resolveAirport).departureUtc.toISOString()).toBe('2026-10-24T13:20:00.000Z'); // BST
    expect(libraryFlightToLeg(ek2, '2026-10-25', resolveAirport).departureUtc.toISOString()).toBe('2026-10-25T14:20:00.000Z'); // GMT
    const ek601 = libraryFlightToLeg(findLibraryFlight('EK601')!, '2026-07-01', resolveAirport);
    expect(ek601.departureUtc.toISOString()).toBe('2026-06-30T21:55:00.000Z'); // PKT = UTC+5
    expect(ek601.arrivalUtc.toISOString()).toBe('2026-07-01T00:20:00.000Z'); // GST = UTC+4
  });

  it('crosses the date line (LAX -> SYD arrives two calendar days later)', () => {
    const leg = libraryFlightToLeg(findLibraryFlight('QF12')!, '2026-10-12', resolveAirport);
    const hours = (leg.arrivalUtc.getTime() - leg.departureUtc.getTime()) / 3.6e6;
    expect(hours).toBeGreaterThan(13);
    expect(hours).toBeLessThan(16);
  });

  it('accepts leap days, rejects bad input', () => {
    const leg = libraryFlightToLeg(findLibraryFlight('EK226')!, '2028-02-29', resolveAirport);
    expect(leg.departureUtc.toISOString()).toBe('2028-03-01T00:35:00.000Z');
    expect(() => libraryFlightToLeg(findLibraryFlight('EK226')!, '12/10/2026', resolveAirport)).toThrow();
    expect(() => libraryFlightToLeg(findLibraryFlight('EK226')!, '2026-10-12', () => undefined)).toThrow();
  });

  it('produces plausible block times and ground speeds for every library flight in every season', () => {
    for (const date of ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-12', '2026-11-20']) {
      for (const f of FLIGHT_LIBRARY) {
        const leg = libraryFlightToLeg(f, date, resolveAirport);
        const a = getAirport(f.from)!;
        const b = getAirport(f.to)!;
        const hours = (leg.arrivalUtc.getTime() - leg.departureUtc.getTime()) / 3.6e6;
        const dist = km(a, b);
        expect(hours, `${f.flightNumber} ${date}`).toBeGreaterThan(1);
        expect(hours, `${f.flightNumber} ${date}`).toBeLessThan(21);
        // average block speed (incl. taxi/climb) for the reference season stays in a sane range
        const speed = dist / hours;
        if (date === '2026-10-12') {
          expect(speed, `${f.flightNumber} speed`).toBeGreaterThan(dist < 2500 ? 380 : 560);
          expect(speed, `${f.flightNumber} speed`).toBeLessThan(970);
        } else {
          // DST can shift the block time by about an hour
          expect(speed, `${f.flightNumber} speed ${date}`).toBeGreaterThan(300);
          expect(speed, `${f.flightNumber} speed ${date}`).toBeLessThan(1150);
        }
      }
    }
  });
});

describe('SAMPLE_ITINERARIES', () => {
  it('has the required demos with unique ids', () => {
    const ids = SAMPLE_ITINERARIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SAMPLE_ITINERARIES.length).toBeGreaterThanOrEqual(12);
    for (const id of [
      'khi-dxb-sfo', 'sfo-dxb-khi', 'khi-doh-sfo', 'sfo-doh-khi', 'khi-ist-sfo', 'lax-ist-khi', 'jfk-doh-khi',
      'khi-dxb-jfk', 'sfo-lhr-dxb-khi', 'lax-syd', 'jfk-jnb', 'sfo-akl', 'jfk-hkg-polar', 'ewr-hkg-polar', 'ewr-sin',
    ]) expect(ids, id).toContain(id);
  });

  it('renamed sample ids stay resolvable through SAMPLE_ID_ALIASES', () => {
    const ids = new Set(SAMPLE_ITINERARIES.map((s) => s.id));
    expect(Object.keys(SAMPLE_ID_ALIASES).sort()).toEqual(['ewr-sin-polar', 'sfo-ist-khi']);
    for (const [old, now] of Object.entries(SAMPLE_ID_ALIASES)) {
      expect(ids.has(old), `${old} is an alias, not a current id`).toBe(false);
      expect(ids.has(now), `${old} -> ${now}`).toBe(true);
      expect(findSampleItinerary(old)?.id).toBe(now);
    }
    expect(resolveSampleId('khi-dxb-sfo')).toBe('khi-dxb-sfo');
    expect(findSampleItinerary('nope')).toBeUndefined();
  });

  it("only samples whose legs are really polar (great circle >= 78 N) are called 'polar'", () => {
    for (const s of SAMPLE_ITINERARIES) {
      const legs = s.legs.map((l) => findLibraryFlight(l.flightNumber)!);
      if (/polar/i.test(s.id) || /polar route/i.test(s.title)) {
        for (const fl of legs) expect(fl.region, `${s.id} ${fl.flightNumber}`).toBe('polar');
      }
    }
    expect(SAMPLE_ITINERARIES.find((s) => s.id === 'ewr-sin')!.title).not.toMatch(/polar route\)/i);
  });

  for (const startDate of ['2026-10-12', '2027-01-15', '2027-03-08', '2027-07-04', '2026-11-01']) {
    it(`every itinerary builds consistent legs (start ${startDate}): chained airports, 45 min - 24 h layovers`, () => {
      for (const it of SAMPLE_ITINERARIES) {
        const legs = itineraryToLegs(it, startDate, resolveAirport);
        expect(legs).toHaveLength(it.legs.length);
        const ids = new Set(legs.map((l) => l.id));
        expect(ids.size).toBe(legs.length);
        legs.forEach((leg, i) => {
          expect(leg.arrivalUtc.getTime(), `${it.id} leg ${i + 1}`).toBeGreaterThan(leg.departureUtc.getTime());
          if (i > 0) {
            const prev = legs[i - 1];
            expect(prev.to, `${it.id} connection airport`).toBe(leg.from);
            const layoverMin = (leg.departureUtc.getTime() - prev.arrivalUtc.getTime()) / 60000;
            expect(layoverMin, `${it.id} layover before ${leg.flightNumber}`).toBeGreaterThanOrEqual(45);
            expect(layoverMin, `${it.id} layover before ${leg.flightNumber}`).toBeLessThanOrEqual(24 * 60);
          }
        });
      }
    });
  }

  it('first leg departs on the start date (local) and dayOffsets are non-negative and non-decreasing', () => {
    for (const it of SAMPLE_ITINERARIES) {
      expect(it.legs[0].dayOffset).toBe(0);
      for (let i = 1; i < it.legs.length; i++) expect(it.legs[i].dayOffset).toBeGreaterThanOrEqual(it.legs[i - 1].dayOffset);
      for (const l of it.legs) expect(findLibraryFlight(l.flightNumber), l.flightNumber).toBeDefined();
    }
  });

  it('KHI -> DXB -> SFO matches the spec example', () => {
    const it = SAMPLE_ITINERARIES.find((s) => s.id === 'khi-dxb-sfo')!;
    const legs = itineraryToLegs(it, '2026-10-12', resolveAirport);
    expect(legs.map((l) => `${l.from}-${l.to}`)).toEqual(['KHI-DXB', 'DXB-SFO']);
    expect(legs[0].flightNumber).toBe('EK601');
    expect(legs[1].flightNumber).toBe('EK225');
  });

  it('throws on unknown flight numbers', () => {
    expect(() => itineraryToLegs({ id: 'x', title: 'x', legs: [{ flightNumber: 'ZZ1', dayOffset: 0 }] }, '2026-10-12', resolveAirport)).toThrow();
  });
});
