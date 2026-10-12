import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { DEFAULT_OPENAI_MODEL, type Env } from '../env';
import { HttpError } from '../lib/http';
import { buildPrompt } from '../prompts';
import { schemaFor } from '../schema';
import { PROVIDER_TIMEOUT_MS, attachmentLabel, pdfFileName, type LlmInput, type LlmRaw } from './llm';

/** Indirection so tests can inject a fake client. */
export const openaiDeps = {
  createClient: (apiKey: string): OpenAI => new OpenAI({ apiKey, maxRetries: 1, timeout: PROVIDER_TIMEOUT_MS }),
};

export function mapOpenAIError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof OpenAI.RateLimitError) return new HttpError(429, 'The AI service is busy. Please retry shortly.');
  if (e instanceof OpenAI.APIConnectionError) return new HttpError(503, 'The AI service could not be reached. Please try again.');
  if (e instanceof OpenAI.APIError) return new HttpError(502, 'The AI service returned an error.');
  return new HttpError(502, 'Unexpected AI service failure.');
}

export async function callOpenAI(env: Env, input: LlmInput): Promise<LlmRaw> {
  const client = openaiDeps.createClient(env.OPENAI_API_KEY ?? '');
  const model = env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const files = input.files ?? [];
  const prompt = buildPrompt(input.task, input.referenceDate, input.text, files.length || 1);

  // One user message: instruction, then every attachment in order (each preceded by its label when several are sent).
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
  files.forEach((f, i) => {
    if (input.labelled) content.push({ type: 'text', text: attachmentLabel(i, files.length, f.name) });
    if (f.mediaType === 'application/pdf') {
      content.push({ type: 'file', file: { filename: pdfFileName(f, i, input.labelled), file_data: `data:application/pdf;base64,${f.data}` } });
    } else {
      content.push({ type: 'image_url', image_url: { url: `data:${f.mediaType};base64,${f.data}` } });
    }
  });

  try {
    const completion = await client.chat.completions.parse({
      model,
      messages: [{ role: 'user', content }],
      response_format: zodResponseFormat(schemaFor(input.task), input.task),
    });
    const msg = completion.choices[0]?.message;
    if (msg?.refusal) throw new HttpError(422, 'The AI model declined to read this input.');
    if (!msg?.parsed) throw new HttpError(502, 'The AI service returned an unusable answer.');
    return { provider: 'openai', model: completion.model || model, parsed: msg.parsed };
  } catch (e) {
    throw mapOpenAIError(e);
  }
}
