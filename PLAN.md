# In-Flight Prayer Times — Build Plan

A 100% client-side, open-source (MIT) web app that computes Islamic prayer times
**along a flight**, minute by minute, for multi-leg itineraries.

## 1. Core idea

For every minute of the journey (departure → final arrival, including layovers):

1. Work out **where the aircraft is** (lat, lon, altitude) from the leg's route
   (great circle or waypoints / imported real track) and a realistic
   time/altitude profile (taxi → climb → cruise → descent → taxi).
2. Work out **which prayer window is active at that point** by computing the
   prayer times *for that exact location and solar date* and placing the current
   instant among them.
3. When the active window changes between two minutes, **bisect** to the second
   to get the exact transition time ("Maghrib begins at 21:14:32 UTC over
   Greenland at 66.1°N, 41.2°W, FL370").

We also track the sun's altitude at every minute (for charts / sanity checks)
and flag anomalies a static calculator never sees: the sun "re-rising" when
flying west faster than the sun at high latitude, windows that repeat or skip,
24h daylight / no-twilight nights.

## 2. Settings

| Setting | Options | Default |
|---|---|---|
| Asr juristic method | Hanafi (shadow factor 2), Shafi'i / Maliki / Hanbali (factor 1), Ja'fari (factor 1) | **Hanafi** |
| Calculation preset | Karachi, MWL, ISNA, Egypt, Umm al-Qura, Gulf, Kuwait, Qatar, Singapore (MUIS), JAKIM, Diyanet (Turkey), Tehran, Ja'fari (Leva), France UOIF, Russia, Dubai, Custom | **Karachi (18°/18°)** |
| Fajr angle / Isha angle | any number 0–30° (validated) | **18° / 18°** |
| Isha by interval | minutes after Maghrib (Umm al-Qura 90) | off |
| Maghrib angle / interval | for Ja'fari/Tehran (4° / 4.5°) | sunset |
| Midnight | Standard (sunset→sunrise) / Ja'fari (sunset→fajr) | Standard |
| High-latitude rule | Angle-based, 1/7 of night, Middle of night, Nearest latitude (48.5°), None | Angle-based |
| Altitude horizon dip | Apply dip to Sunrise/Maghrib (default on); also to Fajr/Isha (off) | on / off |
| Per-prayer offsets (ihtiyat) | ± minutes each | 0 |

## 3. Elevation & numerics

* Horizon dip for an observer at height h (m): `dip° = 0.0347·√h`
  (≈3.6° at FL360). Sunrise/sunset altitude = −(0.833° + dip). h is clamped to
  `≥ 0` before `√` (no NaN from negative elevations).
* All `acos`/`asin` arguments are **clamped to [−1, 1]**; when the unclamped
  value is outside that range the event *does not occur* at that place/date and
  the high-latitude rule is applied instead (never NaN).
* `cos(lat) = 0` at the poles, `sin(d) = 0` for zero-length legs, zero-duration
  legs / layovers, `tan(90°)` in Asr, arrival-before-departure, NaN/±∞ inputs,
  dateline crossing, longitudes outside ±180 — all explicitly handled and tested.
* No prayer time is ever returned as `NaN`/`Invalid Date`: either a valid
  `Date` or `null` + a reason flag.

## 4. Flight data & routes — where they come from

There is no free, key-less, CORS-friendly API for airline schedules + flown
tracks, so the app uses layered, offline-first sources:

1. **Your itinerary** (photo → on-device OCR with Tesseract.js, or pasted text,
   or manual entry). Departure/arrival local times + airports are the truth for
   your trip. The image never leaves your device.
2. **Airport database** bundled at build time from **OurAirports** (public
   domain): IATA, name, city, country, lat, lon, elevation, + IANA time zone
   (resolved at build time with `tz-lookup`, CC0).
3. **Route geometry**: great-circle path by default; optional waypoints; or
   import an actual flown track (**KML / GPX / CSV** from FlightAware,
   Flightradar24, ADS-B Exchange, OpenSky) to use the real path and altitude.
4. **Real flight library**: a curated set of real scheduled flights (US East &
   West Coast ↔ Asia, South Asia/Karachi, Middle East, Europe, North & South
   Africa, South America, Australia, New Zealand — both directions) with
   typical schedule times, for one-click demos and for the regression test
   matrix. Schedules change — the UI says so.
5. **Optional online lookup** (off by default): `api.adsbdb.com` callsign →
   route, gracefully ignored if offline/blocked.

## 5. Architecture (Vite + TypeScript, no framework)

```
src/
  types.ts                 shared contracts (this plan's source of truth)
  astro/solar.ts           Julian day, sun declination, EoT, RA, GMST, sun alt/az
  prayer/methods.ts        presets, madhabs, defaults
  prayer/static.ts         prayer times for a fixed lat/lon/elev/date (+high-lat rules)
  prayer/inflight.ts       minute sampling, window detection, bisection, anomalies
  geo/geodesy.ts           haversine, bearing, slerp interpolation, path length
  geo/qibla.ts             Qibla bearing, relative to aircraft heading
  flight/profile.ts        altitude/time profile per leg
  flight/journey.ts        multi-leg journey → position(t) incl. layovers
  flight/trackImport.ts    KML / GPX / CSV parsing
  data/airports.json       generated (scripts/build-airports.mjs)
  data/airports.ts         lookup + search
  data/flights.ts          real flight library
  ocr/ocr.ts               Tesseract.js wrapper (lazy loaded)
  ocr/parseItinerary.ts    text → legs heuristics
  time/tz.ts               IANA formatting, local→UTC conversion
  export/csv.ts, ics.ts    downloads
  ui/…                     form, settings, map (Leaflet), timeline, table
tests/                     vitest unit + route-matrix regression
```

## 6. Build steps (parallel sub-agents, Sonnet)

| # | Work | Owner | Status |
|---|---|---|---|
| 1 | Scaffold (Vite/TS/Vitest), `types.ts` contracts, CI + Pages workflow, MIT licence | lead | ✅ done |
| 2 | Astronomy & prayer engine: `astro/`, `prayer/methods.ts`, `prayer/static.ts`, `geo/qibla.ts` | Agent A | ✅ done, 101 tests |
| 3 | Flight & journey: `geo/geodesy.ts`, `flight/*`, `time/tz.ts` | Agent B | ✅ done, 118 tests |
| 4 | Data & OCR: airport DB build, real flight library, Tesseract OCR + itinerary parser | Agent C | 🔄 in progress |
| 5 | In-flight engine `prayer/inflight.ts`, `prayer/summary.ts`, route-matrix regression, `docs/ALGORITHM.md` | Agent D | 🔄 in progress |
| 6 | Edge proxy `worker/` (Cloudflare + Vercel adapter), `src/api/` client, `docs/BACKEND.md` | Agent F | 🔄 in progress |
| 7 | Regression fixture tooling `scripts/fixtures/` + real-track fixtures | Agent G | ⏳ after Agent C |
| 8 | UI: form, settings, Leaflet map, timeline, table, CSV/ICS, PWA, dark mode | Agent E | ⏳ after C, D, F |
| 9 | Integration review, README, push to GitHub, enable Pages | lead | ⏳ blocked on GitHub push access |

## 7. Extras beyond the brief

* Qibla direction at every minute, absolute and relative to aircraft heading.
* Makrooh (prohibited) times: sunrise, zawal, sunset.
* Traveller notes: Qasr; Jam' (combining) shown per madhab — Hanafi does not
  combine (except Arafah/Muzdalifah); Shafi'i/Maliki/Hanbali/Ja'fari allow it.
* Times shown in UTC, origin tz, destination tz, and the tz under the aircraft.
* Export to CSV (per-minute) and ICS (calendar events).
* Works offline (PWA) once loaded.

## 8. Online data, secrets & AI itinerary reading (added)

The browser app stays fully functional offline/static. Anything that needs a
secret goes through a **tiny stateless edge proxy** (`worker/`, Cloudflare
Worker; a Vercel adapter is included) that holds API keys as encrypted secrets
and never stores user data.

| Endpoint | Purpose | Upstreams (first configured wins) |
|---|---|---|
| `GET /api/health` | which providers are configured | — |
| `GET /api/flight?number=EK226&date=2026-10-12` | schedule / actual times / airports | AeroDataBox (key) → FlightAware AeroAPI (key) → adsbdb.com (free, route only) |
| `GET /api/track?number=EK226&date=…` | real flown track (lat, lon, alt, time) | FlightAware AeroAPI (key) → OpenSky (OAuth client) → adsb.lol (free, current day) |
| `POST /api/itinerary/extract` | itinerary photo/PDF/text → structured legs | **OpenRouter `deepseek/deepseek-v4.1-flash`** (default, cheap, vision + JSON schema); Claude / OpenAI optional |
| `POST /api/route/parse` | free-text route / flight-plan string → legs + waypoints | same cheap model |

Hardening: CORS origin allow-list, request size limits (images downscaled
client-side to ≤ 1568 px), per-IP rate limiting, response caching for flight
lookups, no logging of images, model output validated against a schema and then
re-validated in the browser (IATA codes must exist, times parse).
On-device Tesseract OCR remains the default/fallback when no backend is set.

### Regression data tooling

`scripts/fixtures/` — CLI tools that pull **real flights** from the same online
sources (adsbdb route verification, adsb.lol traces, OpenSky / AeroAPI tracks
when credentials are in env) for every flight in the library, both directions,
and save normalised JSON fixtures in `tests/fixtures/tracks/` with source
attribution. The regression suite replays those real tracks through the
in-flight engine and compares against the great-circle model.

## 9. Decisions & action log

| # | Decision / action | Why |
|---|---|---|
| 1 | Defaults: **Hanafi** Asr (factor 2), **Karachi 18°/18°**, angle-based high-latitude rule, horizon dip on for sunrise/maghrib | User request |
| 2 | Event model = per-minute aircraft position → per-location prayer times → window transitions refined by bisection to ~1 s | User request ("where the plane is every minute") |
| 3 | Stack: Vite + TypeScript, no framework; Leaflet; Tesseract.js; `tz-lookup` (CC0); OurAirports (public domain); MIT licence | Fully client-side, open source |
| 4 | Repo `usmanghani/inflight-prayer-times` (personal account, unrelated to heraclescorp); built in a separate local git repo, **not** in the connected `docs` repo | User request |
| 5 | Repo creation from the session was refused (403); user created the empty repo. Push still refused (`push_denied`): the GitHub account connected to Claude lacks write access → fix: connect the `usmanghani` account at claude.ai/connect-github (or add the connected account as a Write collaborator) and install the Claude GitHub App on the repo | Session GitHub scope |
| 6 | Production online data via a small **Cloudflare Worker** (Vercel adapter included) holding secrets; app still works without it | User request |
| 7 | **Regression tooling** that imports real flights from online databases into test fixtures | User request |
| 8 | LLM for itinerary/route parsing = **OpenRouter `deepseek/deepseek-v4.1-flash`** (verified live: text+image, structured outputs, $0.30/M in, $1.20/M out); Claude `claude-opus-5-5` / OpenAI optional fallbacks; per-request model limited to an allow-list; text path (OCR/pasted text) to cut cost | User request: cheaper than frontier models |
| 9 | Source probe (2026-10-12): adsbdb ✅ free; adsb.lol ✅ free (current-day traces); OpenSky live ✅ / historical ❌ without account; FlightAware AeroAPI & AeroDataBox need keys | Determines what fixtures can be fetched now |
| 10 | Reference-value correction: the lead's brief gave Karachi 2026-03-21 values ≈4 min late (Fajr 05:23, Sunrise 06:38, Dhuhr 12:43, Asr 16:59/16:10, Maghrib 18:48, Isha 20:03). Agent A and an independent lead check (transit 12:39 PKT, EoT −7.2 min) agree on **05:19 / 06:35 / 12:39 / 17:01 (Hanafi) · 16:06 (Shafi'i) / 18:43 / 19:59**; tests use the verified values | Accuracy |
| 11 | Also corrected in Agent B's tests: KHI→SFO great-circle 12,991 km (brief said ~13,2xx), KHI→DXB initial bearing 274.4° (brief said 260–270°) | Accuracy |

### Waiting on the user
* GitHub push access (item 5).
* API keys when deploying the Worker: `OPENROUTER_API_KEY` (required for AI parsing); optional `OPENSKY_CLIENT_ID`/`SECRET` (free account, historical tracks), `FLIGHTAWARE_API_KEY`, `AERODATABOX_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
* An actual itinerary photo to test the end-to-end flow (none attached yet).
