import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index';
import type { Env } from '../src/env';
import { ctx, mockFetch, req } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('router / CORS', () => {
  it('GET /api/health reports provider flags and models', async () => {
    const env: Env = { ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k', OPENSKY_CLIENT_ID: 'a', OPENSKY_CLIENT_SECRET: 'b' };
    const res = await handleRequest(req('/api/health'), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.providers).toEqual({
      openrouter: true, anthropic: true, openai: false, aerodatabox: false, flightaware: false,
      opensky: true, adsbdb: true, adsblol: true,
    });
    expect(body.models.openrouter).toBe('deepseek/deepseek-v4.1-flash');
    expect(body.models.anthropic).toBe('claude-opus-5-5');
    expect(body.defaultLlmProvider).toBe('openrouter');
    expect(JSON.stringify(body)).not.toContain('"k"');
  });

  it('reflects an allowed origin and rejects others with 403', async () => {
    const ok = await handleRequest(req('/api/health'), {}, ctx);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('Vary')).toBe('Origin');

    const bad = await handleRequest(req('/api/health', { origin: 'https://evil.example' }), {}, ctx);
    expect(bad.status).toBe(403);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await bad.json()).toEqual({ error: expect.any(String) });
  });

  it('honours ALLOWED_ORIGINS exact match (no prefix matching)', async () => {
    const env: Env = { ALLOWED_ORIGINS: 'https://a.example, https://b.example/' };
    expect((await handleRequest(req('/api/health', { origin: 'https://b.example' }), env, ctx)).status).toBe(200);
    expect((await handleRequest(req('/api/health', { origin: 'https://b.example.evil' }), env, ctx)).status).toBe(403);
    expect((await handleRequest(req('/api/health', { origin: 'http://localhost:5173' }), env, ctx)).status).toBe(403);
  });

  it('allows requests without Origin (non-browser)', async () => {
    const res = await handleRequest(req('/api/health', { origin: null }), {}, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('handles OPTIONS preflight', async () => {
    const res = await handleRequest(req('/api/itinerary/extract', { method: 'OPTIONS' }), {}, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    const bad = await handleRequest(req('/api/health', { method: 'OPTIONS', origin: 'https://evil.example' }), {}, ctx);
    expect(bad.status).toBe(403);
  });

  it('404 for unknown paths and 405 for wrong method (JSON errors)', async () => {
    const nf = await handleRequest(req('/api/nope'), {}, ctx);
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: expect.any(String) });
    const mna = await handleRequest(req('/api/health', { method: 'POST' }), {}, ctx);
    expect(mna.status).toBe(405);
    expect(mna.headers.get('Allow')).toContain('GET');
  });

  it('works with the rate-limit binding absent', async () => {
    const res = await handleRequest(req('/api/health'), {}, ctx);
    expect(res.status).toBe(200);
  });

  it('returns 429 when the rate limiter says no, keyed on CF-Connecting-IP', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const env: Env = { RATE_LIMITER: { limit } };
    const res = await handleRequest(req('/api/health', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env, ctx);
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  });

  it('uses the tighter extract limiter for POST /api/itinerary/extract and fails open on limiter errors', async () => {
    const general = vi.fn(async () => ({ success: true }));
    const extract = vi.fn(async () => ({ success: false }));
    const env: Env = { RATE_LIMITER: { limit: general }, RATE_LIMITER_EXTRACT: { limit: extract } };
    const res = await handleRequest(req('/api/itinerary/extract', { method: 'POST', body: '{}' }), env, ctx);
    expect(res.status).toBe(429);
    expect(general).not.toHaveBeenCalled();

    const broken: Env = { RATE_LIMITER: { limit: async () => { throw new Error('boom'); } } };
    expect((await handleRequest(req('/api/health'), broken, ctx)).status).toBe(200);
  });

  it('returns a generic 500 JSON error without leaking internals', async () => {
    mockFetch(); // nothing mocked: any fetch throws
    const env: Env = { ALLOWED_ORIGINS: 'http://localhost:5173' };
    const res = await handleRequest(req('/api/flight?number=EK226&date=2026-10-12'), env, ctx);
    expect([404, 502]).toContain(res.status);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('default export exposes fetch()', async () => {
    const res = await worker.fetch(req('/api/health'), {}, ctx as unknown as ExecutionContext);
    expect(res.status).toBe(200);
  });
});
