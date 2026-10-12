/** Error carrying an HTTP status and a client-safe message. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** Thrown by upstream helpers; never exposed to clients (only the provider name is logged). */
export class UpstreamError extends Error {
  constructor(
    public provider: string,
    public status: number,
  ) {
    super(`${provider} upstream error ${status}`);
    this.name = 'UpstreamError';
  }
}

export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * fetch with a timeout. Returns the Response (caller decides about status codes).
 * Network errors / timeouts are converted to UpstreamError(provider, 0).
 */
export async function upstreamFetch(
  provider: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpstreamError(provider, 0);
  }
}

/**
 * GET/POST JSON. Resolves `null` for "not found"-like statuses (204, 404), throws UpstreamError otherwise.
 */
export async function upstreamJson<T = unknown>(
  provider: string,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<T | null> {
  const res = await upstreamFetch(provider, url, init, timeoutMs);
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(provider, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError(provider, res.status);
  }
}

export function warnUpstream(err: unknown): void {
  // Only provider + status; never keys, URLs with keys or bodies.
  if (err instanceof UpstreamError) console.warn(`upstream ${err.provider} failed (${err.status})`);
  else console.warn('upstream failure');
}

export function isIsoDate(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
