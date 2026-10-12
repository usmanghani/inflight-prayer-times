import { describe, expect, it, vi } from 'vitest';
import { formatInTz, formatOffset, isValidTimeZone, localToUtc, tzAt, utcOffsetMinutes } from '../src/time/tz';

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects junk', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
  });
});

describe('utcOffsetMinutes / formatOffset', () => {
  it('fixed and DST offsets', () => {
    expect(utcOffsetMinutes(new Date('2026-10-12T00:00:00Z'), 'Asia/Karachi')).toBe(300);
    expect(utcOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Los_Angeles')).toBe(-420);
    expect(utcOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'America/Los_Angeles')).toBe(-480);
    expect(utcOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'Asia/Kathmandu')).toBe(345);
    expect(utcOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'UTC')).toBe(0);
    expect(utcOffsetMinutes(new Date('2026-12-01T00:00:00Z'), 'Pacific/Kiritimati')).toBe(840);
  });
  it('formats offsets', () => {
    expect(formatOffset(300)).toBe('+05:00');
    expect(formatOffset(-420)).toBe('-07:00');
    expect(formatOffset(345)).toBe('+05:45');
    expect(formatOffset(0)).toBe('+00:00');
    expect(formatOffset(-570)).toBe('-09:30');
    expect(formatOffset(NaN)).toBe('+00:00');
  });
  it('Asia/Kathmandu is +05:45', () => {
    expect(formatOffset(utcOffsetMinutes(new Date('2026-10-12T00:00:00Z'), 'Asia/Kathmandu'))).toBe('+05:45');
  });
});

describe('localToUtc', () => {
  it('Karachi 21:30 → 16:30Z', () => {
    expect(localToUtc('2026-10-12T21:30', 'Asia/Karachi').toISOString()).toBe('2026-10-12T16:30:00.000Z');
  });
  it('Kathmandu 05:45 → 00:00Z', () => {
    expect(localToUtc('2026-10-12T05:45', 'Asia/Kathmandu').toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
  it('UTC and seconds input', () => {
    expect(localToUtc('2026-01-01T00:00', 'UTC').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(localToUtc('2026-01-01T00:00:30', 'UTC').toISOString()).toBe('2026-01-01T00:00:30.000Z');
  });
  it('Los Angeles before/after the 2026-03-08 spring-forward', () => {
    expect(localToUtc('2026-03-08T01:30', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T09:30:00.000Z'); // PST
    expect(localToUtc('2026-03-08T03:30', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T10:30:00.000Z'); // PDT
    expect(localToUtc('2026-03-07T12:00', 'America/Los_Angeles').toISOString()).toBe('2026-03-07T20:00:00.000Z');
    expect(localToUtc('2026-03-09T12:00', 'America/Los_Angeles').toISOString()).toBe('2026-03-09T19:00:00.000Z');
  });
  it('non-existent local time in the gap shifts forward', () => {
    // 02:30 does not exist on 2026-03-08 in LA; becomes 03:30 PDT = 10:30Z.
    expect(localToUtc('2026-03-08T02:30', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T10:30:00.000Z');
    expect(localToUtc('2026-03-08T02:00', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });
  it('fall-back 2026-11-01: ambiguous 01:30 → the earlier instant (PDT)', () => {
    expect(localToUtc('2026-11-01T01:30', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(localToUtc('2026-11-01T00:30', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(localToUtc('2026-11-01T02:30', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T10:30:00.000Z'); // PST
  });
  it('southern hemisphere DST (Sydney, Oct 2026 spring-forward on Oct 4)', () => {
    expect(localToUtc('2026-10-04T01:30', 'Australia/Sydney').toISOString()).toBe('2026-10-03T15:30:00.000Z'); // +10
    expect(localToUtc('2026-10-04T03:30', 'Australia/Sydney').toISOString()).toBe('2026-10-03T16:30:00.000Z'); // +11
  });
  it('round-trips through utcOffsetMinutes for ordinary times', () => {
    for (const tz of ['Asia/Karachi', 'America/New_York', 'Europe/London', 'Pacific/Auckland', 'Asia/Kathmandu']) {
      const d = localToUtc('2026-06-15T13:20', tz);
      const off = utcOffsetMinutes(d, tz);
      expect(new Date(d.getTime() + off * 60000).toISOString().slice(0, 16)).toBe('2026-06-15T13:20');
    }
  });
  it('throws on malformed input / bad zone / impossible dates', () => {
    expect(() => localToUtc('2026-10-12 21:30', 'Asia/Karachi')).toThrow();
    expect(() => localToUtc('nonsense', 'Asia/Karachi')).toThrow();
    expect(() => localToUtc('2026-02-30T10:00', 'UTC')).toThrow();
    expect(() => localToUtc('2026-10-12T25:00', 'UTC')).toThrow();
    expect(() => localToUtc('2026-10-12T21:30', 'Not/AZone')).toThrow();
  });
});

describe('formatInTz', () => {
  const d = new Date('2026-10-12T16:30:45Z');
  it('formats like "Mon 12 Oct 21:30"', () => {
    expect(formatInTz(d, 'Asia/Karachi')).toBe('Mon 12 Oct 21:30');
    expect(formatInTz(d, 'Asia/Karachi', { seconds: true })).toBe('Mon 12 Oct 21:30:45');
    expect(formatInTz(d, 'Asia/Karachi', { date: false })).toBe('21:30');
    expect(formatInTz(d, 'Asia/Karachi', { date: false, seconds: true })).toBe('21:30:45');
  });
  it('uses 24 h clock incl. midnight and handles day rollover per zone', () => {
    expect(formatInTz(new Date('2026-10-12T19:00:00Z'), 'Asia/Karachi')).toBe('Tue 13 Oct 00:00');
    expect(formatInTz(new Date('2026-10-12T16:30:00Z'), 'America/Los_Angeles')).toBe('Mon 12 Oct 09:30');
  });
  it('invalid timezone falls back to UTC; invalid date does not throw', () => {
    expect(formatInTz(d, 'Bogus/Zone')).toBe('Mon 12 Oct 16:30');
    expect(formatInTz(new Date(NaN), 'UTC')).toBe('Invalid date');
  });
});

describe('tzAt', () => {
  it('Karachi', () => {
    expect(tzAt(24.86, 67.0)).toBe('Asia/Karachi');
  });
  it('city zones', () => {
    expect(tzAt(51.47, -0.45)).toBe('Europe/London');
    expect(tzAt(37.62, -122.38)).toBe('America/Los_Angeles');
    expect(tzAt(-37.0, 174.8)).toBe('Pacific/Auckland');
  });
  it('open ocean → valid (preferably Etc/) zone', () => {
    for (const [lat, lon] of [[10, -150], [0, 179.9], [-30, -170], [35, -40], [60, -30]]) {
      const z = tzAt(lat, lon);
      expect(isValidTimeZone(z)).toBe(true);
    }
    expect(tzAt(10, -150)).toMatch(/^Etc\/GMT/);
  });
  it('is safe at poles, outside ranges and with NaN', () => {
    for (const [lat, lon] of [[90, 0], [-90, 0], [89.99, 180], [95, 500], [NaN, NaN], [0, -180]]) {
      expect(isValidTimeZone(tzAt(lat, lon))).toBe(true);
    }
  });
});

describe('tzAt nautical fallback (tz-lookup failing)', () => {
  it('uses Etc/GMT±N with the POSIX-inverted sign', async () => {
    vi.resetModules();
    vi.doMock('tz-lookup', () => ({ default: () => { throw new Error('boom'); } }));
    const mod = await import('../src/time/tz');
    expect(mod.tzAt(0, 75)).toBe('Etc/GMT-5');   // east of Greenwich → minus
    expect(mod.tzAt(0, -120)).toBe('Etc/GMT+8'); // west → plus
    expect(mod.tzAt(0, 3)).toBe('Etc/GMT');
    expect(mod.tzAt(0, -179.9)).toBe('Etc/GMT+12');
    expect(mod.tzAt(0, 179.9)).toBe('Etc/GMT-12');
    expect(mod.isValidTimeZone(mod.tzAt(0, 179.9))).toBe(true);
    vi.doUnmock('tz-lookup');
    vi.resetModules();
  });
});
