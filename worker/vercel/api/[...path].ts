/**
 * Vercel Edge Function adapter. Maps process.env to the worker's Env and
 * delegates to the same framework-agnostic router. See docs/BACKEND.md.
 *
 * Deploy: copy/point a Vercel project at the `worker/` directory (so that
 * `vercel/api/[...path].ts` becomes `api/[...path].ts`, or set the project's
 * root + `functions` config accordingly). Every route keeps its /api prefix.
 * Rate limiting binding and the `caches.default` response cache are Cloudflare
 * features and are silently skipped on Vercel.
 */
import { handleRequest } from '../../src/index';
import type { Env } from '../../src/env';

declare const process: { env: Record<string, string | undefined> };

export const config = { runtime: 'edge' };

const KEYS = [
  'ALLOWED_ORIGINS', 'OPENROUTER_MODEL', 'OPENROUTER_ALLOWED_MODELS', 'CLAUDE_MODEL', 'OPENAI_MODEL',
  'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AERODATABOX_API_KEY',
  'FLIGHTAWARE_API_KEY', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
] as const;

export default function handler(req: Request): Promise<Response> {
  const env: Env = {};
  for (const k of KEYS) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return handleRequest(req, env, { waitUntil: () => {} });
}
