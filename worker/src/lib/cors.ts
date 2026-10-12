import type { Env } from '../env';

export function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS ?? 'http://localhost:5173,https://usmanghani.github.io';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** True when the request carries no Origin (non-browser) or the Origin is allow-listed. */
export function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

export function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

export function preflight(req: Request, env: Env): Response {
  const h = corsHeaders(req, env);
  return new Response(null, {
    status: 204,
    headers: {
      ...h,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export function withCors(res: Response, req: Request, env: Env): Response {
  const h = corsHeaders(req, env);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  return out;
}
