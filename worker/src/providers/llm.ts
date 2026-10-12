import type { Task } from '../schema';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type MediaType = (typeof IMAGE_TYPES)[number] | 'application/pdf';
export type ProviderName = 'openrouter' | 'anthropic' | 'openai';

/** One image / PDF page (base64, no data: prefix). `name` is already sanitised (see `sanitizeFileName`). */
export interface LlmFile {
  mediaType: MediaType;
  data: string;
  name?: string;
}

export interface LlmInput {
  task: Task;
  /** Either one or more images/PDFs, in attachment order (all go to ONE model call) ... */
  files?: LlmFile[];
  /** ... true when the request used the multi-attachment `images[]` shape: every attachment gets a text label. */
  labelled?: boolean;
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

/** File names are untrusted: keep letters, digits and a few separators only, so a name cannot smuggle instructions. */
export function sanitizeFileName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const clean = name.replace(/[^\p{L}\p{N} ._+\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || undefined;
}

/** "Attachment 2 of 4 (leg2.png)" - the short label sent before each attachment of a multi-attachment request. */
export function attachmentLabel(index: number, total: number, name?: string): string {
  return `Attachment ${index + 1} of ${total}${name ? ` (${name})` : ''}`;
}

/** Fallback file name for a PDF part (providers require one). */
export function pdfFileName(file: LlmFile, index: number, labelled: boolean | undefined): string {
  const base = file.name ?? (labelled ? `attachment-${index + 1}` : 'itinerary');
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}
