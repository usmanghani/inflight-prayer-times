import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DEFAULT_CLAUDE_MODEL, type Env } from '../env';
import { HttpError } from '../lib/http';
import { buildPrompt } from '../prompts';
import { schemaFor } from '../schema';
import { PROVIDER_TIMEOUT_MS, type LlmInput, type LlmRaw } from './llm';

/** Indirection so tests can inject a fake client. */
export const anthropicDeps = {
  createClient: (apiKey: string): Anthropic => new Anthropic({ apiKey, maxRetries: 1, timeout: PROVIDER_TIMEOUT_MS }),
};

export function mapAnthropicError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof Anthropic.RateLimitError) return new HttpError(429, 'The AI service is busy. Please retry shortly.');
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(503, 'The AI service could not be reached. Please try again.');
  if (e instanceof Anthropic.APIError) return new HttpError(502, 'The AI service returned an error.');
  return new HttpError(502, 'Unexpected AI service failure.');
}

export async function callAnthropic(env: Env, input: LlmInput): Promise<LlmRaw> {
  const client = anthropicDeps.createClient(env.ANTHROPIC_API_KEY ?? '');
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const prompt = buildPrompt(input.task, input.referenceDate, input.text);

  // Image / document block must come BEFORE the text block.
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.file) {
    if (input.file.mediaType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.file.data } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: input.file.mediaType, data: input.file.data } });
    }
  }
  content.push({ type: 'text', text: prompt });

  try {
    // Thinking is always on for this model: no `thinking` param, no prefill, no forced tool_choice.
    // `betas` + `fallbacks: "default"` opts into server-side refusal fallbacks.
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      output_config: { format: zodOutputFormat(schemaFor(input.task)), effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') {
      throw new HttpError(422, 'The AI model declined to read this input. Try a clearer photo or paste the text instead.');
    }
    const parsed = response.parsed_output;
    if (!parsed) throw new HttpError(502, 'The AI service returned an unusable answer.');
    return { provider: 'anthropic', model: response.model || model, parsed };
  } catch (e) {
    throw mapAnthropicError(e);
  }
}
