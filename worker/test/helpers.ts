import { vi } from 'vitest';
import type { Ctx, Env } from '../src/env';

export const ctx: Ctx = { waitUntil: () => {} };
export const ORIGIN = 'http://localhost:5173';

export function req(path: string, init: RequestInit & { origin?: string | null } = {}): Request {
  const { origin = ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin) headers.set('Origin', origin);
  return new Request(`https://api.example.test${path}`, { ...rest, headers });
}

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Install a fetch mock; the first route returning a Response wins, otherwise throws (no real network). */
export function mockFetch(...routes: FetchRoute[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export const baseEnv: Env = {};

/** A tiny valid 1x1 PNG (base64). */
export const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
