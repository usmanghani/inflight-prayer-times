import type { Ctx } from '../env';

/**
 * Cache successful (200) JSON responses in the Cloudflare edge cache keyed on
 * a normalised synthetic URL. No-ops where `caches` is unavailable (tests, Vercel).
 */
export async function cached(
  ctx: Ctx,
  kind: string,
  params: Record<string, string>,
  ttlSeconds: number,
  produce: () => Promise<Response>,
): Promise<Response> {
  const store = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined;
  if (!store) return produce();
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '')}`)
    .join('&');
  const key = new Request(`https://cache.inflight-prayer-api.invalid/${kind}?${qs}`);
  try {
    const hit = await store.match(key);
    if (hit) return new Response(hit.body, hit);
  } catch {
    /* ignore cache errors */
  }
  const res = await produce();
  if (res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    try {
      ctx.waitUntil(store.put(key, copy));
    } catch {
      /* ignore */
    }
  }
  return res;
}

export const FLIGHT_TTL = 6 * 3600;
export const TRACK_TTL = 3600;
