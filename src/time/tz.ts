import tzlookup from 'tz-lookup';
import { clampLat, normalizeLon } from '../geo/geodesy';

const dtfCache = new Map<string, Intl.DateTimeFormat>();

/** Cached numeric formatter (constructing Intl.DateTimeFormat is slow; we call this a lot). */
function numericDtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    numericDtf(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset (tz wall clock − UTC) in ms at instant `ms`, exact to the second. */
function offsetMs(ms: number, tz: string): number {
  const parts = numericDtf(tz).formatToParts(new Date(ms));
  const g: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = Number(p.value);
  const hour = g.hour === 24 ? 0 : g.hour; // some engines emit "24" at midnight even with h23
  const asUtc = Date.UTC(g.year, g.month - 1, g.day, hour, g.minute, g.second);
  const floored = Math.floor(ms / 1000) * 1000;
  return asUtc - floored;
}

/** UTC offset of `tz` at instant `d`, in minutes (east positive). */
export function utcOffsetMinutes(d: Date, tz: string): number {
  return Math.round(offsetMs(d.getTime(), tz) / 60000);
}

/**
 * Convert a local wall-clock time ('YYYY-MM-DDTHH:mm') in `tz` to a UTC instant.
 * Spring-forward gap → shifted forward by the gap; fall-back overlap → the earlier instant.
 */
export function localToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((local ?? '').trim());
  if (!m) throw new Error(`Invalid local time "${local}" (expected YYYY-MM-DDTHH:mm)`);
  if (!isValidTimeZone(tz)) throw new Error(`Invalid time zone "${tz}"`);
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] ? Number(m[6]) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const chk = new Date(wall);
  if (
    chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d ||
    h > 23 || mi > 59 || s > 59
  ) {
    throw new Error(`Invalid local time "${local}"`);
  }
  // Offsets on either side of the wall time bracket any transition within a day.
  const DAY = 86400000;
  const before = offsetMs(wall - DAY, tz);
  const after = offsetMs(wall + DAY, tz);
  const candidates = new Set<number>();
  for (const o of before === after ? [before] : [before, after]) {
    const t = wall - o;
    if (offsetMs(t, tz) === o) candidates.add(t); // candidate round-trips → the wall time exists with this offset
  }
  if (candidates.size > 0) return new Date(Math.min(...candidates)); // ambiguous → earlier instant
  // Gap: the wall time does not exist. Interpret with the pre-transition offset → lands `gap` later on the clock.
  return new Date(wall - before);
}

/** Format an instant in `tz`, 24 h, e.g. "Mon 12 Oct 21:14". Invalid tz falls back to UTC. */
export function formatInTz(d: Date, tz: string, opts?: { seconds?: boolean; date?: boolean }): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return 'Invalid date';
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const g: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) g[p.type] = p.value;
  const hh = g.hour === '24' ? '00' : g.hour;
  const time = `${hh}:${g.minute}` + (opts?.seconds ? `:${g.second}` : '');
  return opts?.date === false ? time : `${g.weekday} ${g.day} ${g.month} ${time}`;
}

/** "+05:00", "-07:00", "+05:45". */
export function formatOffset(mins: number): string {
  const m = Number.isFinite(mins) ? Math.round(mins) : 0;
  const sign = m < 0 ? '-' : '+';
  const a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** IANA zone under a coordinate; falls back to a nautical Etc/GMT zone if the lookup fails. */
export function tzAt(lat: number, lon: number): string {
  const la = clampLat(lat);
  const lo = normalizeLon(lon);
  try {
    const z = tzlookup(la, lo);
    if (z && isValidTimeZone(z)) return z;
  } catch {
    /* fall through to nautical zone */
  }
  const n = Math.max(-12, Math.min(12, Math.round(lo / 15)));
  // POSIX-style sign inversion: east of Greenwich is Etc/GMT-N.
  return n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`;
}
