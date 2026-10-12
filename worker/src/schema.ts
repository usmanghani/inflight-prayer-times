import { z } from 'zod';

/**
 * Schemas given to the LLM (structured outputs). Deliberately simple: no regex
 * or numeric constraints (not all providers support them); every property is
 * required and optional values are nullable. Real validation happens in
 * `normalizeLegs` after the model answers.
 */
export const ModelLegSchema = z.object({
  flightNumber: z.string().nullable().describe('Flight number such as "EK226" (airline code + digits), or null'),
  from: z.string().nullable().describe('Departure airport IATA code (3 letters), or null'),
  to: z.string().nullable().describe('Arrival airport IATA code (3 letters), or null'),
  depDate: z.string().nullable().describe('Departure date YYYY-MM-DD, or null'),
  depTime: z.string().nullable().describe('Departure LOCAL time exactly as printed, 24h HH:mm, or null'),
  arrDate: z.string().nullable().describe('Arrival date YYYY-MM-DD (apply "+1" day markers), or null'),
  arrTime: z.string().nullable().describe('Arrival LOCAL time exactly as printed, 24h HH:mm, or null'),
  confidence: z.number().describe('0..1 confidence that this segment was read correctly'),
  raw: z.array(z.string()).describe('Source text snippets this segment was read from'),
});

export const ItinerarySchema = z.object({
  legs: z.array(ModelLegSchema),
  warnings: z.array(z.string()).describe('Short notes about anything ambiguous or unreadable'),
});

export const ModelWaypointSchema = z.object({
  name: z.string().nullable(),
  lat: z.number().describe('Latitude in decimal degrees'),
  lon: z.number().describe('Longitude in decimal degrees'),
});

export const RouteSchema = z.object({
  legs: z.array(ModelLegSchema),
  waypoints: z.array(ModelWaypointSchema),
  warnings: z.array(z.string()),
});

export type Task = 'itinerary' | 'route';
export const schemaFor = (task: Task) => (task === 'route' ? RouteSchema : ItinerarySchema);

/** Identical to the browser's ParsedLeg (src/ocr/parseItinerary.ts). */
export interface ExtractedLeg {
  flightNumber?: string;
  from?: string;
  to?: string;
  depDate?: string;
  depTime?: string;
  arrDate?: string;
  arrTime?: string;
  confidence: number;
  raw: string[];
}

export interface RouteWaypoint {
  name?: string;
  lat: number;
  lon: number;
}

// ───────────────────────── post-validation ─────────────────────────

const IATA = z.string().regex(/^[A-Z]{3}$/);
const FLIGHT = z.string().regex(/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/);
const TIME = z.string().regex(/^\d{2}:\d{2}$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function validDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function validTime(s: string): boolean {
  const [h, m] = s.split(':').map(Number);
  return h! <= 23 && m! <= 59;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Validate/clean one leg of untrusted model output; problems are appended to `warnings`. */
export function normalizeLeg(input: unknown, idx: number, warnings: string[]): ExtractedLeg | null {
  if (!input || typeof input !== 'object') {
    warnings.push(`Segment ${idx + 1}: not an object, dropped.`);
    return null;
  }
  const o = input as Record<string, unknown>;
  const label = `Segment ${idx + 1}`;
  const leg: ExtractedLeg = { confidence: 0.5, raw: [] };

  const fnRaw = str(o.flightNumber)?.toUpperCase().replace(/[\s-]+/g, '');
  if (fnRaw) {
    if (FLIGHT.safeParse(fnRaw).success) leg.flightNumber = fnRaw;
    else warnings.push(`${label}: flight number "${fnRaw}" looks invalid, ignored.`);
  }
  for (const key of ['from', 'to'] as const) {
    const v = str(o[key])?.toUpperCase();
    if (!v) continue;
    if (IATA.safeParse(v).success) leg[key] = v;
    else warnings.push(`${label}: "${key}" value "${v}" is not a 3-letter IATA code, ignored.`);
  }
  for (const key of ['depDate', 'arrDate'] as const) {
    const v = str(o[key]);
    if (!v) continue;
    if (DATE.safeParse(v).success && validDate(v)) leg[key] = v;
    else warnings.push(`${label}: "${key}" value "${v}" is not a valid YYYY-MM-DD date, ignored.`);
  }
  for (const key of ['depTime', 'arrTime'] as const) {
    let v = str(o[key]);
    if (!v) continue;
    if (/^\d:\d{2}$/.test(v)) v = `0${v}`;
    if (TIME.safeParse(v).success && validTime(v)) leg[key] = v;
    else warnings.push(`${label}: "${key}" value "${v}" is not a valid 24h HH:mm time, ignored.`);
  }
  const c = o.confidence;
  if (typeof c === 'number' && Number.isFinite(c)) leg.confidence = Math.min(1, Math.max(0, c));
  else warnings.push(`${label}: missing confidence, assumed 0.5.`);
  if (Array.isArray(o.raw)) {
    leg.raw = o.raw
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.slice(0, 300))
      .slice(0, 20);
  }

  if (!leg.flightNumber && !leg.from && !leg.to) {
    warnings.push(`${label}: no usable flight number or airports, dropped.`);
    return null;
  }
  return leg;
}

export const MAX_LEGS = 30;

export function normalizeLegs(input: unknown, warnings: string[]): ExtractedLeg[] {
  const arr = Array.isArray(input) ? input : [];
  if (arr.length > MAX_LEGS) warnings.push(`Only the first ${MAX_LEGS} segments were kept.`);
  const out: ExtractedLeg[] = [];
  arr.slice(0, MAX_LEGS).forEach((l, i) => {
    const leg = normalizeLeg(l, i, warnings);
    if (leg) out.push(leg);
  });
  return out;
}

export function normalizeWaypoints(input: unknown, warnings: string[]): RouteWaypoint[] {
  const arr = Array.isArray(input) ? input : [];
  const out: RouteWaypoint[] = [];
  for (const w of arr.slice(0, 500)) {
    const o = w as Record<string, unknown> | null;
    const lat = o?.lat;
    const lon = o?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      warnings.push('A waypoint with invalid coordinates was dropped.');
      continue;
    }
    const wp: RouteWaypoint = { lat, lon };
    const name = str(o?.name);
    if (name) wp.name = name.slice(0, 40);
    out.push(wp);
  }
  return out;
}

export function normalizeWarnings(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((w): w is string => typeof w === 'string').map((w) => w.slice(0, 300)).slice(0, 20) : [];
}

/** Top-level shape guard for untrusted parsed JSON. Returns null when unusable. */
export function topLevel(parsed: unknown): { legs: unknown; waypoints: unknown; warnings: string[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.legs)) return null;
  return { legs: o.legs, waypoints: o.waypoints, warnings: normalizeWarnings(o.warnings) };
}
