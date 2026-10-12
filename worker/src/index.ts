import type { Ctx, Env, Handler } from './env';
import { extractItinerary, parseRoute } from './handlers/itinerary';
import { flight } from './handlers/flight';
import { health } from './handlers/health';
import { track } from './handlers/track';
import { corsHeaders, originAllowed, preflight, withCors } from './lib/cors';
import { HttpError, errorResponse } from './lib/http';
import { checkRateLimit } from './lib/ratelimit';

interface Route {
  method: 'GET' | 'POST';
  handler: Handler;
  limit: 'general' | 'extract';
}

const ROUTES: Record<string, Route> = {
  '/api/health': { method: 'GET', handler: health, limit: 'general' },
  '/api/flight': { method: 'GET', handler: flight, limit: 'general' },
  '/api/track': { method: 'GET', handler: track, limit: 'general' },
  '/api/itinerary/extract': { method: 'POST', handler: extractItinerary, limit: 'extract' },
  '/api/route/parse': { method: 'POST', handler: parseRoute, limit: 'extract' },
};

/** Framework-agnostic router: (Request, Env, ctx) -> Response. */
export async function handleRequest(req: Request, env: Env, ctx: Ctx): Promise<Response> {
  const finish = (res: Response) => withCors(res, req, env);
  try {
    if (!originAllowed(req, env)) return errorResponse(403, 'Origin not allowed.');
    if (req.method === 'OPTIONS') return preflight(req, env);

    const path = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    const route = ROUTES[path];
    if (!route) return finish(errorResponse(404, 'Not found.'));
    if (req.method !== route.method && !(route.method === 'GET' && req.method === 'HEAD')) {
      const res = errorResponse(405, 'Method not allowed.');
      res.headers.set('Allow', `${route.method}, OPTIONS`);
      return finish(res);
    }
    if (!(await checkRateLimit(req, env, route.limit))) {
      const res = errorResponse(429, 'Too many requests. Please slow down.');
      res.headers.set('Retry-After', '60');
      return finish(res);
    }
    return finish(await route.handler(req, env, ctx));
  } catch (e) {
    if (e instanceof HttpError) return finish(errorResponse(e.status, e.message));
    console.error('unhandled error'); // never log bodies/images
    return finish(errorResponse(500, 'Internal error.'));
  }
}

export { corsHeaders };

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleRequest(req, env, ctx),
};
