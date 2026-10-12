/** Minimal shape of a Workers Rate Limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Minimal execution context (subset of Cloudflare's ExecutionContext). */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/** Bindings / secrets / vars. Everything is optional so the worker degrades gracefully. */
export interface Env {
  ALLOWED_ORIGINS?: string;

  // models
  OPENROUTER_MODEL?: string;
  OPENROUTER_ALLOWED_MODELS?: string;
  CLAUDE_MODEL?: string;
  OPENAI_MODEL?: string;

  // secrets
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  AERODATABOX_API_KEY?: string;
  FLIGHTAWARE_API_KEY?: string;
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;

  // bindings
  RATE_LIMITER?: RateLimiter;
  RATE_LIMITER_EXTRACT?: RateLimiter;
}

export type Handler = (req: Request, env: Env, ctx: Ctx) => Promise<Response>;

export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const DEFAULT_OPENROUTER_ALLOWED =
  'deepseek/deepseek-v4.1-flash,qwen/qwen3.8-flash,google/gemini-3.1-flash-lite';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
