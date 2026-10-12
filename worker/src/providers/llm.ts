import type { Task } from '../schema';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type MediaType = (typeof IMAGE_TYPES)[number] | 'application/pdf';
export type ProviderName = 'openrouter' | 'anthropic' | 'openai';

export interface LlmInput {
  task: Task;
  /** Either an image/PDF (base64, no data: prefix) ... */
  file?: { mediaType: MediaType; data: string };
  /** ... or plain text. */
  text?: string;
  referenceDate?: string;
  /** Per-request model override (already allow-list checked, OpenRouter only). */
  model?: string;
}

/** Raw (untrusted) model output; shape is validated by `topLevel` / `normalizeLegs`. */
export interface LlmRaw {
  provider: ProviderName;
  model: string;
  parsed: unknown;
}

export const PROVIDER_TIMEOUT_MS = 90_000;
