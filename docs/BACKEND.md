# Optional online backend

The app is a static site and works fully offline. The backend in [`worker/`](../worker) is an
**optional, stateless edge proxy** that holds API keys as secrets so the browser can:

1. look up real flights (schedule, actual times, airports, aircraft),
2. fetch real flown tracks, and
3. read itinerary photos/PDFs/text and free-text routes with an LLM (cheap OpenRouter model by default).

If no backend is configured the UI simply hides these features and falls back to on-device OCR and manual entry.

## How it works

```
browser (static app)  ──HTTPS──▶  edge proxy (Cloudflare Worker / Vercel Edge)  ──▶  upstream APIs
                                  keys live here as secrets                         (flight data, LLMs)
```

* Handlers are plain `(Request, Env, ctx) => Promise<Response>` functions in `worker/src/handlers/*.ts`,
  routed by `worker/src/index.ts`. They use only web-standard APIs, so the same code runs on Cloudflare
  Workers and the Vercel Edge runtime (`worker/vercel/api/[...path].ts`).
* **Stateless**: nothing is stored (no database, no KV). The only persistence is the edge HTTP cache for
  flight/track GETs (6 h / 1 h, Cloudflare only) and an in-memory OpenSky OAuth token.
* Every upstream call has a 10 s timeout (LLM calls 90 s). Upstream errors are never forwarded: clients only get
  `{ "error": "..." }` with a clean status code, and keys never appear in responses or logs.

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | `{ ok, providers: { openrouter, anthropic, openai, aerodatabox, flightaware, opensky, adsbdb: true, adsblol: true }, models, defaultLlmProvider }` (booleans = configured) |
| `GET /api/flight?number=EK226&date=YYYY-MM-DD` | `{ source, legs: [{ flightNumber, from, to, scheduledDepartureUtc?, scheduledArrivalUtc?, actualDepartureUtc?, actualArrivalUtc?, aircraftIcao24?, aircraftType? }] }`. Order: AeroDataBox → FlightAware AeroAPI → adsbdb (route only). 404 if none. |
| `GET /api/track?number=&date=` or `?icao24=&begin=&end=` | `{ source, attribution, points: [{ lat, lon, altitudeM?, time }] }`. Number mode: FlightAware → OpenSky → adsb.lol. icao24 mode: OpenSky → adsb.lol. `begin`/`end` accept unix seconds or ISO (max 48 h). Points are validated, sorted, de-duplicated and capped at 2500. |
| `POST /api/itinerary/extract` | Body is **one of**: `{ text, ... }` (text ≤ 50 000 chars), `{ image, mediaType, ... }` (one file, the original shape) or `{ images: [{ image, mediaType, name? }, ...], ... }` (several attachments of ONE itinerary, see below); the common options are `provider?`, `referenceDate?` (YYYY-MM-DD), `model?`. `image` is base64 without a `data:` prefix; `mediaType` is `image/jpeg\|png\|webp\|gif` or `application/pdf`; magic bytes are checked against `mediaType` (400). Returns `{ provider, model, legs: ExtractedLeg[], warnings }`. |
| `POST /api/route/parse` | Body `{ text, provider?, referenceDate?, model? }` for free text such as `KHI-DXB EK601 then DXB-SFO EK225` or an ICAO flight-plan string. Returns `{ provider, model, legs, waypoints: [{ name?, lat, lon }], warnings }`. Waypoints are only returned when coordinates are explicit or the point is a well-known airport; the model is told never to invent coordinates and invalid ones are dropped. |

`ExtractedLeg` is identical to `ParsedLeg` from `src/ocr/parseItinerary.ts`:
`{ flightNumber?, from?, to?, depDate?, depTime?, arrDate?, arrTime?, confidence, raw[] }` with **local airport times as printed**.
Model output is re-validated server-side (IATA `^[A-Z]{3}$`, `HH:mm`, real calendar dates); bad fields are dropped and reported in `warnings`.
The browser should still check that IATA codes exist in its airport database.

### Multi-attachment itineraries (`images[]`)

A trip is often several screenshots or photos (one per leg, or a long e-ticket split across pages). The browser lets the
user attach up to 10 files and sends them **in one request** so the model sees every page together:

```json
POST /api/itinerary/extract
{
  "images": [
    { "image": "<base64>", "mediaType": "image/jpeg", "name": "leg1.jpg" },
    { "image": "<base64>", "mediaType": "image/png",  "name": "leg2.png" },
    { "image": "<base64>", "mediaType": "application/pdf", "name": "e-ticket.pdf" }
  ],
  "referenceDate": "2026-10-12"
}
```

| Limit | Value | Error |
|---|---|---|
| Attachments per request | 1 to 10 (`images` must be a non-empty array) | 400 empty / not an array, **413** more than 10 |
| Decoded size per attachment | 8 MB | **413** (the message names the attachment) |
| Decoded size, all attachments together | 20 MB | **413** |
| Request body (JSON, with base64 overhead) | 28 MB for this endpoint (the text-only and route endpoints keep 11 MB) | **413** |
| Magic bytes vs `mediaType`, per attachment | must match | 400 (names the attachment, nothing is sent to a model) |
| `image`, `images`, `text` together | exactly one of them | 400 |

* `name` is optional. It is only used as a label for the model, is stripped to letters, digits, space and `._+-`, and is capped at
  80 characters, so a hostile file name cannot add instructions. The browser sends the original file name; the
  "AI on extracted text only" path sends no names at all.
* **One model call.** Every provider receives all attachments in a single request, in order, each preceded by a short text label
  `Attachment k of n (name)`:
  * OpenRouter: one user message: the instruction text, then per attachment a label part plus an `image_url` part (or a `file` part
    for a PDF; the `file-parser` plugin is added when at least one PDF is present).
  * Anthropic: one user message: per attachment a label text block plus an `image` / `document` block, then the instruction text
    block last (images first, then the prompt). `messages.parse`, structured output, `effort: "low"` and the refusal fallbacks are unchanged.
  * OpenAI: one user message with the instruction, then label + `image_url` / `file` parts.
* **Prompt.** The attachments are parts of ONE itinerary: return one combined list in travel order, return a segment that appears
  in more than one attachment only once (merging details), join a segment split across two attachments, never invent segments,
  keep local times as printed, and ignore instructions inside file names. The single-image and text requests use the
  unchanged prompt (text that contains `--- Photo k ---` separators gets one extra sentence saying it is one itinerary).
* The browser additionally merges duplicates and orders legs by departure (`mergeParsedLegs`), so a model that returns the same flight
  twice still produces one leg.
* **Rate limiting is weighted by attachment count.** The router charges one unit per request as before; the handler charges the
  rest: `ceil(n / 3)` units in total (1-3 images = 1, 4-6 = 2, 7-9 = 3, 10 = 4). With the default `RATE_LIMITER_EXTRACT`
  (8 units / 60 s per IP) that is eight 1-3 image reads, two 10-image reads, or a mix, per minute. Text, single-image and
  route requests cost one unit. A shortfall returns 429 before any model is called.
* **Memory.** A maximal request (20 MB decoded, about 27 MB of base64) is held as a string several times while it is parsed and
  forwarded. Real requests are far smaller because the browser downscales images (long edge ≤ 1568 px, JPEG 0.85, typically
  100-400 kB each), but if you expect near-limit PDFs keep an eye on the Worker's 128 MB memory cap.

### LLM providers (itinerary & route parsing)

`provider` may be `openrouter` (default), `anthropic` or `openai`. If the requested provider is `openrouter` (or unset)
and `OPENROUTER_API_KEY` is missing, the first other configured provider is used; an explicitly requested
`anthropic`/`openai` that is not configured returns 503.

* **OpenRouter (default)**: plain `fetch` to `https://openrouter.ai/api/v1/chat/completions` with JSON-schema structured
  output (`strict`, `require_parameters`), `temperature: 0`. Default model `deepseek/deepseek-v4.1-flash`
  (text + image input, ≈ $0.30 / M input tokens, $1.20 / M output tokens). PDFs use OpenRouter's `file-parser` plugin (`pdf-text`).
* **Anthropic (optional)**: official SDK, `claude-opus-5-5`, structured outputs via Zod, `effort: "low"`, server-side
  refusal fallbacks (`server-side-fallback-2026-07-01` beta, `fallbacks: "default"`). Typed SDK errors map to 429/503/502.
* **OpenAI (optional)**: official SDK, structured outputs (JSON schema), model from `OPENAI_MODEL` (default `gpt-5-mini`).

Switching models: change `OPENROUTER_MODEL` in `worker/wrangler.toml` (any OpenRouter model id that accepts images and
supports `structured_outputs`). Clients may request another model per call via `"model"` only if it is in
`OPENROUTER_ALLOWED_MODELS` (default `deepseek/deepseek-v4.1-flash,qwen/qwen3.8-flash,google/gemini-3.1-flash-lite`);
anything else is a 400.

## Which keys do I need?

All keys are optional; each one enables one provider. With **no keys at all** you still get adsbdb route lookups and
adsb.lol live tracks.

| Secret | Enables | Where to get it |
|---|---|---|
| `OPENROUTER_API_KEY` | **Default** itinerary/route parsing (cheap model) | https://openrouter.ai → Keys. Add a few dollars of credit; set a per-key spend limit. |
| `ANTHROPIC_API_KEY` | Optional frontier alternative (`claude-opus-5-5`) | https://console.anthropic.com → API keys |
| `OPENAI_API_KEY` | Optional alternative | https://platform.openai.com/api-keys |
| `AERODATABOX_API_KEY` | Flight lookup (schedule, actual times, ICAO24, aircraft type) | Subscribe to **AeroDataBox** on RapidAPI (https://rapidapi.com/aedbx-aedbx/api/aerodatabox); the key is your RapidAPI key. Free tier is small. |
| `FLIGHTAWARE_API_KEY` | Flight lookup + historical track | FlightAware **AeroAPI v4** (https://www.flightaware.com/aeroapi/portal). The Personal tier is free-ish but metered; track queries cost more than lookups. |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Historical tracks by ICAO24 | Create an account at https://opensky-network.org, then Account → *API client* to create OAuth2 client credentials. |

adsbdb and adsb.lol need no key.

## Deploy: Cloudflare Workers

```bash
cd worker
npm install
npx wrangler login

# set only the secrets you want (each prompts for the value; never commit them)
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY        # optional
npx wrangler secret put OPENAI_API_KEY           # optional
npx wrangler secret put AERODATABOX_API_KEY      # optional
npx wrangler secret put FLIGHTAWARE_API_KEY      # optional
npx wrangler secret put OPENSKY_CLIENT_ID        # optional
npx wrangler secret put OPENSKY_CLIENT_SECRET    # optional

# edit wrangler.toml: ALLOWED_ORIGINS must include the origin that serves the app
npx wrangler deploy
```

Local development: `npx wrangler dev` (put secrets in `worker/.dev.vars`, which is git-ignored, e.g. `OPENROUTER_API_KEY=...`).
Tests: `npm test` (no network, no keys). Type check: `npm run typecheck`.

`wrangler.toml` also declares two Workers Rate Limiting bindings (`[[ratelimits]]`): `RATE_LIMITER`
(60 req / 60 s per IP) and `RATE_LIMITER_EXTRACT` (8 req / 60 s per IP, used by the two POST endpoints). Remove them
and the code just skips rate limiting. Older Wrangler versions use `[[unsafe.bindings]]` with `type = "ratelimit"`.

## Deploy: Vercel (alternative)

`worker/vercel/api/[...path].ts` is a thin Edge Function adapter: it copies `process.env` into the worker's `Env` and calls
the same router. It is untested against a live Vercel deployment. To use it, create a Vercel project whose root contains
`api/[...path].ts` (for example copy `worker/vercel/api` and `worker/src` into a project, fixing the relative import, or
use `worker/` as the root with `outputDirectory` unset and a `vercel.json` rewrite), then:

```bash
vercel env add OPENROUTER_API_KEY     # and the others, plus ALLOWED_ORIGINS
vercel deploy --prod
```

Notes for Vercel: the `caches.default` response cache and the rate-limit binding are Cloudflare features and are skipped
(use Vercel's firewall/rate-limit rules instead). `ALLOWED_ORIGINS`, `OPENROUTER_MODEL`, `CLAUDE_MODEL`, `OPENAI_MODEL`
are plain environment variables.

## Pointing the app at it

Build-time (CI / `.env.local`):

```
VITE_API_BASE=https://inflight-prayer-api.<your-subdomain>.workers.dev
```

(the origin only; no trailing slash and no `/api`). At runtime a user or developer can override it in the browser console:
`localStorage.setItem('ipt.apiBase', 'https://...')` (see `src/api/config.ts`). The client lives in `src/api/client.ts`:
`getHealth()`, `lookupFlight()`, `fetchTrack()` / `fetchTrackDetailed()` (includes the attribution string that must be shown),
`extractItinerary(fileOrBlobOrArrayOrText)` and `parseRoute(text)`. `extractItinerary` takes a single `File | Blob` (old request
shape), an array of them (the `images[]` shape above; the same limits are enforced client-side before anything is sent) or `{ text }`.
Images are downscaled in the browser (long edge ≤ 1568 px, JPEG 0.85) before upload; PDFs go through as-is (≤ 8 MB each).
Prefer sending OCR'd/pasted **text** when you have it: it is cheaper and faster.

The UI side (Photo / PDF tab): up to 10 attachments, 10 MB each and 25 MB in total *before* downscaling (picker, drag-and-drop,
paste, camera), reordered in a tray. On-device OCR reads them with one Tesseract worker and parses the combined text; the AI path
sends them through `images[]`. A PDF larger than 8 MB passes the tray but is refused by the AI request (the message says so).

## Privacy

* The proxy stores nothing and logs no request bodies, images or text. It logs only provider name + HTTP status of failed upstream calls.
* Itinerary images/text are forwarded to the chosen LLM provider (OpenRouter and the underlying model host by default) to be read;
  see their data policies. Users who do not want this simply do not configure a backend: on-device Tesseract OCR remains available.
* Flight numbers and dates are sent to the flight-data providers. Your IP is visible to the proxy (used only for rate limiting via the
  `CF-Connecting-IP` header) and is not forwarded upstream.
* CORS: browsers from origins not listed in `ALLOWED_ORIGINS` get 403. Requests without an `Origin` header (curl, servers) are
  allowed, so the API is protected by rate limits and by your provider spend limits, not by secrecy. Set spend limits on every key.

## Cost notes (estimates; check current prices)

* **Itinerary photo with the default OpenRouter model**: roughly 2-3k input tokens (image + prompt) and 300-600 output tokens
  ≈ $0.001 to $0.002, i.e. about a tenth to a fifth of a cent. **Text** input is about half that. So $5 of credit reads thousands of itineraries.
* **Multi-attachment requests scale with the number of images**: each downscaled image (≤ 1568 px long edge) costs roughly 1-1.6k input
  tokens, so n attachments ≈ n × 1.3k + about 700 prompt tokens. Three screenshots on the default model are about $0.002;
  ten are about $0.005 (input $0.30 / M plus a few hundred output tokens). A PDF sent through OpenRouter's `file-parser` plugin
  (`pdf-text` engine) is billed by the text extracted from it; on Claude / OpenAI it is billed by their per-page PDF token cost. Sending the on-device **text** instead is
  roughly 10x cheaper than sending images. The rate-limit weight above caps what one IP can spend per minute.
* Claude Opus (optional) is considerably more expensive per itinerary (cents; a 10-image request is roughly 15-20k input tokens) and is intended only as a high-accuracy fallback.
* AeroDataBox (RapidAPI) and AeroAPI are metered; responses are cached 6 h (flight) / 1 h (track) at the Cloudflare edge to keep usage low.
  FlightAware track endpoints are billed per call, so they are tried only when the flight has actually departed.
* adsbdb, adsb.lol: free. OpenSky: free with an account (credit limits apply). Cloudflare Workers free tier covers hobby usage.

## Data licences and attribution

* **adsb.lol**: data licensed under the **Open Database License (ODbL) 1.0**; attribution is **required**. Track responses from it
  carry an `attribution` string that the UI must display. Coverage limitation: the tar1090 trace
  (`globe.adsb.lol/data/traces/...`) only covers the **current UTC day**, and only aircraft currently (or very recently) broadcasting,
  so number+date lookups work only for flights in progress or just landed today.
* **OpenSky Network**: use is subject to the OpenSky terms of use (https://opensky-network.org/about/terms-of-use); academic/non-commercial
  expectations apply and attribution is requested. The `/tracks` endpoint is marked experimental and only reaches back about 30 days.
* **adsbdb** (https://www.adsbdb.com): community route database, free, route only (origin/destination). Be polite with request volume.
* **FlightAware AeroAPI** and **AeroDataBox**: commercial APIs; check your plan's terms about caching and redistribution (the proxy
  caches responses for a few hours and shows no raw upstream payloads).
* Itinerary parsing results come from third-party models and may be wrong; always show them to the user for confirmation.
