import type { TrackPoint } from '../types';
import { getApiBase } from './config';

// ───────────────────────────── types ─────────────────────────────

export type LlmProvider = 'openrouter' | 'anthropic' | 'openai';

export interface HealthResponse {
  ok: boolean;
  providers: {
    openrouter?: boolean;
    anthropic: boolean;
    openai: boolean;
    aerodatabox: boolean;
    flightaware: boolean;
    opensky: boolean;
    adsbdb: boolean;
    adsblol: boolean;
  };
  models?: { openrouter?: string; anthropic?: string; openai?: string };
  defaultLlmProvider?: LlmProvider | null;
}

export interface FlightLookupLeg {
  flightNumber: string;
  from: string;
  to: string;
  scheduledDepartureUtc?: string;
  scheduledArrivalUtc?: string;
  actualDepartureUtc?: string;
  actualArrivalUtc?: string;
  aircraftIcao24?: string;
  aircraftType?: string;
}

export interface FlightLookupResult {
  source: 'aerodatabox' | 'flightaware' | 'adsbdb';
  legs: FlightLookupLeg[];
}

export interface TrackResult {
  source: 'flightaware' | 'opensky' | 'adsblol';
  attribution: string;
  points: TrackPoint[];
}

/** Identical to ParsedLeg in src/ocr/parseItinerary.ts. Times are LOCAL airport times as printed. */
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

export interface ExtractResult {
  provider: LlmProvider;
  model: string;
  legs: ExtractedLeg[];
  warnings: string[];
}

export interface RouteWaypoint {
  name?: string;
  lat: number;
  lon: number;
}

export interface RouteParseResult extends ExtractResult {
  waypoints: RouteWaypoint[];
}

export interface ExtractOptions {
  /** Leave unset to let the server decide (default provider: OpenRouter). */
  provider?: LlmProvider;
  /** YYYY-MM-DD used to infer missing years. */
  referenceDate?: string;
  /** Per-request OpenRouter model (must be in the server's allow-list). */
  model?: string;
  signal?: AbortSignal;
}

// ───────────────────────────── errors ─────────────────────────────

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when no backend base URL is configured. */
export class ApiUnavailableError extends ApiError {
  constructor() {
    super(0, 'No online backend is configured.');
    this.name = 'ApiUnavailableError';
  }
}

// ───────────────────────────── plumbing ─────────────────────────────

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_LONG_EDGE = 1568;
export const JPEG_QUALITY = 0.85;

function requireBase(): string {
  const base = getApiBase();
  if (!base) throw new ApiUnavailableError();
  return base;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = requireBase();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Could not reach the online backend.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : `Request failed (${res.status}).`);
  }
  if (body == null) throw new ApiError(res.status, 'Backend returned an empty response.');
  return body as T;
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ───────────────────────────── endpoints ─────────────────────────────

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', { signal });
}

export function lookupFlight(number: string, date: string, signal?: AbortSignal): Promise<FlightLookupResult> {
  return request<FlightLookupResult>(`/api/flight?${qs({ number: number.trim(), date })}`, { signal });
}

interface RawTrack {
  source: TrackResult['source'];
  attribution: string;
  points: { lat: number; lon: number; altitudeM?: number; time?: string }[];
}

export function toTrackPoints(points: RawTrack['points']): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const pt: TrackPoint = { lat: p.lat, lon: p.lon };
    if (typeof p.altitudeM === 'number' && Number.isFinite(p.altitudeM)) pt.altitudeM = p.altitudeM;
    if (p.time) {
      const d = new Date(p.time);
      if (!Number.isNaN(d.getTime())) pt.time = d;
    }
    out.push(pt);
  }
  return out;
}

/** Full track response including source and the attribution string that must be displayed. */
export async function fetchTrackDetailed(number: string, date: string, signal?: AbortSignal): Promise<TrackResult> {
  const raw = await request<RawTrack>(`/api/track?${qs({ number: number.trim(), date })}`, { signal });
  return { source: raw.source, attribution: raw.attribution, points: toTrackPoints(raw.points ?? []) };
}

export async function fetchTrack(number: string, date: string, signal?: AbortSignal): Promise<TrackPoint[]> {
  return (await fetchTrackDetailed(number, date, signal)).points;
}

// ───────────────────────────── itinerary extraction ─────────────────────────────

/** Downscale an image (long edge <= 1568 px, JPEG 0.85). Falls back to the original when unsupported. */
export async function prepareImage(file: Blob): Promise<Blob> {
  if (file.type === 'application/pdf') return file;
  if (typeof createImageBitmap !== 'function') return file; // node / old browsers: send as-is
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    let out: Blob | null = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff'; // JPEG has no alpha
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      }
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      }
    }
    bmp.close?.();
    return out ?? file;
  } catch {
    return file;
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

/**
 * Read an itinerary from a photo/PDF (`File | Blob`) or from already-extracted text (`string`).
 * Text is far cheaper than images: prefer it when on-device OCR already produced some.
 */
export async function extractItinerary(input: File | Blob | { text: string }, opts: ExtractOptions = {}): Promise<ExtractResult> {
  requireBase();
  const common: Record<string, unknown> = {};
  if (opts.provider) common.provider = opts.provider;
  if (opts.referenceDate) common.referenceDate = opts.referenceDate;
  if (opts.model) common.model = opts.model;

  let payload: Record<string, unknown>;
  if ('text' in input && typeof input.text === 'string') {
    payload = { ...common, text: input.text };
  } else {
    const file = input as Blob;
    const prepared = await prepareImage(file);
    if (prepared.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'File too large (max 8 MB).');
    const mediaType = prepared.type || file.type;
    if (!SUPPORTED.includes(mediaType)) throw new ApiError(400, `Unsupported file type "${mediaType || 'unknown'}".`);
    payload = { ...common, image: await blobToBase64(prepared), mediaType };
  }
  return request<ExtractResult>('/api/itinerary/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

/** Parse a free-text route ("KHI-DXB EK601 then DXB-SFO EK225" or an ICAO flight-plan string). */
export function parseRoute(text: string, opts: ExtractOptions = {}): Promise<RouteParseResult> {
  const body: Record<string, unknown> = { text };
  if (opts.provider) body.provider = opts.provider;
  if (opts.referenceDate) body.referenceDate = opts.referenceDate;
  if (opts.model) body.model = opts.model;
  return request<RouteParseResult>('/api/route/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}
