/**
 * Heuristic itinerary parser: free text (pasted, or OCR output of a booking
 * screenshot / e-ticket) -> flight legs.
 *
 * Pipeline
 *  1. normalise OCR noise (pipes, NBSP, O/0 inside numbers, unicode dashes ...);
 *  2. find dates, flight numbers, times and airport codes ("hits"), masking each
 *     class after it is found so later passes cannot re-read the same characters
 *     (e.g. the year 2026 as 20:26, or "PM 12" in "9:30 PM 12 Oct" as a flight);
 *  3. segment the hits around the flight numbers with a tiny DP that gives every
 *     leg the nearest "2 airports + 2 times" (works for header-first e-tickets,
 *     row-last tables and Google-Flights-style blocks alike);
 *  4. read departure = first airport/time, arrival = second, apply "+1" markers,
 *     infer missing years, de-duplicate repeated flight numbers.
 *
 * Nothing here touches the network; it is pure string processing.
 */

export interface ParsedLeg {
  flightNumber?: string;
  from?: string;
  to?: string;
  depDate?: string; // YYYY-MM-DD
  depTime?: string; // HH:mm
  arrDate?: string;
  arrTime?: string;
  confidence: number; // 0..1
  raw: string[];
}

export interface ParseOptions {
  isKnownIata: (c: string) => boolean;
  /** Used to infer a missing year. Defaults to "now". */
  referenceDate?: Date;
}

// ───────────────────────────── vocabularies ─────────────────────────────

/** Two-character IATA airline designators we accept without an explicit "Flight" label. */
const AIRLINES = new Set(
  (
    'AA AC AD AF AI AK AM AR AS AT AV AY AZ B6 BA BG BI BR BS CA CI CM CX CZ D8 DL DT DY EI EK ER ET EY ' +
    'F9 FI FJ FM FR FZ G3 G9 GA GF H2 HA HU HX IA IB IX J2 J9 JJ JL JQ KA KC KE KL KQ KU LA LH LO LX LY ' +
    'ME MF MH MK MS MU NH NK NP NZ OD OS OZ PA PC PF PG PK PR PS QF QP QR QV RB RJ RO S7 SA SG SK SM SN ' +
    'SQ SU SV SW TC TG TK TP TR TS U2 UA UK UL UX VA VN VS VY W6 WB WN WS WY XQ XY ' +
    '6E 9W 7C 5J 3U 9P 4Y 2P 8M'
  ).split(/\s+/),
);

/** Airline names -> designator, for "Emirates 225" style text. */
const AIRLINE_NAMES: Record<string, string> = {
  emirates: 'EK', 'qatar airways': 'QR', 'turkish airlines': 'TK', 'united airlines': 'UA', united: 'UA',
  'pakistan international airlines': 'PK', 'pakistan international': 'PK', pia: 'PK', etihad: 'EY',
  'etihad airways': 'EY', saudia: 'SV', 'delta air lines': 'DL', delta: 'DL', 'american airlines': 'AA',
  'british airways': 'BA', lufthansa: 'LH', 'air india': 'AI', qantas: 'QF', 'cathay pacific': 'CX',
  'singapore airlines': 'SQ', 'air france': 'AF', klm: 'KL', 'ethiopian airlines': 'ET', flydubai: 'FZ',
  'air canada': 'AC', 'virgin atlantic': 'VS', 'korean air': 'KE', 'air new zealand': 'NZ',
  'japan airlines': 'JL', 'all nippon airways': 'NH', airblue: 'PA', 'fly jinnah': '9P',
};

/** Never an airport, even if the string happens to be an IATA code (months, weekdays, common words). */
const NOT_AIRPORT = new Set(
  (
    'THE AND ETA ETD PNR NON FOR ARE NOT ALL YOU BUT CAN HER WAS ONE OUR OUT DAY GET HAS HIM HIS HOW NEW ' +
    'NOW OLD SEE TWO WAY WHO DID ITS LET PUT SAY SHE TOO USE TAX FEE ADT CHD INF VIA STA STD ARR DEP TER ' +
    'MIN HRS ECO AIR PAX REF TKT ETK AMT TOT SEQ FLT OPS CLS FRM ARV DPT ' +
    'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC MON TUE WED THU FRI SAT SUN'
  ).split(/\s+/),
);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WD_RE = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s*';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TIME_IGNORE_LINE = /(duration|layover|stop-?over|travel time|total (?:travel|trip|journey)|flight time|boarding|check-?in|gate\b|bag drop|baggage|issued|booked|booking date)/i;

// ───────────────────────────── small helpers ─────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoDate(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function mask(s: string, pos: number, end: number): string {
  return s.slice(0, pos) + ' '.repeat(end - pos) + s.slice(end);
}

/** Length-preserving clean-up of typical OCR noise. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[     ​﻿]/g, ' ')
    .replace(/[|¦│┃]/g, ' ')
    .replace(/[–—−]/g, '-')
    .replace(/：/g, ':')
    .replace(/⁺/g, '+')
    .replace(/¹/g, '1')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    // O -> 0 and I/l -> 1 when glued to digits and not part of a word ("12OCT" stays)
    .replace(/(?<![A-Za-z])O(?=\d)|(?<=\d)O(?![A-Za-z])/g, '0')
    .replace(/(?<=\d)[Il](?=[\d:])/g, '1');
}

// ───────────────────────────── hit types ─────────────────────────────

interface Hit { pos: number; end: number }
interface DateHit extends Hit { date: string }
interface FlightHit extends Hit { num: string }
interface AirHit extends Hit { code: string }
interface TimeHit extends Hit {
  h: number;
  m: number;
  label?: 'dep' | 'arr';
  plus: number; // "+1" next-day marker
  bare?: boolean;
}

const hhmm = (t: { h: number; m: number }): string => `${pad2(t.h)}:${pad2(t.m)}`;

// ───────────────────────────── dates ─────────────────────────────

function inferYear(month: number, day: number, weekday: number | undefined, ref: Date): number {
  const refMs = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  const floor = refMs - 45 * 86400000;
  const candidates: number[] = [];
  for (let y = ref.getUTCFullYear() - 1; y <= ref.getUTCFullYear() + 3; y++) {
    if (day > daysInMonth(y, month)) continue;
    if (Date.UTC(y, month - 1, day) >= floor) candidates.push(y);
  }
  if (weekday !== undefined) {
    const hit = candidates.find((y) => new Date(Date.UTC(y, month - 1, day)).getUTCDay() === weekday);
    if (hit !== undefined) return hit;
  }
  return candidates[0] ?? ref.getUTCFullYear();
}

function weekdayIndex(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const i = WEEKDAYS.indexOf(s.slice(0, 3).toLowerCase());
  return i >= 0 ? i : undefined;
}

function findDates(text: string, ref: Date): { hits: DateHit[]; masked: string } {
  const hits: DateHit[] = [];
  let masked = text;

  const take = (re: RegExp, build: (m: RegExpExecArray) => string | undefined): void => {
    // re must be global; run on the progressively masked text so matches cannot overlap
    re.lastIndex = 0;
    const src = masked;
    let m: RegExpExecArray | null;
    const found: DateHit[] = [];
    while ((m = re.exec(src)) !== null) {
      const date = build(m);
      if (date) found.push({ pos: m.index, end: m.index + m[0].length, date });
      if (m[0].length === 0) re.lastIndex++;
    }
    for (const h of found) {
      masked = mask(masked, h.pos, h.end);
      hits.push(h);
    }
  };

  // ISO 2026-10-12
  take(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g, (m) => isoDate(+m[1], +m[2], +m[3]));

  // 12 Oct 2026 / 12OCT / 12OCT26 / Mon, 12 Oct / 12-Oct-2026
  take(
    new RegExp(
      `(?:(${WD_RE}))?(?<![\\d:.])(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.]*(${MONTH_RE})(?![a-z])\\.?(?:[\\s\\-/.,']*(20\\d{2}|\\d{2})(?![\\d:]))?`,
      'gi',
    ),
    (m) => {
      const mo = MONTHS[m[3].slice(0, 3).toLowerCase()];
      const d = +m[2];
      let y: number;
      if (m[4]) y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
      else y = inferYear(mo, d, weekdayIndex(m[1]?.trim()), ref);
      return isoDate(y, mo, d);
    },
  );

  // Oct 12, 2026 / Mon, Oct 12 / October 12th
  take(
    new RegExp(
      `(?:(${WD_RE}))?(?<![a-z])(${MONTH_RE})(?![a-z])\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:\\s*,?\\s*(20\\d{2})(?!\\d))?`,
      'gi',
    ),
    (m) => {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      const d = +m[3];
      const y = m[4] ? +m[4] : inferYear(mo, d, weekdayIndex(m[1]?.trim()), ref);
      return isoDate(y, mo, d);
    },
  );

  // 12/10/2026, 12.10.2026, 12-10-26 (DD/MM unless the second number cannot be a month)
  take(/(?<![\d:.\/-])(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})(?![\d:])/g, (m) => {
    let a = +m[1];
    let b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (b > 12 && a <= 12) [a, b] = [b, a]; // MM/DD
    return isoDate(y, b, a);
  });

  hits.sort((x, y) => x.pos - y.pos);
  return { hits, masked };
}

// ───────────────────────────── flight numbers ─────────────────────────────

function findFlights(text: string): { hits: FlightHit[]; masked: string } {
  const hits: FlightHit[] = [];
  let masked = text;
  const add = (pos: number, end: number, num: string): void => {
    if (hits.some((h) => pos < h.end && end > h.pos)) return;
    hits.push({ pos, end, num });
  };

  // explicit label: "Flight EK 601", "Flt: PK301" (accepts any designator)
  const labelled = /\b(?:flight|flt|vol|vuelo)\b\.?[ \t]*(?:no\.?|number|#|:)?[ \t]*([A-Z][A-Z0-9]|[0-9][A-Z])[ \t]{0,3}(\d{1,4})(?![\d:.]\d)\b/gid;
  let m: RegExpExecArray | null;
  while ((m = labelled.exec(text)) !== null) {
    const start = m.indices ? m.indices[1][0] : m.index;
    add(start, m.index + m[0].length, m[1].toUpperCase() + String(+m[2]));
  }

  // bare designator + number (upper case only), designator must be known
  const re = /(?<![A-Za-z0-9])([A-Z]{2}|[A-Z]\d|\d[A-Z])[ \t]{0,3}(\d{1,4})(?![A-Za-z\d])(?![:.]\d)/g;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    if (!AIRLINES.has(code)) continue;
    if ((code === 'AM' || code === 'PM') && /[\d:]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index))) continue;
    if (m[2].length === 4 && m[2].startsWith('0')) continue;
    add(m.index, m.index + m[0].length, code + String(+m[2]));
  }

  // airline name + number ("Emirates 225")
  const names = Object.keys(AIRLINE_NAMES).sort((a, b) => b.length - a.length).join('|');
  const byName = new RegExp(`(?<![A-Za-z])(${names})\\s*(?:flight\\s*|#)?(\\d{3,4})(?![\\d:.]\\d)(?!\\d)`, 'gi');
  while ((m = byName.exec(text)) !== null) {
    add(m.index, m.index + m[0].length, AIRLINE_NAMES[m[1].toLowerCase()] + String(+m[2]));
  }

  hits.sort((a, b) => a.pos - b.pos);
  for (const h of hits) masked = mask(masked, h.pos, h.end);
  return { hits, masked };
}

// ───────────────────────────── times ─────────────────────────────

function lineBounds(text: string, pos: number): [number, number] {
  const s = text.lastIndexOf('\n', pos - 1) + 1;
  let e = text.indexOf('\n', pos);
  if (e < 0) e = text.length;
  return [s, e];
}

function to24(h: number, ap: string | undefined): number | undefined {
  if (!ap) return h <= 23 ? h : undefined;
  if (h < 1 || h > 12) return undefined;
  const pm = ap.toLowerCase().startsWith('p');
  return (h % 12) + (pm ? 12 : 0);
}

function findTimes(text: string): { hits: TimeHit[]; bare: TimeHit[] } {
  const hits: TimeHit[] = [];
  const bare: TimeHit[] = [];
  let work = text;

  const labelFor = (pos: number): 'dep' | 'arr' | undefined => {
    const [ls] = lineBounds(text, pos);
    const before = text.slice(Math.max(ls, pos - 18), pos);
    if (/(?:dep(?:art(?:s|ure|ing)?)?|leave[s]?|std|etd)\W{0,4}$/i.test(before)) return 'dep';
    if (/(?:arr(?:iv(?:e|es|al|ing))?|eta|sta)\W{0,4}$/i.test(before)) return 'arr';
    return undefined;
  };

  const marker = (end: number): { plus: number; end: number } => {
    const rest = text.slice(end, end + 24);
    const m = /^\s*[(\[]?\s*\+\s*(\d)\s*(?:d(?:ays?)?\b)?\s*[)\]]?/i.exec(rest);
    if (m) return { plus: +m[1], end: end + m[0].length };
    const n = /^\s*[(\[]?\s*next\s+day\s*[)\]]?/i.exec(rest);
    if (n) return { plus: 1, end: end + n[0].length };
    return { plus: 0, end };
  };

  const push = (m: RegExpExecArray, h: number | undefined, mi: number): void => {
    if (h === undefined || mi < 0 || mi > 59) return;
    const [ls, le] = lineBounds(text, m.index);
    if (TIME_IGNORE_LINE.test(text.slice(ls, le))) {
      work = mask(work, m.index, m.index + m[0].length);
      return;
    }
    const mk = marker(m.index + m[0].length);
    hits.push({ pos: m.index, end: mk.end, h, m: mi, label: labelFor(m.index), plus: mk.plus });
    work = mask(work, m.index, m.index + m[0].length);
  };

  // 21:30 / 9:30 PM / 9:30pm / 9:30 p.m.
  const colon = /(?<![\d:.])(\d{1,2})\s?[:;]\s?(\d{2})(?![\d])(?::\d{2}(?!\d))?(?:\s*(a\.?m\.?|p\.?m\.?)(?![A-Za-z]))?/gi;
  let m: RegExpExecArray | null;
  const colonText = work;
  while ((m = colon.exec(colonText)) !== null) {
    const ap = m[3] ? m[3].replace(/\./g, '') : undefined;
    push(m, to24(+m[1], ap), +m[2]);
  }

  // 21h30 (but not durations like "13h 45m")
  const hform = /(?<![\d:.])(\d{1,2})\s?h\s?(\d{2})(?!\d)(?!\s*m)/gi;
  const hText = work;
  while ((m = hform.exec(hText)) !== null) push(m, to24(+m[1], undefined), +m[2]);

  // 9.30 PM
  const dotted = /(?<![\d:.])(\d{1,2})\.(\d{2})\s*(a\.?m\.?|p\.?m\.?)(?![A-Za-z])/gi;
  const dText = work;
  while ((m = dotted.exec(dText)) !== null) push(m, to24(+m[1], m[3].replace(/\./g, '')), +m[2]);

  // 9 PM
  const hourOnly = /(?<![\d:.])(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![A-Za-z])/gi;
  const oText = work;
  while ((m = hourOnly.exec(oText)) !== null) push(m, to24(+m[1], m[2].replace(/\./g, '')), 0);

  // bare 0930 (candidates only; accepted later when next to an airport or a Dep/Arr label)
  const bareRe = /(?<![\d:.\/-])([01]\d|2[0-3])([0-5]\d)(?![\d:])(?!\s*(?:a\.?m|p\.?m)\b)/gi;
  const bText = work;
  while ((m = bareRe.exec(bText)) !== null) {
    const [ls, le] = lineBounds(text, m.index);
    if (TIME_IGNORE_LINE.test(text.slice(ls, le))) continue;
    const mk = marker(m.index + m[0].length);
    bare.push({ pos: m.index, end: mk.end, h: +m[1], m: +m[2], label: labelFor(m.index), plus: mk.plus, bare: true });
  }

  hits.sort((a, b) => a.pos - b.pos);
  return { hits, bare };
}

// ───────────────────────────── airports ─────────────────────────────

const SEP = String.raw`(?:[-=]{1,2}>|[-\u2192\u2794\u279d\u27f6>\u00bb/]|\bto\b|\bTO\b)`;
const TIME_AFTER = /^[\s,:\-.]*(?:\d{1,2}\s?[:;h]\s?\d{2}|\d{4}\b|\d{1,2}\s?(?:AM|PM|am|pm))/;
const TIME_BEFORE = /(?:\d{1,2}\s?[:;h]\s?\d{2}\s*(?:AM|PM|am|pm)?|\b\d{4}|\d{1,2}\s?(?:AM|PM|am|pm))[\s,:\-.]*$/;

function findAirports(
  text: string,
  opts: ParseOptions,
  flights: FlightHit[],
  times: TimeHit[],
  bare: TimeHit[],
): AirHit[] {
  const out: AirHit[] = [];
  const ok = (c: string): boolean => !NOT_AIRPORT.has(c) && opts.isKnownIata(c);
  const re = /(?<![A-Za-z])([A-Z]{3})([A-Z]{3})?(?![A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [ls, le] = lineBounds(text, m.index);
    const line = text.slice(ls, le);
    const lineHasTimeOrFlight =
      times.some((t) => t.pos >= ls && t.pos < le) ||
      bare.some((t) => t.pos >= ls && t.pos < le) ||
      flights.some((f) => f.pos >= ls && f.pos < le);

    // Glued GDS pair "KHIDXB"
    if (m[2]) {
      if (ok(m[1]) && ok(m[2]) && lineHasTimeOrFlight) {
        out.push({ pos: m.index, end: m.index + 3, code: m[1] });
        out.push({ pos: m.index + 3, end: m.index + 6, code: m[2] });
      }
      continue;
    }

    const code = m[1];
    if (!ok(code)) continue;
    const pos = m.index;
    const end = pos + 3;
    const before = text.slice(Math.max(ls, pos - 40), pos);
    const after = text.slice(end, Math.min(le, end + 40));

    let accepted = false;
    if (/[(\[]\s*$/.test(before) && /^\s*[)\]]/.test(after)) accepted = true; // (KHI)
    else if (line.trim() === code) accepted = true; // alone on a line
    else if (ok(new RegExp(`(?<![A-Za-z])([A-Z]{3})\\s*${SEP}\\s*$`).exec(before)?.[1] ?? '')) accepted = true; // KHI - [DXB]
    else if (ok(new RegExp(`^\\s*${SEP}\\s*([A-Z]{3})(?![A-Za-z])`).exec(after)?.[1] ?? '')) accepted = true; // [KHI] - DXB
    else if (TIME_AFTER.test(after) || TIME_BEFORE.test(before)) accepted = true; // KHI 21:30
    else if (/(?:from|to|origin|destination|dep(?:art\w*)?|arr(?:iv\w*)?|airport)\W{0,3}$/i.test(before)) accepted = true;
    else if (
      flights.some((f) => (f.end <= pos && pos - f.end <= 14 && !text.slice(f.end, pos).includes('\n')) ||
        (f.pos >= end && f.pos - end <= 14 && !text.slice(end, f.pos).includes('\n')))
    ) accepted = true;
    else if (lineHasTimeOrFlight) {
      // two codes side by side: "KHI DXB"
      const prev = /(?<![A-Za-z])([A-Z]{3})\s+$/.exec(before)?.[1];
      const next = /^\s+([A-Z]{3})(?![A-Za-z])/.exec(after)?.[1];
      if ((prev && ok(prev)) || (next && ok(next))) accepted = true;
    }
    if (accepted) out.push({ pos, end, code });
  }
  return out;
}

// ───────────────────────────── segmentation ─────────────────────────────

type Item =
  | { kind: 'air'; pos: number; air: AirHit }
  | { kind: 'time'; pos: number; time: TimeHit }
  | { kind: 'date'; pos: number; date: DateHit };

function legCost(items: Item[], anchor: number): number {
  const airs = new Set<string>();
  const times = new Set<string>();
  const dates = new Set<string>();
  let dist = 0;
  for (const it of items) {
    if (it.kind === 'air') airs.add(it.air.code);
    else if (it.kind === 'time') times.add(hhmm(it.time) + '+' + it.time.plus);
    else dates.add(it.date.date);
    dist += Math.abs(it.pos - anchor);
  }
  const dateCost = dates.size === 0 ? 0.4 : Math.max(0, dates.size - 2) * 0.4;
  return Math.abs(airs.size - 2) + Math.abs(times.size - 2) + dateCost + dist / 1e5;
}

/** Choose, for each flight anchor, the slice of nearby items that best completes a leg. */
function segment(anchors: FlightHit[], items: Item[]): Item[][] {
  const n = anchors.length;
  const gaps: Item[][] = Array.from({ length: n + 1 }, () => []);
  for (const it of items) {
    let g = 0;
    while (g < n && anchors[g].pos < it.pos) g++;
    gaps[g].push(it);
  }
  // dp[g][c]: best cost of legs 1..g when gap g is cut at c (items[:c] go left, items[c:] go right)
  const dp: number[][] = [];
  const back: number[][] = [];
  dp[0] = gaps[0].map(() => 0).concat([0]);
  back[0] = dp[0].map(() => -1);
  for (let i = 1; i <= n; i++) {
    const mPrev = gaps[i - 1].length;
    const mCur = gaps[i].length;
    dp[i] = [];
    back[i] = [];
    for (let c = 0; c <= mCur; c++) {
      let best = Infinity;
      let arg = 0;
      for (let p = 0; p <= mPrev; p++) {
        const legItems = gaps[i - 1].slice(p).concat(gaps[i].slice(0, c));
        const cost = dp[i - 1][p] + legCost(legItems, anchors[i - 1].pos);
        if (cost < best - 1e-12) {
          best = cost;
          arg = p;
        }
      }
      dp[i][c] = best;
      back[i][c] = arg;
    }
  }
  let c = 0;
  let bestEnd = Infinity;
  for (let k = 0; k <= gaps[n].length; k++) {
    if (dp[n][k] < bestEnd - 1e-12) {
      bestEnd = dp[n][k];
      c = k;
    }
  }
  const cuts: number[] = new Array(n + 1).fill(0);
  cuts[n] = c;
  for (let i = n; i >= 1; i--) {
    cuts[i - 1] = back[i][cuts[i]];
  }
  const legs: Item[][] = [];
  for (let i = 1; i <= n; i++) legs.push(gaps[i - 1].slice(cuts[i - 1]).concat(gaps[i].slice(0, cuts[i])));
  return legs;
}

/** No flight numbers at all: group consecutive items into 2-airport / 2-time chunks. */
function segmentAnchorless(items: Item[]): Item[][] {
  const legs: Item[][] = [];
  let cur: Item[] = [];
  const stats = (): { a: Set<string>; t: number } => ({
    a: new Set(cur.filter((i) => i.kind === 'air').map((i) => (i as { air: AirHit }).air.code)),
    t: cur.filter((i) => i.kind === 'time').length,
  });
  for (const it of items) {
    const s = stats();
    const wouldOverflow =
      (it.kind === 'air' && s.a.size >= 2 && !s.a.has(it.air.code)) ||
      (it.kind === 'time' && s.t >= 2) ||
      (it.kind === 'date' && cur.filter((x) => x.kind === 'date').length >= 2);
    if (wouldOverflow) {
      legs.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) legs.push(cur);
  return legs.filter((l) => l.some((i) => i.kind !== 'date'));
}

// ───────────────────────────── leg assembly ─────────────────────────────

function buildLeg(
  text: string,
  origLines: string[],
  flight: FlightHit | undefined,
  items: Item[],
): ParsedLeg & { _first: number; _last: number } {
  const airs = items.filter((i): i is Extract<Item, { kind: 'air' }> => i.kind === 'air').map((i) => i.air);
  const times = items.filter((i): i is Extract<Item, { kind: 'time' }> => i.kind === 'time').map((i) => i.time);
  const dates = items.filter((i): i is Extract<Item, { kind: 'date' }> => i.kind === 'date').map((i) => i.date);
  airs.sort((a, b) => a.pos - b.pos);
  times.sort((a, b) => a.pos - b.pos);
  dates.sort((a, b) => a.pos - b.pos);

  const from = airs[0]?.code;
  const to = airs.find((a) => a.code !== from)?.code;

  const depHit = times.find((t) => t.label === 'dep') ?? times.find((t) => t.label !== 'arr');
  let arrHit = times.find((t) => t.label === 'arr' && t !== depHit);
  if (!arrHit) {
    arrHit = times.find(
      (t) => t !== depHit && t.label !== 'dep' && t.pos > (depHit?.pos ?? -1) && (!depHit || hhmm(t) !== hhmm(depHit) || t.plus !== depHit.plus),
    );
  }

  const depDate = dates[0]?.date;
  let arrDate = dates[1]?.date;
  if (depDate && !arrDate && arrHit && arrHit.plus > 0) arrDate = addDaysIso(depDate, arrHit.plus);

  const positions = items.map((i) => i.pos);
  if (flight) positions.push(flight.pos, flight.end);
  const first = positions.length ? Math.min(...positions) : 0;
  const last = positions.length ? Math.max(...positions) : 0;
  const lineOf = (pos: number): number => {
    let n = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
    return n;
  };
  const raw = origLines
    .slice(lineOf(first), lineOf(Math.max(first, last - 1)) + 1)
    .map((l) => l.trim())
    .filter(Boolean);

  const leg: ParsedLeg & { _first: number; _last: number } = {
    confidence: 0,
    raw,
    _first: first,
    _last: last,
  };
  if (flight) leg.flightNumber = flight.num;
  if (from) leg.from = from;
  if (to) leg.to = to;
  if (depDate) leg.depDate = depDate;
  if (depHit) leg.depTime = hhmm(depHit);
  if (arrHit) leg.arrTime = hhmm(arrHit);
  if (arrDate) leg.arrDate = arrDate;
  return leg;
}

function scoreLeg(l: ParsedLeg, inheritedDate: boolean): number {
  let s = 0;
  if (l.flightNumber) s += 0.25;
  if (l.from) s += 0.15;
  if (l.to) s += 0.15;
  if (l.depTime) s += 0.15;
  if (l.arrTime) s += 0.15;
  if (l.depDate) s += inheritedDate ? 0.05 : 0.1;
  if (l.arrDate) s += 0.05;
  else if (l.depDate && l.arrTime && !inheritedDate) s += 0.025;
  return Math.round(Math.min(1, s) * 100) / 100;
}

function mergeDuplicates<T extends ParsedLeg>(legs: T[]): T[] {
  const out: T[] = [];
  for (const l of legs) {
    const twin = l.flightNumber
      ? out.find(
          (o) =>
            o.flightNumber === l.flightNumber &&
            !(o.depDate && l.depDate && o.depDate !== l.depDate) &&
            !(o.depTime && l.depTime && o.depTime !== l.depTime) &&
            !(o.from && l.from && o.from !== l.from),
        )
      : undefined;
    if (!twin) {
      out.push(l);
      continue;
    }
    twin.from ??= l.from;
    twin.to ??= l.to;
    twin.depDate ??= l.depDate;
    twin.depTime ??= l.depTime;
    twin.arrDate ??= l.arrDate;
    twin.arrTime ??= l.arrTime;
    twin.raw = [...twin.raw, ...l.raw.filter((r) => !twin.raw.includes(r))];
    twin.confidence = Math.max(twin.confidence, l.confidence);
  }
  return out;
}

// ───────────────────────────── entry point ─────────────────────────────

export function parseItineraryText(text: string, opts: ParseOptions): ParsedLeg[] {
  if (!text || !text.trim()) return [];
  const ref = opts.referenceDate ?? new Date();
  const src = normalize(text);

  const { hits: dates, masked: afterDates } = findDates(src, ref);
  const { hits: flightHits, masked: afterFlights } = findFlights(afterDates);
  const { hits: times, bare } = findTimes(afterFlights);
  const airs = findAirports(afterFlights, opts, flightHits, times, bare);

  // accept bare HHMM only next to an airport or a Dep/Arr label
  const bareAccepted = bare.filter((b) => {
    if (b.label) return true;
    if (times.some((t) => t.pos < b.end && t.end > b.pos)) return false;
    return airs.some((a) => (a.end <= b.pos && b.pos - a.end <= 8) || (b.end <= a.pos && a.pos - b.end <= 8));
  });
  const allTimes = [...times, ...bareAccepted].sort((a, b) => a.pos - b.pos);

  // merge near-duplicate flight-number anchors (same number repeated close together)
  const anchors: FlightHit[] = [];
  for (const f of flightHits) {
    const prev = anchors[anchors.length - 1];
    if (prev && prev.num === f.num && f.pos - prev.end <= 60) continue;
    anchors.push(f);
  }

  const items: Item[] = [
    ...airs.map((air): Item => ({ kind: 'air', pos: air.pos, air })),
    ...allTimes.map((time): Item => ({ kind: 'time', pos: time.pos, time })),
    ...dates.map((date): Item => ({ kind: 'date', pos: date.pos, date })),
  ].sort((a, b) => a.pos - b.pos);

  const origLines = text.replace(/\r\n?/g, '\n').split('\n');
  let built: (ParsedLeg & { _first: number; _last: number })[];
  if (anchors.length > 0) {
    const groups = segment(anchors, items);
    built = groups.map((g, i) => buildLeg(src, origLines, anchors[i], g));
  } else {
    built = segmentAnchorless(items).map((g) => buildLeg(src, origLines, undefined, g));
  }

  // Inherit a missing departure date from the previous leg when the airports chain
  // (same local clock at the layover airport => same-day or next-day).
  const inherited = new Set<ParsedLeg>();
  for (let i = 1; i < built.length; i++) {
    const p = built[i - 1];
    const l = built[i];
    if (l.depDate || !l.depTime) continue;
    const prevDate = p.arrDate ?? p.depDate;
    if (!prevDate || !p.arrTime) continue;
    if (p.to && l.from && p.to !== l.from) continue;
    l.depDate = l.depTime >= p.arrTime ? prevDate : addDaysIso(prevDate, 1);
    inherited.add(l);
    if (l.arrTime && !l.arrDate) {
      // arrival marker already applied only when a date existed; apply "+N" now if present
      const hit = allTimes.find((t) => hhmm(t) === l.arrTime && t.plus > 0 && t.pos >= l._first && t.pos <= l._last);
      if (hit) l.arrDate = addDaysIso(l.depDate, hit.plus);
    }
  }

  const merged = mergeDuplicates(built);
  return merged.map((l) => {
    const { _first, _last, ...rest } = l;
    void _first;
    void _last;
    const leg: ParsedLeg = { ...rest, confidence: scoreLeg(l, inherited.has(l)) };
    return leg;
  });
}
