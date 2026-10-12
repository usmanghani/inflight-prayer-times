/**
 * Polite HTTP client for the fixture tools:
 *  - at most 2 requests / second per host (cache hits are free),
 *  - timeouts, retries with exponential backoff on network errors / 429 / 5xx (honours Retry-After),
 *  - on-disk response cache in scripts/fixtures/.cache/ (gitignored).
 *
 * Behind a proxy, Node's fetch needs `NODE_USE_ENV_PROXY=1` (Node >= 22.21) so that HTTPS_PROXY is honoured.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');

export const USER_AGENT =
  'inflight-prayer-times-regression/0.1 (+https://github.com/usmanghani/inflight-prayer-times; research fixtures, <=2 req/s)';

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Cache lifetime in ms. 0 / undefined = do not read or write the cache. Infinity = forever. */
  ttlMs?: number;
  timeoutMs?: number;
  retries?: number;
  /** Minimum ms between requests to the same host (default 500 = 2 req/s). */
  minIntervalMs?: number;
  /** Statuses that are valid, cacheable answers (default 200, 404). Other statuses are returned but never cached. */
  cacheableStatuses?: number[];
  /** Part of the cache key that is not in the URL (never put secrets here). */
  cacheKeyExtra?: string;
  /** Quiet mode: do not log retries. */
  quiet?: boolean;
}

export interface HttpResult {
  status: number;
  text: string;
  fromCache: boolean;
  /** Network / timeout failure after all retries (status = 0). */
  error?: string;
  json<T = unknown>(): T | undefined;
}

const lastRequestAt = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Serialise requests per host and enforce the minimum interval. */
async function throttle(host: string, minIntervalMs: number): Promise<void> {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const mine = prev.then(async () => {
    const wait = (lastRequestAt.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
  });
  hostQueue.set(host, mine.catch(() => undefined));
  return mine;
}

function cachePath(url: string, opts: HttpOptions): string {
  const host = new URL(url).hostname;
  const key = createHash('sha1')
    .update(`${opts.method ?? 'GET'} ${url} ${opts.cacheKeyExtra ?? ''}`)
    .digest('hex');
  return join(CACHE_DIR, host, `${key}.json`);
}

function mk(status: number, text: string, fromCache: boolean, error?: string): HttpResult {
  return {
    status, text, fromCache, ...(error ? { error } : {}),
    json<T>() {
      try { return JSON.parse(text) as T; } catch { return undefined; }
    },
  };
}

export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const ttl = opts.ttlMs ?? 0;
  const cacheable = opts.cacheableStatuses ?? [200, 404];
  const cp = cachePath(url, opts);

  if (ttl > 0 && existsSync(cp)) {
    try {
      const hit = JSON.parse(readFileSync(cp, 'utf8')) as { status: number; text: string; fetchedAt: number };
      if (Date.now() - hit.fetchedAt <= ttl) return mk(hit.status, hit.text, true);
    } catch { /* corrupt cache entry: refetch */ }
  }

  const host = new URL(url).hostname;
  const retries = opts.retries ?? 3;
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host, opts.minIntervalMs ?? 500);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers ?? {}) },
        body: opts.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : (res.status === 429 ? 3000 : 1000) * 2 ** attempt;
        if (!opts.quiet) console.warn(`  ! HTTP ${res.status} from ${host}, retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        continue;
      }
      if (ttl > 0 && cacheable.includes(res.status)) {
        mkdirSync(dirname(cp), { recursive: true });
        const tmp = `${cp}.tmp`;
        writeFileSync(tmp, JSON.stringify({ url, status: res.status, text, fetchedAt: Date.now() }));
        renameSync(tmp, cp);
      }
      return mk(res.status, text, false);
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      lastErr = `${err.name}: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`;
      if (attempt < retries) {
        const delay = 1000 * 2 ** attempt;
        if (!opts.quiet) console.warn(`  ! ${lastErr} for ${host}, retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }
  return mk(0, '', false, lastErr);
}

/** Age of a cache entry in ms (undefined when absent). Handy for diagnostics. */
export function cacheAgeMs(url: string, opts: HttpOptions = {}): number | undefined {
  const cp = cachePath(url, opts);
  return existsSync(cp) ? Date.now() - statSync(cp).mtimeMs : undefined;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
