import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index';
import type { Env } from '../src/env';
import { selectProvider } from '../src/handlers/itinerary';
import { buildPrompt } from '../src/prompts';
import { anthropicDeps } from '../src/providers/anthropic';
import { openaiDeps } from '../src/providers/openai';
import { parseJsonLoose, resolveOpenRouterModel } from '../src/providers/openrouter';
import { ItinerarySchema, normalizeLeg, normalizeLegs, normalizeWaypoints } from '../src/schema';
import { PNG_B64, ctx, jsonRes, mockFetch, req } from './helpers';
import { fx } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const OR: Env = { OPENROUTER_API_KEY: 'or-secret' };
const orReply = (obj: unknown, extra: Record<string, unknown> = {}) =>
  jsonRes({ model: 'deepseek/deepseek-v4.1-flash', choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }], ...extra });
const GOOD_LEG = { flightNumber: 'EK226', from: 'SFO', to: 'DXB', depDate: '2026-10-12', depTime: '11:35', arrDate: '2026-10-13', arrTime: '15:25', confidence: 0.9, raw: ['EK226'] };

const post = (path: string, body: unknown, env: Env) =>
  handleRequest(req(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), env, ctx);

describe('schema post-validation', () => {
  it('normalises good fields and flags invalid ones into warnings', () => {
    const w: string[] = [];
    const leg = normalizeLeg({ flightNumber: 'ek 226', from: 'sfo', to: 'Dubai', depDate: '2026-02-30', depTime: '7:45', arrDate: '2026-10-13', arrTime: '25:99', confidence: 1.4, raw: ['a', 3, 'b'] }, 0, w);
    expect(leg).toEqual({ flightNumber: 'EK226', from: 'SFO', depTime: '07:45', arrDate: '2026-10-13', confidence: 1, raw: ['a', 'b'] });
    expect(w.join('\n')).toMatch(/"to".*DUBAI/);
    expect(w.join('\n')).toMatch(/depDate.*2026-02-30/);
    expect(w.join('\n')).toMatch(/arrTime.*25:99/);
  });

  it('drops unusable legs and caps count', () => {
    const w: string[] = [];
    expect(normalizeLegs([{ confidence: 0.2, raw: [] }, 'x', null, GOOD_LEG], w)).toHaveLength(1);
    expect(w.length).toBe(3);
    const many = Array.from({ length: 40 }, () => GOOD_LEG);
    expect(normalizeLegs(many, [])).toHaveLength(30);
  });

  it('waypoints: invalid coordinates dropped', () => {
    const w: string[] = [];
    const out = normalizeWaypoints([{ name: 'A', lat: 25.2, lon: 55.3 }, { lat: 95, lon: 0 }, { lat: 'x', lon: 1 }, { lat: 1, lon: 2 }], w);
    expect(out).toEqual([{ name: 'A', lat: 25.2, lon: 55.3 }, { lat: 1, lon: 2 }]);
    expect(w).toHaveLength(2);
  });

  it('model-facing zod schema accepts a nominal answer', () => {
    expect(ItinerarySchema.safeParse({ legs: [{ ...GOOD_LEG }], warnings: [] }).success).toBe(true);
  });

  it('prompt mentions the key rules and the reference date', () => {
    const p = buildPrompt('itinerary', '2026-10-12');
    expect(p).toMatch(/IATA/);
    expect(p).toMatch(/\+1/);
    expect(p).toMatch(/2026-10-12/);
    expect(buildPrompt('route', undefined, 'KHI-DXB')).toMatch(/<<<INPUT\nKHI-DXB/);
  });
});

describe('provider selection', () => {
  it('defaults to openrouter, falls back to other configured providers', () => {
    expect(selectProvider({ OPENROUTER_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' })).toBe('openrouter');
    expect(selectProvider({ ANTHROPIC_API_KEY: 'b', OPENAI_API_KEY: 'c' })).toBe('anthropic');
    expect(selectProvider({ OPENAI_API_KEY: 'c' })).toBe('openai');
    expect(selectProvider({ OPENAI_API_KEY: 'c' }, 'openrouter')).toBe('openai');
    expect(selectProvider({ OPENROUTER_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }, 'anthropic')).toBe('anthropic');
    expect(() => selectProvider({ OPENROUTER_API_KEY: 'a' }, 'anthropic')).toThrow(/not configured/);
    expect(() => selectProvider({})).toThrow(/No AI provider/);
  });

  it('503 when no provider is configured', async () => {
    const res = await post('/api/itinerary/extract', { text: 'EK226' }, {});
    expect(res.status).toBe(503);
  });
});

describe('request validation', () => {
  it('400s on malformed input', async () => {
    expect((await post('/api/itinerary/extract', 'not json', OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', {}, OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/bmp' }, OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', { image: '***', mediaType: 'image/png' }, OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/jpeg' }, OR)).status).toBe(400); // signature mismatch
    expect((await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/png', text: 'x' }, OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', { text: 'x', provider: 'bogus' }, OR)).status).toBe(400);
    expect((await post('/api/itinerary/extract', { text: 'x', referenceDate: 'yesterday' }, OR)).status).toBe(400);
  });

  it('413 when decoded size exceeds 8 MB, or text exceeds 50k chars', async () => {
    const big = 'iVBORw0KGgo' + 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 100) / 3) * 4);
    const res = await post('/api/itinerary/extract', { image: big, mediaType: 'image/png' }, OR);
    expect(res.status).toBe(413);
    const t = await post('/api/itinerary/extract', { text: 'x'.repeat(50_001) }, OR);
    expect(t.status).toBe(413);
    const bigHeader = await handleRequest(req('/api/itinerary/extract', { method: 'POST', body: '{}', headers: { 'Content-Length': '20000000' } }), OR, ctx);
    expect(bigHeader.status).toBe(413);
  });
});

describe('OpenRouter provider (default)', () => {
  it('image path: sends the documented request and validates output into warnings', async () => {
    const m = mockFetch(() => jsonRes(fx('openrouter-ok.json')));
    const res = await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/png', referenceDate: '2026-10-12' }, OR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provider).toBe('openrouter');
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(body.legs).toHaveLength(2);
    expect(body.legs[0]).toMatchObject({ flightNumber: 'EK226', from: 'SFO', to: 'DXB', depTime: '11:35', arrDate: '2026-10-13' });
    expect(body.legs[1]).toMatchObject({ depTime: '07:45', confidence: 1 });
    expect(body.legs[1].arrTime).toBeUndefined();
    expect(body.warnings).toEqual(expect.arrayContaining(['Second leg time is blurry', expect.stringMatching(/arrTime/)]));
    expect(JSON.stringify(body)).not.toContain('or-secret');

    expect(m.calls).toHaveLength(1);
    const call = m.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const h = new Headers(call.init!.headers);
    expect(h.get('Authorization')).toBe('Bearer or-secret');
    expect(h.get('X-Title')).toBe('In-Flight Prayer Times');
    const sent = JSON.parse(call.init!.body as string);
    expect(sent.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(sent.temperature).toBe(0);
    expect(sent.max_tokens).toBe(4000);
    expect(sent.provider).toEqual({ require_parameters: true });
    expect(sent.plugins).toBeUndefined();
    expect(sent.response_format.type).toBe('json_schema');
    expect(sent.response_format.json_schema.strict).toBe(true);
    const schema = sent.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['legs', 'warnings']);
    expect(schema.properties.legs.items.additionalProperties).toBe(false);
    expect(schema.properties.legs.items.required).toContain('depTime');
    const parts = sent.messages[0].content;
    expect(parts[0].type).toBe('text');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } });
  });

  it('PDF path uses a file part and the file-parser plugin', async () => {
    const m = mockFetch(() => orReply({ legs: [GOOD_LEG], warnings: [] }));
    const pdf = btoa('%PDF-1.4\n%fake');
    const res = await post('/api/itinerary/extract', { image: pdf, mediaType: 'application/pdf' }, OR);
    expect(res.status).toBe(200);
    const sent = JSON.parse(m.calls[0]!.init!.body as string);
    expect(sent.messages[0].content[1]).toEqual({ type: 'file', file: { filename: 'itinerary.pdf', file_data: `data:application/pdf;base64,${pdf}` } });
    expect(sent.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]);
  });

  it('text path sends text only (no image part)', async () => {
    const m = mockFetch(() => orReply({ legs: [GOOD_LEG], warnings: [] }));
    const res = await post('/api/itinerary/extract', { text: 'EK226 SFO 11:35 -> DXB 15:25+1' }, OR);
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.legs[0].flightNumber).toBe('EK226');
    const sent = JSON.parse(m.calls[0]!.init!.body as string);
    expect(sent.messages[0].content).toHaveLength(1);
    expect(sent.messages[0].content[0].text).toContain('EK226 SFO 11:35');
  });

  it('accepts ```json fenced output', async () => {
    mockFetch(() => orReply('```json\n' + JSON.stringify({ legs: [GOOD_LEG], warnings: [] }) + '\n```'));
    const res = await post('/api/itinerary/extract', { text: 'x' }, OR);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).legs).toHaveLength(1);
    expect(parseJsonLoose('here: {"a":1} done')).toEqual({ a: 1 });
    expect(parseJsonLoose('nope')).toBeUndefined();
  });

  it('invalid JSON -> 502; wrong shape -> 502', async () => {
    mockFetch(() => orReply('this is not json'));
    expect((await post('/api/itinerary/extract', { text: 'x' }, OR)).status).toBe(502);
    mockFetch(() => orReply({ foo: 1 }));
    expect((await post('/api/itinerary/extract', { text: 'x' }, OR)).status).toBe(502);
    mockFetch(() => jsonRes({ error: { message: 'model overloaded' } }));
    expect((await post('/api/itinerary/extract', { text: 'x' }, OR)).status).toBe(502);
  });

  it('maps 401/402/429/5xx and network errors to clean errors', async () => {
    const cases: [number, number, RegExp][] = [[402, 503, /credits/], [401, 503, /configured/], [429, 429, /busy/], [500, 502, /error/], [400, 502, /error/]];
    for (const [up, down, re] of cases) {
      mockFetch(() => new Response('{"error":{"message":"secret upstream detail"}}', { status: up }));
      const res = await post('/api/itinerary/extract', { text: 'x' }, OR);
      expect(res.status).toBe(down);
      const j = (await res.json()) as any;
      expect(j.error).toMatch(re);
      expect(j.error).not.toContain('secret upstream detail');
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    expect((await post('/api/itinerary/extract', { text: 'x' }, OR)).status).toBe(503);
  });

  it('refusal -> 422', async () => {
    mockFetch(() => jsonRes({ choices: [{ message: { content: null, refusal: 'no' } }] }));
    expect((await post('/api/itinerary/extract', { text: 'x' }, OR)).status).toBe(422);
  });

  it('model override only from the allow-list', async () => {
    const m = mockFetch(() => orReply({ legs: [GOOD_LEG], warnings: [] }));
    const ok = await post('/api/itinerary/extract', { text: 'x', model: 'qwen/qwen3.8-flash' }, OR);
    expect(ok.status).toBe(200);
    expect(JSON.parse(m.calls[0]!.init!.body as string).model).toBe('qwen/qwen3.8-flash');
    const bad = await post('/api/itinerary/extract', { text: 'x', model: 'anthropic/claude-opus-5' }, OR);
    expect(bad.status).toBe(400);
    expect(m.calls).toHaveLength(1);
    const env: Env = { ...OR, OPENROUTER_MODEL: 'my/model', OPENROUTER_ALLOWED_MODELS: 'other/one' };
    expect(resolveOpenRouterModel(env)).toBe('my/model');
    expect(resolveOpenRouterModel(env, 'other/one')).toBe('other/one');
    expect(resolveOpenRouterModel(env, 'my/model')).toBe('my/model');
  });

  it('falls back to Anthropic when OPENROUTER_API_KEY is missing (no OpenRouter fetch)', async () => {
    const m = mockFetch();
    const parse = vi.fn(async () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', parsed_output: { legs: [GOOD_LEG], warnings: [] } }));
    const spy = vi.spyOn(anthropicDeps, 'createClient').mockReturnValue({ beta: { messages: { parse } } } as unknown as Anthropic);
    const res = await post('/api/itinerary/extract', { text: 'x', model: 'ignored/model' }, { ANTHROPIC_API_KEY: 'a' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).provider).toBe('anthropic');
    expect(m.fn).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('POST /api/route/parse', () => {
  it('returns legs + validated waypoints', async () => {
    const m = mockFetch(() =>
      orReply({
        legs: [{ ...GOOD_LEG, depDate: null, depTime: null, arrDate: null, arrTime: null, flightNumber: 'EK601', from: 'KHI', to: 'DXB' }],
        waypoints: [{ name: 'OPKC', lat: 24.9065, lon: 67.1608 }, { name: 'BAD', lat: 200, lon: 1 }, { name: null, lat: 25.2528, lon: 55.3644 }],
        warnings: [],
      }),
    );
    const res = await post('/api/route/parse', { text: 'KHI-DXB EK601 then DXB-SFO EK225' }, OR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.legs[0]).toMatchObject({ flightNumber: 'EK601', from: 'KHI', to: 'DXB' });
    expect(body.waypoints).toEqual([{ name: 'OPKC', lat: 24.9065, lon: 67.1608 }, { lat: 25.2528, lon: 55.3644 }]);
    expect(body.warnings.some((w: string) => /waypoint/.test(w))).toBe(true);
    const sent = JSON.parse(m.calls[0]!.init!.body as string);
    expect(sent.response_format.json_schema.name).toBe('route');
    expect(sent.response_format.json_schema.schema.required).toEqual(['legs', 'waypoints', 'warnings']);
    expect(sent.messages[0].content[0].text).toContain('NEVER invent');
  });

  it('requires text', async () => {
    expect((await post('/api/route/parse', {}, OR)).status).toBe(400);
    expect((await post('/api/route/parse', { text: 'x'.repeat(50_001) }, OR)).status).toBe(413);
  });
});

describe('Anthropic provider (mocked SDK client)', () => {
  const env: Env = { ANTHROPIC_API_KEY: 'a-secret', CLAUDE_MODEL: 'claude-opus-5-5' };
  function withParse(parse: (...a: any[]) => any) {
    return vi.spyOn(anthropicDeps, 'createClient').mockReturnValue({ beta: { messages: { parse } } } as unknown as Anthropic);
  }
  afterEach(() => vi.restoreAllMocks());

  it('sends image block before text, structured output, effort low, fallbacks beta', async () => {
    const parse = vi.fn(async () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', parsed_output: { legs: [GOOD_LEG], warnings: [] } }));
    withParse(parse);
    const res = await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/png', provider: 'anthropic' }, { ...env, OPENROUTER_API_KEY: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(body.legs[0].from).toBe('SFO');
    const arg = (parse.mock.calls[0] as any[])[0];
    expect(arg.model).toBe('claude-opus-5-5');
    expect(arg.max_tokens).toBe(16000);
    expect(arg.output_config.effort).toBe('low');
    expect(arg.output_config.format.type).toBe('json_schema');
    expect(arg.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(arg.fallbacks).toBe('default');
    expect(arg.thinking).toBeUndefined();
    expect(arg.tool_choice).toBeUndefined();
    const content = arg.messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } });
    expect(content[1].type).toBe('text');
    expect(arg.messages).toHaveLength(1); // no prefill
  });

  it('PDF uses a document block', async () => {
    const parse = vi.fn(async () => ({ stop_reason: 'end_turn', model: 'm', parsed_output: { legs: [GOOD_LEG], warnings: [] } }));
    withParse(parse);
    const pdf = btoa('%PDF-1.7 x');
    await post('/api/itinerary/extract', { image: pdf, mediaType: 'application/pdf', provider: 'anthropic' }, env);
    expect((parse.mock.calls[0] as any[])[0].messages[0].content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } });
  });

  it('refusal -> 422, null parsed_output -> 502', async () => {
    withParse(async () => ({ stop_reason: 'refusal', parsed_output: null }));
    const r = await post('/api/itinerary/extract', { text: 'x', provider: 'anthropic' }, env);
    expect(r.status).toBe(422);
    vi.restoreAllMocks();
    withParse(async () => ({ stop_reason: 'end_turn', parsed_output: null }));
    expect((await post('/api/itinerary/extract', { text: 'x', provider: 'anthropic' }, env)).status).toBe(502);
  });

  it('maps typed SDK errors', async () => {
    const h = new Headers();
    const cases: [unknown, number][] = [
      [new Anthropic.RateLimitError(429, { error: { message: 'secret' } }, 'secret', h), 429],
      [new Anthropic.APIConnectionError({ message: 'secret' }), 503],
      [new Anthropic.InternalServerError(500, { error: { message: 'secret' } }, 'secret', h), 502],
      [new Error('weird'), 502],
    ];
    for (const [err, status] of cases) {
      vi.restoreAllMocks();
      withParse(async () => { throw err; });
      const res = await post('/api/itinerary/extract', { text: 'x', provider: 'anthropic' }, env);
      expect(res.status).toBe(status);
      expect(JSON.stringify(await res.json())).not.toContain('secret');
    }
  });

  it('503 when explicitly requested but not configured', async () => {
    const res = await post('/api/itinerary/extract', { text: 'x', provider: 'anthropic' }, OR);
    expect(res.status).toBe(503);
  });
});

describe('OpenAI provider (mocked SDK client)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses structured output and maps results/errors', async () => {
    const parse = vi.fn(async () => ({ model: 'gpt-5-mini', choices: [{ message: { parsed: { legs: [GOOD_LEG], warnings: [] }, refusal: null } }] }));
    vi.spyOn(openaiDeps, 'createClient').mockReturnValue({ chat: { completions: { parse } } } as unknown as OpenAI);
    const res = await post('/api/itinerary/extract', { image: PNG_B64, mediaType: 'image/png', provider: 'openai' }, { OPENAI_API_KEY: 'k' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).provider).toBe('openai');
    const arg = (parse.mock.calls[0] as any[])[0];
    expect(arg.model).toBe('gpt-5-mini');
    expect(arg.response_format.type).toBe('json_schema');
    expect(arg.messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);

    vi.restoreAllMocks();
    vi.spyOn(openaiDeps, 'createClient').mockReturnValue({
      chat: { completions: { parse: async () => { throw new OpenAI.RateLimitError(429, { message: 'x' }, 'x', new Headers()); } } },
    } as unknown as OpenAI);
    expect((await post('/api/itinerary/extract', { text: 'x', provider: 'openai' }, { OPENAI_API_KEY: 'k' })).status).toBe(429);
  });
});
