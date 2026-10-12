import type { Env, Handler } from '../env';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL } from '../env';
import { json } from '../lib/http';

export const health: Handler = async (_req, env: Env) =>
  json({
    ok: true,
    providers: {
      openrouter: !!env.OPENROUTER_API_KEY,
      anthropic: !!env.ANTHROPIC_API_KEY,
      openai: !!env.OPENAI_API_KEY,
      aerodatabox: !!env.AERODATABOX_API_KEY,
      flightaware: !!env.FLIGHTAWARE_API_KEY,
      opensky: !!(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET),
      adsbdb: true,
      adsblol: true,
    },
    models: {
      openrouter: env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      anthropic: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      openai: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    },
    defaultLlmProvider: env.OPENROUTER_API_KEY
      ? 'openrouter'
      : env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : env.OPENAI_API_KEY
          ? 'openai'
          : null,
  });
