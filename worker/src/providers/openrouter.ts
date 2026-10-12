import { z } from 'zod';
import { DEFAULT_OPENROUTER_ALLOWED, DEFAULT_OPENROUTER_MODEL, type Env } from '../env';
import { HttpError } from '../lib/http';
import { buildPrompt } from '../prompts';
import { schemaFor } from '../schema';
import { PROVIDER_TIMEOUT_MS, attachmentLabel, pdfFileName, type LlmInput, type LlmRaw } from './llm';

const URL = 'https://openrouter.ai/api/v1/chat/completions';

export function openRouterModel(env: Env): string {
  return env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

export function openRouterAllowedModels(env: Env): string[] {
  const list = (env.OPENROUTER_ALLOWED_MODELS ?? DEFAULT_OPENROUTER_ALLOWED)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([openRouterModel(env), ...list]));
}

/** Pick the model: the default, or a per-request override from the allow-list (else 400). */
export function resolveOpenRouterModel(env: Env, requested?: string): string {
  if (!requested) return openRouterModel(env);
  if (!openRouterAllowedModels(env).includes(requested)) {
    throw new HttpError(400, 'Requested model is not allowed.');
  }
  return requested;
}

/** Strip ``` fences and parse; returns undefined on failure. */
export function parseJsonLoose(content: string): unknown {
  let s = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1]!.trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}

function jsonSchemaFor(task: LlmInput['task']): Record<string, unknown> {
  const js = z.toJSONSchema(schemaFor(task)) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export async function callOpenRouter(env: Env, input: LlmInput): Promise<LlmRaw> {
  const model = resolveOpenRouterModel(env, input.model);
  const files = input.files ?? [];
  const prompt = buildPrompt(input.task, input.referenceDate, input.text, files.length || 1);

  // Instruction first, then every attachment in order, each preceded by its label (multi-attachment requests).
  const content: unknown[] = [{ type: 'text', text: prompt }];
  let hasPdf = false;
  files.forEach((f, i) => {
    if (input.labelled) content.push({ type: 'text', text: attachmentLabel(i, files.length, f.name) });
    if (f.mediaType === 'application/pdf') {
      hasPdf = true;
      content.push({ type: 'file', file: { filename: pdfFileName(f, i, input.labelled), file_data: `data:application/pdf;base64,${f.data}` } });
    } else {
      content.push({ type: 'image_url', image_url: { url: `data:${f.mediaType};base64,${f.data}` } });
    }
  });

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: input.task, strict: true, schema: jsonSchemaFor(input.task) },
    },
    provider: { require_parameters: true },
    temperature: 0,
    max_tokens: 4000,
  };
  if (hasPdf) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];

  let res: Response;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://usmanghani.github.io/inflight-prayer-times',
        'X-Title': 'In-Flight Prayer Times',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, 'The AI service could not be reached. Please try again.');
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new HttpError(503, 'The AI service is not configured correctly.');
    if (res.status === 402) throw new HttpError(503, 'The AI service is out of credits.');
    if (res.status === 429) throw new HttpError(429, 'The AI service is busy. Please retry shortly.');
    throw new HttpError(502, 'The AI service returned an error.');
  }

  let data: {
    error?: unknown;
    model?: string;
    choices?: { message?: { content?: unknown; refusal?: unknown } }[];
  };
  try {
    data = await res.json();
  } catch {
    throw new HttpError(502, 'The AI service returned an unreadable response.');
  }
  if (data.error) throw new HttpError(502, 'The AI service returned an error.');
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new HttpError(422, 'The AI model declined to read this input.');
  const text = typeof msg?.content === 'string' ? msg.content : undefined;
  if (!text) throw new HttpError(502, 'The AI service returned an empty response.');
  const parsed = parseJsonLoose(text);
  if (parsed === undefined) throw new HttpError(502, 'The AI service returned invalid JSON.');
  return { provider: 'openrouter', model: data.model || model, parsed };
}
