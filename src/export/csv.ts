import type { InflightResult } from '../types';

/** RFC 4180 field quoting: wrap in quotes when the value has a comma, quote, CR or LF; double inner quotes. */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}

export const CSV_HEADER = [
  'utc_time',
  'local_time_under_aircraft',
  'tz_under_aircraft',
  'latitude_deg',
  'longitude_deg',
  'altitude_m',
  'altitude_ft',
  'phase',
  'on_ground',
  'airport',
  'heading_deg',
  'sun_altitude_deg',
  'sun_azimuth_deg',
  'prayer_window',
  'qibla_deg',
  'qibla_relative_deg',
] as const;

const FT_PER_M = 3.28084;
const fix = (x: number, d: number): string => (Number.isFinite(x) ? x.toFixed(d) : '');

/** 'YYYY-MM-DD HH:mm:ss' wall clock in `tz` (falls back to UTC for an invalid zone). */
function localStamp(d: Date, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  const hh = g.hour === '24' ? '00' : g.hour;
  return `${g.year}-${g.month}-${g.day} ${hh}:${g.minute}:${g.second}`;
}

/** One header row plus one row per sample (minute), CRLF separated, RFC 4180 quoted. */
export function samplesToCsv(result: InflightResult): string {
  const lines: string[] = [csvRow([...CSV_HEADER])];
  for (const s of result.samples) {
    const t = s.state.time;
    if (!(t instanceof Date) || !Number.isFinite(t.getTime())) continue;
    lines.push(
      csvRow([
        t.toISOString(),
        localStamp(t, s.tz),
        s.tz,
        fix(s.state.lat, 5),
        fix(s.state.lon, 5),
        fix(s.state.altitudeM, 0),
        fix(s.state.altitudeM * FT_PER_M, 0),
        s.state.phase,
        s.state.onGround,
        s.state.airport ?? '',
        fix(s.state.headingDeg, 1),
        fix(s.sunAltitudeDeg, 2),
        fix(s.sunAzimuthDeg, 1),
        s.window,
        fix(s.qiblaDeg, 1),
        fix(s.qiblaRelativeDeg, 1),
      ]),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
