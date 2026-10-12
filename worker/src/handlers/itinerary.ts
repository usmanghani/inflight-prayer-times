import type { Env, Handler } from '../env';
import { HttpError, errorResponse, isIsoDate, json } from '../lib/http';
import { checkRateLimit } from '../lib/ratelimit';
import { callAnthropic } from '../providers/anthropic';
import { IMAGE_TYPES, sanitizeFileName, type LlmFile, type LlmInput, type LlmRaw, type MediaType, type ProviderName } from '../providers/llm';
import { callOpenAI } from '../providers/openai';
import { callOpenRouter } from '../providers/openrouter';
import { normalizeLegs, normalizeWarnings, normalizeWaypoints, topLevel, type Task } from '../schema';

/** Per attachment (decoded). */
export const MAX_DECODED_BYTES = 8 * 1024 * 1024;
/** Attachments per request, and all of them together (decoded). */
export const MAX_IMAGES = 10;
export const MAX_TOTAL_DECODED_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 50_000;
/** 8 MB of base64 is ~10.7 MB; leave headroom for the JSON envelope. Used for text / single-image / route bodies. */
const MAX_BODY_BYTES = 11 * 1024 * 1024;
/** 20 MB decoded is ~26.7 MB of base64, plus the JSON envelope and per-item overhead. */
export const MAX_MULTI_BODY_BYTES = 28 * 1024 * 1024;

/**
 * Rate-limit weight of an extract request with `n` attachments: one unit per started group of three
 * (1-3 images = 1, 4-6 = 2, 7-9 = 3, 10 = 4). The router charges the first unit; the handler charges the rest.
 */
export const extractWeight = (n: number): number => Math.max(1, Math.ceil(n / 3));
const PROVIDERS: ProviderName[] = ['openrouter', 'anthropic', 'openai'];

const configured = (env: Env, p: ProviderName): boolean =>
  p === 'openrouter' ? !!env.OPENROUTER_API_KEY : p === 'anthropic' ? !!env.ANTHROPIC_API_KEY : !!env.OPENAI_API_KEY;

/**
 * Provider order: requested (default openrouter) -> if its key is missing and it is
 * the default/openrouter, fall back to the first other configured provider.
 * An explicitly requested anthropic/openai that is not configured is a 503.
 */
export function selectProvider(env: Env, requested?: ProviderName): ProviderName {
  const want = requested ?? 'openrouter';
  if (configured(env, want)) return want;
  if (want === 'openrouter') {
    const other = PROVIDERS.find((p) => configured(env, p));
    if (other) return other;
    throw new HttpError(503, 'No AI provider is configured on this server.');
  }
  throw new HttpError(503, `AI provider "${want}" is not configured on this server.`);
}

const SIGNATURES: Record<MediaType, (b: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'application/pdf': (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
};

function signatureMatches(b64: string, mediaType: MediaType): boolean {
  try {
    const head = atob(b64.slice(0, 24));
    const bytes = Uint8Array.from(head, (c) => c.charCodeAt(0));
    return SIGNATURES[mediaType](bytes);
  } catch {
    return false;
  }
}

async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('Content-Length') ?? '0');
  if (len > maxBytes) throw new HttpError(413, 'Request body too large.');
  const raw = await req.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'Request body too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.');
  return body as Record<string, unknown>;
}

interface Parsed {
  input: LlmInput;
  provider?: ProviderName;
}

function parseCommon(body: Record<string, unknown>): { provider?: ProviderName; referenceDate?: string; model?: string } {
  let provider: ProviderName | undefined;
  if (body.provider != null) {
    if (typeof body.provider !== 'string' || !PROVIDERS.includes(body.provider as ProviderName)) {
      throw new HttpError(400, '"provider" must be "openrouter", "anthropic" or "openai".');
    }
    provider = body.provider as ProviderName;
  }
  let referenceDate: string | undefined;
  if (body.referenceDate != null) {
    if (typeof body.referenceDate !== 'string' || !isIsoDate(body.referenceDate)) throw new HttpError(400, '"referenceDate" must be YYYY-MM-DD.');
    referenceDate = body.referenceDate;
  }
  let model: string | undefined;
  if (body.model != null) {
    if (typeof body.model !== 'string' || body.model.length > 100) throw new HttpError(400, '"model" must be a string.');
    model = body.model;
  }
  return { provider, referenceDate, model };
}

function parseText(body: Record<string, unknown>): string {
  if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, '"text" must be a non-empty string.');
  if (body.text.length > MAX_TEXT_CHARS) throw new HttpError(413, `"text" is too long (max ${MAX_TEXT_CHARS} characters).`);
  return body.text;
}

interface Attachment extends LlmFile {
  decodedBytes: number;
}

/** Validate one base64 attachment. `what` prefixes error messages ("File" or "Attachment 2"). */
function parseAttachment(item: { image: unknown; mediaType: unknown }, what: string): Attachment {
  const { mediaType } = item;
  if (typeof mediaType !== 'string' || ![...IMAGE_TYPES, 'application/pdf'].includes(mediaType)) {
    throw new HttpError(400, `${what === 'File' ? '' : `${what}: `}"mediaType" must be image/jpeg, image/png, image/webp, image/gif or application/pdf.`);
  }
  if (typeof item.image !== 'string' || !item.image) throw new HttpError(400, `${what === 'File' ? '' : `${what}: `}"image" must be a base64 string.`);
  const b64 = item.image.replace(/^data:[^,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, `${what === 'File' ? '' : `${what}: `}"image" is not valid base64.`);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_DECODED_BYTES) throw new HttpError(413, `${what} too large (max 8 MB).`);
  if (!signatureMatches(b64, mediaType as MediaType)) throw new HttpError(400, `${what} content does not match "mediaType".`);
  return { mediaType: mediaType as MediaType, data: b64, decodedBytes };
}

function parseImages(images: unknown): LlmFile[] {
  if (!Array.isArray(images) || images.length === 0) throw new HttpError(400, '"images" must be a non-empty array.');
  if (images.length > MAX_IMAGES) throw new HttpError(413, `Too many attachments (max ${MAX_IMAGES}).`);
  let total = 0;
  const files: LlmFile[] = [];
  images.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `Attachment ${i + 1} must be an object with "image" and "mediaType".`);
    const item = raw as Record<string, unknown>;
    if (item.name != null && typeof item.name !== 'string') throw new HttpError(400, `Attachment ${i + 1}: "name" must be a string.`);
    const att = parseAttachment({ image: item.image, mediaType: item.mediaType }, `Attachment ${i + 1}`);
    total += att.decodedBytes;
    if (total > MAX_TOTAL_DECODED_BYTES) throw new HttpError(413, 'The attachments are too large together (max 20 MB in total).');
    const name = sanitizeFileName(item.name);
    files.push({ mediaType: att.mediaType, data: att.data, ...(name ? { name } : {}) });
  });
  return files;
}

/**
 * Accepts exactly one of: `{ text }`, `{ image, mediaType }` (single file, original shape) or
 * `{ images: [{ image, mediaType, name? }, ...] }` (1-10 attachments of ONE itinerary, sent together).
 */
export function parseExtractBody(body: Record<string, unknown>): Parsed {
  const common = parseCommon(body);
  const given = (['image', 'images', 'text'] as const).filter((k) => body[k] != null);
  if (given.length > 1) throw new HttpError(400, 'Send only one of "image", "images" or "text".');
  if (given.length === 0) throw new HttpError(400, 'Provide "images" (base64 files), "image" (base64) with "mediaType", or "text".');
  const base = { task: 'itinerary' as const, referenceDate: common.referenceDate, model: common.model };
  if (given[0] === 'text') return { input: { ...base, text: parseText(body) }, provider: common.provider };
  if (given[0] === 'images') return { input: { ...base, files: parseImages(body.images), labelled: true }, provider: common.provider };

  const att = parseAttachment({ image: body.image, mediaType: body.mediaType }, 'File');
  return { input: { ...base, files: [{ mediaType: att.mediaType, data: att.data }] }, provider: common.provider };
}

async function runLlm(env: Env, input: LlmInput, requested?: ProviderName): Promise<LlmRaw> {
  const provider = selectProvider(env, requested);
  // Per-request model overrides are an OpenRouter feature only.
  const withModel = provider === 'openrouter' ? input : { ...input, model: undefined };
  if (provider === 'openrouter') return callOpenRouter(env, withModel);
  if (provider === 'anthropic') return callAnthropic(env, withModel);
  return callOpenAI(env, withModel);
}

function shape(raw: LlmRaw, task: Task) {
  const top = topLevel(raw.parsed);
  if (!top) throw new HttpError(502, 'The AI service returned an unexpected answer.');
  const warnings = [...top.warnings];
  const legs = normalizeLegs(top.legs, warnings);
  const base = { provider: raw.provider, model: raw.model, legs };
  if (task === 'route') return { ...base, waypoints: normalizeWaypoints(top.waypoints, warnings), warnings };
  return { ...base, warnings };
}

export const extractItinerary: Handler = async (req, env) => {
  try {
    const body = await readJsonBody(req, MAX_MULTI_BODY_BYTES);
    const { input, provider } = parseExtractBody(body);
    // The router already charged one unit; bigger requests (more images = more tokens) pay the rest.
    for (let i = 1; i < extractWeight(input.files?.length ?? 1); i++) {
      if (!(await checkRateLimit(req, env, 'extract'))) throw new HttpError(429, 'Too many requests. Please slow down.');
    }
    const raw = await runLlm(env, input, provider);
    return json(shape(raw, 'itinerary'));
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.status, e.message);
    throw e;
  }
};

export const parseRoute: Handler = async (req, env) => {
  try {
    const body = await readJsonBody(req);
    const common = parseCommon(body);
    const text = parseText(body);
    const raw = await runLlm(env, { task: 'route', text, referenceDate: common.referenceDate, model: common.model }, common.provider);
    return json(shape(raw, 'route'));
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.status, e.message);
    throw e;
  }
};

// re-exported for tests
export { normalizeWarnings };
