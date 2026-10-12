import { describe, it, expect } from 'vitest';
import { allAirports, getAirport, isKnownIata, resolveAirport, searchAirports } from '../src/data/airports';
import raw from '../src/data/airports.json';

describe('airport database', () => {
  it('has a substantial, sorted, duplicate-free list', () => {
    const all = allAirports();
    expect(all.length).toBeGreaterThan(3000);
    const codes = all.map((a) => a.iata);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{3}$/);
  });

  it('JSON has the documented compact columnar shape and a sensible size', () => {
    expect(raw.fields).toEqual(['iata', 'icao', 'name', 'city', 'country', 'lat', 'lon', 'elevationM', 'tz']);
    expect(raw.rows.length).toBe(allAirports().length);
    expect(JSON.stringify(raw).length).toBeLessThan(1_000_000);
  });

  it('every record is valid (coordinates, elevation, IANA tz)', () => {
    for (const a of allAirports()) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.country).toMatch(/^[A-Z]{2}$/);
      expect(a.lat).toBeGreaterThanOrEqual(-90);
      expect(a.lat).toBeLessThanOrEqual(90);
      expect(a.lon).toBeGreaterThanOrEqual(-180);
      expect(a.lon).toBeLessThanOrEqual(180);
      expect(Number.isFinite(a.elevationM)).toBe(true);
      expect(Math.abs(Math.round(a.lat * 1e4) / 1e4 - a.lat)).toBeLessThan(1e-9);
    }
    // validate every distinct tz with Intl
    const tzs = new Set(allAirports().map((a) => a.tz));
    for (const tz of tzs) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
  });

  it('looks up well-known airports, case-insensitively', () => {
    const khi = getAirport('khi')!;
    expect(khi.iata).toBe('KHI');
    expect(khi.icao).toBe('OPKC');
    expect(khi.country).toBe('PK');
    expect(khi.tz).toBe('Asia/Karachi');
    expect(khi.lat).toBeCloseTo(24.9, 0);
    expect(khi.lon).toBeCloseTo(67.16, 1);
    expect(getAirport(' sfo ')?.tz).toBe('America/Los_Angeles');
    expect(getAirport('JFK')?.tz).toBe('America/New_York');
    expect(getAirport('DXB')?.tz).toBe('Asia/Dubai');
    expect(getAirport('DOH')?.tz).toBe('Asia/Qatar');
    expect(getAirport('IST')?.tz).toBe('Europe/Istanbul');
    expect(getAirport('SYD')?.tz).toBe('Australia/Sydney');
    expect(getAirport('AKL')?.tz).toBe('Pacific/Auckland');
    expect(getAirport('DEL')?.tz).toBe('Asia/Kolkata');
    expect(getAirport('JNB')?.tz).toBe('Africa/Johannesburg');
    expect(getAirport('GRU')?.tz).toBe('America/Sao_Paulo');
    expect(getAirport('LHR')?.tz).toBe('Europe/London');
  });

  it('converts elevation feet to metres (and uses 0 when missing)', () => {
    expect(getAirport('DEN')!.elevationM).toBeGreaterThan(1600); // 5434 ft
    expect(getAirport('DEN')!.elevationM).toBeLessThan(1700);
    expect(getAirport('JFK')!.elevationM).toBeLessThan(10);
    expect(getAirport('JED')!.elevationM).toBeLessThan(50);
  });

  it('isKnownIata / unknown codes', () => {
    expect(isKnownIata('KHI')).toBe(true);
    expect(isKnownIata('khi')).toBe(true);
    expect(isKnownIata('ZZZZ')).toBe(false);
    expect(isKnownIata('')).toBe(false);
    expect(isKnownIata('12')).toBe(false);
    expect(getAirport('QQQ')).toBeUndefined();
  });

  it('resolveAirport behaves like getAirport', () => {
    expect(resolveAirport('lhe')).toEqual(getAirport('LHE'));
    expect(resolveAirport('???')).toBeUndefined();
  });

  it('searchAirports: IATA exact first, then ICAO, city, name', () => {
    expect(searchAirports('KHI')[0].iata).toBe('KHI');
    expect(searchAirports('khi')[0].iata).toBe('KHI');
    expect(searchAirports('OPKC')[0].iata).toBe('KHI');
    expect(searchAirports('Karachi').map((a) => a.iata)).toContain('KHI');
    expect(searchAirports('Heathrow')[0].iata).toBe('LHR');
    expect(searchAirports('Dubai').map((a) => a.iata)).toContain('DXB');
    expect(searchAirports('san francisco').map((a) => a.iata)).toContain('SFO');
    expect(searchAirports('Istanbul').map((a) => a.iata)).toEqual(expect.arrayContaining(['IST']));
    // exact IATA beats a city that merely starts with the same letters
    expect(searchAirports('SFO')[0].iata).toBe('SFO');
    expect(searchAirports('JFK')[0].iata).toBe('JFK');
  });

  it('searchAirports respects limit, trims, and handles empty / junk input', () => {
    expect(searchAirports('a', 3).length).toBeLessThanOrEqual(3);
    expect(searchAirports('london', 2).length).toBeLessThanOrEqual(2);
    expect(searchAirports('')).toEqual([]);
    expect(searchAirports('   ')).toEqual([]);
    expect(searchAirports('zzzzzzzz-not-a-place')).toEqual([]);
    expect(searchAirports('khi', 0)).toEqual([]);
    const r = searchAirports('  karachi  ');
    expect(r.length).toBeGreaterThan(0);
    expect(new Set(r.map((a) => a.iata)).size).toBe(r.length);
  });

  it('searches accent-insensitively', () => {
    expect(searchAirports('sao paulo').map((a) => a.iata)).toContain('GRU');
  });
});
