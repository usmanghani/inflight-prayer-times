import type { InflightResult } from '../types';
import type { PrayerTask } from '../prayer/summary';

const CRLF = '\r\n';
const enc = new TextEncoder();

/** Escape TEXT values per RFC 5545 (backslash, semicolon, comma, newline). */
export function icsEscape(text: string): string {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to at most 75 octets per physical line (RFC 5545 §3.1).
 * Continuation lines start with one space. Never splits a UTF-8 sequence.
 */
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75; // first line: 75 octets; continuation lines: 74 + the leading space
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out.join(CRLF + ' ');
}

/** 20261012T143000Z */
export function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const LABEL: Record<PrayerTask['prayer'], string> = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };

function where(state: PrayerTask['startState']): string {
  if (state.onGround) return `on the ground${state.airport ? ` at ${state.airport}` : ''}`;
  const la = `${Math.abs(state.lat).toFixed(1)}°${state.lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(state.lon).toFixed(1)}°${state.lon >= 0 ? 'E' : 'W'}`;
  return `in the air near ${la} ${lo}, ${Math.round(state.altitudeM * 3.28084).toLocaleString('en-US')} ft`;
}

/**
 * One VEVENT per prayer window of the journey, UTC times. `now` is injectable for deterministic output.
 */
export function eventsToIcs(result: InflightResult, tasks: PrayerTask[], title: string, now: Date = new Date()): string {
  const first = result.samples[0]?.state.time;
  const last = result.samples[result.samples.length - 1]?.state.time;
  const stamp = icsDate(now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//In-Flight Prayer Times//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(title)}`,
  ];
  tasks.forEach((t, i) => {
    const start = t.windowStart?.time ?? first;
    const end = t.windowEnd ?? last;
    if (!start || !Number.isFinite(start.getTime())) return;
    let endD = end && Number.isFinite(end.getTime()) ? end : new Date(start.getTime() + 60_000);
    if (endD.getTime() <= start.getTime()) endD = new Date(start.getTime() + 60_000);
    const desc: string[] = [
      `${LABEL[t.prayer]} window opens ${where(t.startState)}.`,
      ...(t.durationMin !== null ? [`Duration: ${Math.round(t.durationMin)} min.`] : ['Still open at arrival.']),
      ...t.notes.map((n) => n.charAt(0).toUpperCase() + n.slice(1) + '.'),
      'Representative schedule - consult a scholar for rulings.',
    ];
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.prayer}-${icsDate(start)}-${i}@inflight-prayer-times`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(endD)}`,
      `SUMMARY:${icsEscape(`${LABEL[t.prayer]} window${t.inAir ? ' (in flight)' : ''}`)}`,
      `DESCRIPTION:${icsEscape(desc.join('\n'))}`,
      `LOCATION:${icsEscape(where(t.startState))}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
