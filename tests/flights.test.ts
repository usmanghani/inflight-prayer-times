import { describe, it, expect } from 'vitest';
import {
  FLIGHT_LIBRARY, SAMPLE_ITINERARIES, findLibraryFlight, itineraryToLegs, libraryFlightToLeg,
  type RouteRegion,
} from '../src/data/flights';
import { getAirport, resolveAirport } from '../src/data/airports';

const US_EAST = new Set(['JFK', 'EWR', 'IAD', 'BOS', 'ATL', 'MIA']);
const US_WEST = new Set(['SFO', 'LAX', 'SEA']);
const US_CENTRAL = new Set(['DFW', 'IAH', 'ORD']);
const isUS = (c: string): boolean => US_EAST.has(c) || US_WEST.has(c) || US_CENTRAL.has(c);

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

  it('covers both directions of every city pair', () => {
    const pairs = new Set(FLIGHT_LIBRARY.map((f) => `${f.from}-${f.to}`));
    for (const f of FLIGHT_LIBRARY) {
      expect(pairs.has(`${f.to}-${f.from}`), `no return for ${f.from}-${f.to} (${f.flightNumber})`).toBe(true);
    }
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
      ['JFK', 'HKG'], ['SFO', 'DXB'], ['EWR', 'SIN'], ['LAX', 'SYD'], ['JFK', 'JNB'], ['SFO', 'AKL'],
      ['JFK', 'CMN'], ['JFK', 'CAI'], ['IAD', 'ADD'], ['JFK', 'NBO'], ['JFK', 'ACC'], ['ATL', 'LOS'],
      ['JFK', 'GRU'], ['JFK', 'EZE'], ['JFK', 'SCL'], ['JFK', 'BOG'], ['JFK', 'LIM'], ['SFO', 'HND'],
      ['JFK', 'HND'], ['JFK', 'ICN'], ['LAX', 'TPE'], ['LAX', 'PVG'], ['LAX', 'MEL'], ['SFO', 'BNE'],
      ['EWR', 'DEL'], ['SFO', 'LHR'], ['JFK', 'CDG'], ['JFK', 'FRA'], ['JFK', 'AMS'], ['JFK', 'MAD'], ['DXB', 'BOM'],
      ['DXB', 'BLR'], ['SFO', 'MNL'], ['DXB', 'CPT'],
    ] as const) {
      expect(has(a, b), `${a}-${b}`).toBe(true);
      expect(has(b, a), `${b}-${a}`).toBe(true);
    }
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
    const jfk = libraryFlightToLeg(findLibraryFlight('EK201')!, '2026-11-01', resolveAirport);
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
      'khi-dxb-sfo', 'sfo-dxb-khi', 'khi-doh-sfo', 'sfo-doh-khi', 'khi-ist-sfo', 'sfo-ist-khi', 'jfk-doh-khi',
      'khi-dxb-jfk', 'lax-syd', 'jfk-jnb', 'sfo-akl', 'jfk-hkg-polar',
    ]) expect(ids, id).toContain(id);
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
