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
| `POST /api/itinerary/extract` | Body `{ image, mediaType, provider?, referenceDate?, model? }` **or** `{ text, ... }` (text ≤ 50 000 chars). `image` is base64 without a `data:` prefix; `mediaType` is `image/jpeg\|png\|webp\|gif` or `application/pdf`; decoded size ≤ 8 MB (413). Returns `{ provider, model, legs: ExtractedLeg[], warnings }`. |
| `POST /api/route/parse` | Body `{ text, provider?, referenceDate?, model? }` for free text such as `KHI-DXB EK601 then DXB-SFO EK225` or an ICAO flight-plan string. Returns `{ provider, model, legs, waypoints: [{ name?, lat, lon }], warnings }`. Waypoints are only returned when coordinates are explicit or the point is a well-known airport; the model is told never to invent coordinates and invalid ones are dropped. |

`ExtractedLeg` is identical to `ParsedLeg` from `src/ocr/parseItinerary.ts`:
`{ flightNumber?, from?, to?, depDate?, depTime?, arrDate?, arrTime?, confidence, raw[] }` with **local airport times as printed**.
Model output is re-validated server-side (IATA `^[A-Z]{3}$`, `HH:mm`, real calendar dates); bad fields are dropped and reported in `warnings`.
The browser should still check that IATA codes exist in its airport database.

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
`extractItinerary(fileOrBlobOrText)` and `parseRoute(text)`. Images are downscaled in the browser (long edge ≤ 1568 px,
JPEG 0.85) before upload; PDFs go through as-is (≤ 8 MB). Prefer sending OCR'd/pasted **text** when you have it: it is cheaper and faster.

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
* Claude Opus (optional) is considerably more expensive per itinerary (cents) and is intended only as a high-accuracy fallback.
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
