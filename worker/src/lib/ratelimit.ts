import type { Env } from '../env';

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * Returns true if the request may proceed. Tolerates the binding being absent
 * (returns true) and fails open if the binding throws.
 */
export async function checkRateLimit(req: Request, env: Env, kind: 'general' | 'extract'): Promise<boolean> {
  const ip = clientIp(req);
  try {
    if (kind === 'extract') {
      if (env.RATE_LIMITER_EXTRACT) return (await env.RATE_LIMITER_EXTRACT.limit({ key: `x:${ip}` })).success;
      if (env.RATE_LIMITER) return (await env.RATE_LIMITER.limit({ key: `x:${ip}` })).success;
      return true;
    }
    if (env.RATE_LIMITER) return (await env.RATE_LIMITER.limit({ key: ip })).success;
    return true;
  } catch {
    return true;
  }
}
