import { describe, expect, it } from 'vitest';
import { csvField, csvRow, samplesToCsv, CSV_HEADER } from '../src/export/csv';
import { eventsToIcs, foldLine, icsEscape } from '../src/export/ics';
import { sanitizeFilename } from '../src/export/download';
import type { AircraftState, InflightResult, MinuteSample } from '../src/types';
import type { PrayerTask } from '../src/prayer/summary';

function state(t: string, over: Partial<AircraftState> = {}): AircraftState {
  return {
    time: new Date(t), lat: 25.5, lon: 55.25, altitudeM: 11000, headingDeg: 270, phase: 'cruise',
    legIndex: 0, onGround: false, ...over,
  };
}
function sample(t: string, over: Partial<MinuteSample> = {}, st: Partial<AircraftState> = {}): MinuteSample {
  return {
    state: state(t, st), sunAltitudeDeg: 12.345, sunAzimuthDeg: 200, window: 'dhuhr', qiblaDeg: 260.2,
    qiblaRelativeDeg: -9.8, tz: 'Asia/Dubai', ...over,
  };
}
const result: InflightResult = {
  samples: [
    sample('2026-10-12T08:00:00Z'),
    sample('2026-10-12T08:01:00Z', { tz: 'Weird, "Zone"' }),
    sample('2026-10-12T08:02:00Z', { sunAltitudeDeg: NaN }, { onGround: true, airport: 'DXB', phase: 'ground' }),
  ],
  events: [],
  anomalies: [],
  initialWindow: 'dhuhr',
};

describe('csv', () => {
  it('quotes fields per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\rx')).toBe('"cr\rx"');
    expect(csvField(null)).toBe('');
    expect(csvField(NaN)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(csvRow(['a', 'b,c', 3])).toBe('a,"b,c",3');
  });

  it('writes a header and one CRLF-terminated row per sample', () => {
    const csv = samplesToCsv(result);
    const lines = csv.split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines).toHaveLength(result.samples.length + 2);
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines[1].startsWith('2026-10-12T08:00:00.000Z,2026-10-12 12:00:00,Asia/Dubai,25.50000,55.25000,11000,36089,cruise,false,')).toBe(true);
    expect(lines[2]).toContain('"Weird, ""Zone"""');
  });

  it('never emits NaN/Infinity text', () => {
    const csv = samplesToCsv(result);
    expect(csv).not.toMatch(/NaN|Infinity|Invalid/);
    expect(csv.split('\r\n')[3]).toContain(',DXB,');
  });

  it('every row has the same number of fields as the header', () => {
    const rows = samplesToCsv(result).trim().split('\r\n');
    // the quoted tz contains a comma, so count with a tiny RFC 4180 splitter
    const count = (row: string): number => {
      let n = 1;
      let q = false;
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '"') {
          if (q && row[i + 1] === '"') i++;
          else q = !q;
        } else if (row[i] === ',' && !q) n++;
      }
      return n;
    };
    for (const r of rows) expect(count(r)).toBe(CSV_HEADER.length);
  });
});

describe('ics', () => {
  it('escapes TEXT values', () => {
    expect(icsEscape('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting multibyte characters', () => {
    const long = 'DESCRIPTION:' + 'é'.repeat(100);
    const folded = foldLine(long);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(2);
    const enc = new TextEncoder();
    for (const [i, l] of physical.entries()) {
      expect(enc.encode(l).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(' ')).toBe(true);
    }
    // unfolding restores the original
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(foldLine('short line')).toBe('short line');
  });

  const task = (prayer: PrayerTask['prayer'], start: string | null, end: string | null, inAir = true): PrayerTask => ({
    prayer,
    windowStart: start ? { prayer, time: new Date(start), state: state(start), note: 'ok' } : null,
    windowEnd: end ? new Date(end) : null,
    startState: state(start ?? '2026-10-12T08:00:00Z'),
    endState: end ? state(end) : null,
    durationMin: start && end ? (Date.parse(end) - Date.parse(start)) / 60000 : null,
    inAir,
    notes: ['window opens in the air; semicolons, commas'],
  });

  it('builds a valid VCALENDAR with one VEVENT per window, CRLF endings, UTC times', () => {
    const tasks = [
      task('dhuhr', null, '2026-10-12T09:00:00Z'),
      task('asr', '2026-10-12T09:00:00Z', '2026-10-12T11:30:00Z'),
      task('maghrib', '2026-10-12T08:01:00Z', null, false),
    ];
    const ics = eventsToIcs(result, tasks, 'KHI → SFO; test, trip', new Date('2026-10-01T00:00:00Z'));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/); // no bare LF
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
    expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(3);
    expect(ics).toContain('DTSTAMP:20261001T000000Z');
    expect(ics).toContain('DTSTART:20261012T080000Z'); // window open at departure -> journey start
    expect(ics).toContain('DTEND:20261012T090000Z');
    expect(ics).toContain('DTEND:20261012T080200Z'); // still open at arrival -> journey end
    expect(ics).toContain('X-WR-CALNAME:KHI → SFO\\; test\\, trip');
    const uids = ics.match(/^UID:.*$/gm) ?? [];
    expect(new Set(uids).size).toBe(3);
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    // unfolded DESCRIPTION is escaped (no raw ';' or ',' in the text part)
    const unfolded = ics.replace(/\r\n /g, '');
    const desc = /^DESCRIPTION:(.*)$/m.exec(unfolded)![1];
    expect(desc).not.toMatch(/(?<!\\)[;,]/);
    expect(desc).toContain('\\n');
  });

  it('gives zero-length windows a one-minute duration', () => {
    const ics = eventsToIcs(result, [task('isha', '2026-10-12T08:00:00Z', '2026-10-12T08:00:00Z')], 't', new Date(0));
    expect(ics).toContain('DTEND:20261012T080100Z');
  });

  it('produces an empty but valid calendar for no tasks', () => {
    const ics = eventsToIcs(result, [], 't', new Date(0));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('VEVENT');
  });
});

describe('download helpers', () => {
  it('sanitises file names', () => {
    expect(sanitizeFilename('a b/c:d*.csv')).toBe('a-b-c-d-.csv');
    expect(sanitizeFilename('///')).toBe('download');
  });
});
