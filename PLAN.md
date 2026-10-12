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
| Profile | **Barelvi (Ahl-e-Sunnat)**, Deobandi, Custom | **Barelvi** |
| Calculation preset | Karachi, MWL, ISNA, Egypt, Umm al-Qura, Gulf, Kuwait, Qatar, Singapore (MUIS), JAKIM, Diyanet (Turkey), Tehran, Ja'fari (Leva), France UOIF, Russia, Dubai, Custom | **Karachi (18°/18°)** |
| Fajr angle / Isha angle | any number 0–30° (validated) | **18° / 18°** |
| Isha by interval | minutes after Maghrib (Umm al-Qura 90) | off |
| Maghrib angle / interval | for Ja'fari/Tehran (4° / 4.5°) | sunset |
| Midnight | Standard (sunset→sunrise) / Ja'fari (sunset→fajr) | Standard |
| High-latitude rule (twilight never reaches the angle) | Red twilight (Sahibayn), Angle-based, 1/7 of night, Middle of night, Nearest location, None | **Red twilight 12° for Isha (Barelvi), Fajr → nearest location** (D-F10) |
| Polar day / night fallback | Nearest location (aqrab al-bilad, dynamic), Fixed latitude 48.5° | **Nearest location** |
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
| 4 | Data & OCR: 5,403 airports, 223-flight library (both directions), 14 sample itineraries, Tesseract OCR + itinerary parser | Agent C | ✅ done, 55 tests |
| 5 | In-flight engine `prayer/inflight.ts`, `prayer/summary.ts`, route-matrix regression, `docs/ALGORITHM.md` | Agent D | ✅ done |
| 6 | Edge proxy `worker/` (Cloudflare + Vercel adapter), `src/api/` client, `docs/BACKEND.md`; OpenRouter DeepSeek default | Agent F | ✅ done, 58 worker + 13 client tests |
| 7 | Regression fixture tooling `scripts/fixtures/` + real-track fixtures + library verification vs adsbdb | Agent G | 🔄 in progress |
| 8 | UI: form, settings, Leaflet map, timeline, sun chart, table, CSV/ICS, PWA, dark mode, share links, Web Worker | Agent E | ✅ done (+ Barelvi/Deobandi profiles) |
| 9 | Integration review, README, push to GitHub, enable Pages | lead | 🔄 pushed; README + Pages pending |

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

## 9. Decision record

Every decision made so far, grouped by area. **D-** = decided, **P-** = pending
the user. "User" = the user asked for it; "Lead" = engineering judgement by the
lead; "Agent" = choice made inside a module by a sub-agent and accepted by the lead.

### 9.1 Product scope
| ID | Decision | Source |
|---|---|---|
| D-P1 | Fully client-side, open-source (MIT) web app for in-flight prayer times; multi-leg itineraries incl. layovers | User |
| D-P2 | Itinerary input by photo (on-device OCR), pasted text, manual legs editor, sample routes, imported real track | User + Lead |
| D-P3 | Route library of **real flights** covering US East & West Coast ↔ Asia, South Asia/Karachi, Middle East, Europe, North & South Africa (+ East/West), South America, Australia, New Zealand, polar — **both directions** for every pair | User |
| D-P4 | Extras: Qibla absolute & relative to aircraft nose, makrooh times, qasr/jam' notes per madhab, times in UTC/origin/destination/under-aircraft tz, CSV + ICS export, share link, PWA offline, dark mode | Lead |

### 9.2 Fiqh & calculation settings
| ID | Decision | Source |
|---|---|---|
| D-F1 | Default madhab **Hanafi** (Asr shadow factor 2); Shafi'i, Maliki, Hanbali (factor 1) and Ja'fari supported | User |
| D-F2 | Default angles **Fajr 18°, Isha 18°** (Karachi / University of Islamic Sciences). Basis: Isha after disappearance of the *white* twilight (shafaq abyad, Imam Abu Hanifa); the Sahibayn's red-twilight view (≈15–17°) is available via other presets/custom | User + Lead |
| D-F3 | Custom Fajr/Isha angles allowed (validated finite, 0–30°); Isha-by-interval (Umm al-Qura 90 min), Maghrib angle (Ja'fari 4°, Tehran 4.5°), Ja'fari midnight, per-prayer offsets ±120 min | User + Lead |
| D-F4 | 17 presets: Karachi, MWL, ISNA, Egypt, Umm al-Qura, Gulf, Kuwait, Qatar, Singapore, JAKIM, Diyanet, Tehran, Ja'fari, France, Russia, Dubai, Custom | Lead |
| D-F5 | **Polar day/night fallback = nearest location (aqrab al-bilad)**, computed dynamically: nearest latitude on the same meridian, same observer elevation, where that date has sunrise & sunset; Fajr/Isha there or via the high-latitude rule; Dhuhr stays at the real local transit. Legacy fixed ±48.5° kept as option `polarFallback: 'fixedLatitude'`. Borrowed times carry a UI badge | User |
| D-F6 | South Asian Hanafi position when 18° twilight never occurs (persistent twilight, ≈48.5°+ in summer): Isha remains obligatory and its time is **estimated** (taqdir) — the later, stronger view (Ibn al-Humam, *Fath al-Qadir*; discussed by Ibn Abidin) over al-Baqqali's view that it lapses. Estimation methods used by South Asian Hanafi muftis: nearest day (aqrab al-ayyam — reportedly most common in UK Deobandi timetables, not verified as majority), nearest location (aqrab al-bilad), one-seventh of the night. Angle-based is a modern astronomical convention, not a classical fiqh method. The app states this is ijtihad and the traveller should follow their mufti | Lead research (not a fatwa) |
| D-F7 | Traveller notes: Hanafi — qasr is wajib for a musafir, no combining (jam') except Arafah/Muzdalifah; Shafi'i/Maliki/Hanbali/Ja'fari — jam' permitted | Lead (agent wording, not independently re-verified) |
| D-F8 | **Barelvi (Ahl-e-Sunnat) research** — (a) Normal days: Imam Abu Hanifa's white twilight; Dawat-e-Islami's London timetable for 2026-10-12 back-solves to **Fajr 18.2°, Isha (Hanafi) 18.0°**, Isha (Shafi'i) 12.0°, Maghrib ≈1.4° below horizon (≈3 min after sunset), Asr Hanafi & Shafi'i both listed. (b) Persistent twilight: Darul Ifta Ahlesunnat (Dawat-e-Islami), fatwa FAM-1200, Mufti Muhammad Qasim Attari, 16 May 2026 — Isha is **not waived**; in principle it is qada (Bahar-e-Shariat), but out of necessity follow the **Sahibayn**: Isha after the red twilight (**≈12°**), prayed as ada; return to Imam Abu Hanifa's view when the hardship period ends; cites Fatawa Ridawiyya vol. 5 & 12, Bahar-e-Shariat, Al-Bahr al-Ra'iq, Fatawa Jamia Ashrafia vol. 5. Al-Jamiatul Ashrafia Mubarakpur (Fatawa Shareh Bukhari) — Leicester case: fatwa on the Sahibayn's red-twilight view for Isha; Fajr from actual subh sadiq, rejecting forcing astronomers' 18° (cites Ala Hazrat's risala *Darr al-Qubh*). Neither addresses polar day (no sunset) — no Barelvi-specific source found for D-F5 | Lead research (sources linked in chat; not a fatwa) |
| D-F9 | Deobandi contrast (UK): estimation, e.g. Wifaqul Ulama timetables ≈1 h 15–20 min after Maghrib; nearest day / one-seventh / middle of night; Mufti Taqi Usmani (via Askimam) permits the Sahibayn's 15° in summer only | Lead research |
| D-F10 | **User decision: Barelvi (Ahl-e-Sunnat) profile is the default.** Normal days Fajr 18° / Isha 18° (Imam Abu Hanifa). When 18° never occurs: **Isha at the red twilight 12° (Sahibayn), counted ada**; if 12° never occurs either → nearest location. **Fajr → nearest location** (actual subh sadiq cannot be observed in flight; option `fajrFallback: 'redTwilight'`). Automatic return to 18° whenever it occurs. **Maghrib +3 min** ihtiyat (Dawat-e-Islami timetable). Polar day/night → nearest location. New rule `highLatitudeRule: 'redTwilight'`, settings `redTwilightAngle` (12), `fajrFallback`, `profile`; `PROFILES` = barelvi (default) / deobandi (nearest location) | User |
| D-F11 | Lead judgement inside D-F10: Fajr fallback = nearest location rather than 12° — the sources found give no Barelvi ruling for Fajr at a fixed angle (Ashrafia: go by actual dawn); flagged to the user | Lead |

### 9.3 Algorithm & numerics
| ID | Decision | Source |
|---|---|---|
| D-A1 | Core model: every minute → aircraft position → prayer times for that exact place & local solar date → active window; window changes refined by bisection to ~1 s | User + Lead |
| D-A2 | Window = opened by the last event ≤ t, using times for solar dates d−1, d, d+1 at that place. Windows: fajr, sunrise (no fard), dhuhr, asr, maghrib, isha | Lead |
| D-A3 | Solar position: NOAA/Meeus low-precision (~0.01°); prayer times iterated at the actual event time | Agent |
| D-A4 | Horizon dip `0.0347·√h` (h metres, clamped ≥ 0; ≈3.64° at 11 km). Applied to sunrise/maghrib by default; optional for Fajr/Isha (default off) | User (altitude) + Lead |
| D-A5 | Numeric guards: clamp acos/asin arguments and treat out-of-range as "event does not occur"; poles (cos φ≈0) handled; longitude normalised; NaN/∞ input → all-null `noEvent`, never NaN/Invalid Date; elevation clamped 0–100 km | User (negatives / zero division) |
| D-A6 | Anomalies reported, not hidden: `windowRepeated` (sun "re-rises" — flying west faster than the sun, or crossing meridians fast near the pole), `windowSkipped` (short windows found by recursive 8-way subdivision), `polarDay`/`polarNight`, `highLatitudeRuleUsed` | Lead |
| D-A7 | Verdict on the many "repeated window" anomalies in the route matrix: real consequences of the definitions (high-latitude rules on summer routes; near-polar great circles, e.g. DOH→SFO ≈85°N, where solar time runs backwards). Anomaly message wording to be made case-specific (not always "flying west faster than the sun") | Lead |
| D-A8 | Engine calls the exact `windowAt` per sample and per bisection step (no rounded-position memo); sample count capped at 12,000; 17 h flight ≈ 0.1–0.2 s | Agent |
| D-A9 | Isha portions measured from max(sunset, maghrib) so angle-based Maghrib methods never yield Isha ≤ Maghrib; unreachable Maghrib angle falls back to sunset | Agent |
| D-A10 | Asr = null (`noEvent`) when noon altitude ≤ 0 or the sun stays above the Asr altitude | Agent |

### 9.4 Flight path & time
| ID | Decision | Source |
|---|---|---|
| D-R1 | Route = great circle (slerp; safe for zero-length, antipodal, antimeridian) through optional waypoints; an imported real track overrides | Lead |
| D-R2 | Flight profile defaults: taxi-out 15 min, climb 22, descent 28, taxi-in 8, cruise 11,000 m, climb/descent at 0.6× cruise speed; phases scaled on short flights (cruise `min(cruise, 3000 + 25 m/min)` only when scaled — known altitude step at ≈73 min block, open item) | Agent |
| D-R3 | Layovers: aircraft on the ground at the connecting airport (airport elevation); taxi phases on ground | Lead |
| D-R4 | Timed imported tracks interpolate by time; if the track's clock doesn't overlap the scheduled leg it is shifted to scheduled departure; untimed tracks use the profile timing | Agent |
| D-R5 | Time zones: IANA via Intl; DST-correct local→UTC (spring-forward gap shifts forward, ambiguous → earlier); tz under aircraft via `tz-lookup`, fallback nautical `Etc/GMT±N`; zone-less CSV timestamps read as UTC | Agent |
| D-R6 | Validation: errors for unknown airport, arrival ≤ departure, overlapping legs, block > 22 h; warnings for connection mismatch, same airport, layover > 48 h, implied speed > 1100 or < 250 km/h | Lead + Agent |

### 9.5 Data
| ID | Decision | Source |
|---|---|---|
| D-D1 | Airports: OurAirports (public domain), large/medium + any with scheduled service and IATA; tz via `tz-lookup` at build time → 5,403 airports, 527 KB JSON | Lead + Agent |
| D-D2 | Flight library: 223 flights, 14 sample itineraries; schedules **representative** (anchored to the October timetable; other DST periods may shift block time ≈1 h). Lower-confidence flight numbers listed in `flights.ts`; no LHR–KHI flight used (SFO→LHR→DXB→KHI instead) | Agent |
| D-D3 | Library is verified against adsbdb.com routes by `scripts/fixtures/verify-library.ts`; mismatches get fixed in `flights.ts` (e.g. suspected LH400/LH401 direction swap) | Lead |
| D-D4 | Itinerary parser: DD/MM for ambiguous numeric dates; IATA codes accepted only in context and only if known; stop-words (THE, AND, CAN, …) never airports; "+1" markers; missing year inferred from weekday + reference date | Agent |

### 9.6 Online data, backend & AI
| ID | Decision | Source |
|---|---|---|
| D-B1 | Secrets only in a small stateless **Cloudflare Worker** (Vercel Edge adapter included); the static app works without it | User |
| D-B2 | Flight lookup order: AeroDataBox → FlightAware AeroAPI → adsbdb (free). Track order: FlightAware → OpenSky (OAuth client credentials) → adsb.lol (free, current day only) | Lead |
| D-B3 | **LLM for itinerary/route parsing: OpenRouter `deepseek/deepseek-v4.1-flash`** (verified live: text+image, structured outputs, $0.30/M in, $1.20/M out); fallbacks Claude `claude-opus-5-5` (with server-side refusal fallbacks) and OpenAI (`OPENAI_MODEL`, default `gpt-5-mini` — unverified guess, configurable). Per-request model only from `OPENROUTER_ALLOWED_MODELS` | User |
| D-B4 | Cheaper text path: send OCR'd/pasted text instead of the image; `/api/route/parse` for free-text routes / flight-plan strings; never invent coordinates | User + Lead |
| D-B5 | Hardening: exact-match CORS allow-list; rate limits 60/min general, 8/min extract (Workers Rate Limiting, fail-open if absent); caches 6 h flight / 1 h track; 8 MB decoded upload limit, 50k-char text limit, magic-byte check vs media type; images downscaled in browser to ≤ 1568 px; no logging of bodies/images; model output schema-validated in the worker and re-validated in the browser | Lead + Agent |
| D-B6 | AI reading is opt-in in the UI with a clear "image is sent to the server" notice; on-device Tesseract is the default; parsed legs always go to the editor for confirmation | Lead |

### 9.7 Regression & quality
| ID | Decision | Source |
|---|---|---|
| D-Q1 | Regression tooling imports real flights from online databases into `tests/fixtures/` (adsbdb verification, adsb.lol traces; OpenSky/FlightAware when credentials exist); real tracks replayed vs the great-circle model | User |
| D-Q2 | Route matrix: every library flight × 4 dates (equinoxes/solstices) × settings variants + all itineraries; asserts no NaN, chronological events in range. Default settings at 2-min step, other variants at 6-min (runtime) | Lead + Agent |
| D-Q3 | **No vulnerable dependencies, including dev tooling.** Vitest 3 → 5.0.3 (root + worker) removed tinypool (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr); `npm audit` = 0; CI fails on any audit finding (`--audit-level=low`); agents must keep new deps audit-clean | User |
| D-Q4 | Reference values must be independently verified, never tuned to. Corrections made: Karachi 2026-03-21 = 05:19 / 06:35 / 12:39 / 17:01 (Hanafi) · 16:06 (Shafi'i) / 18:43 / 19:59 PKT (the lead's brief was ≈4 min late); KHI→SFO 12,991 km; KHI→DXB bearing 274.4° | Lead |
| D-Q5 | CI (GitHub Actions): audit, typecheck, tests, build, worker tests, deploy to GitHub Pages | Lead |

### 9.8 Repository & process
| ID | Decision | Source |
|---|---|---|
| D-G1 | Repo `usmanghani/inflight-prayer-times` (personal account, not heraclescorp); built in a separate local repo, not the connected `docs` repo | User |
| D-G2 | Session couldn't create repos (403); user created it. Push was first refused (`push_denied`); after the user fixed access (connected account `usman-heracles` has write access) the repo was attached and `main` pushed. CI green on GitHub; Pages deploy needs Settings → Pages → Source = GitHub Actions | — |
| D-G3 | Built by parallel Sonnet sub-agents with disjoint file ownership and a shared `types.ts` contract; lead reviews, verifies and commits | User |
| D-G4 | `types.ts` additions so far: optional `polarFallback` on PrayerSettings and `borrowedLatitude` on StaticPrayerTimes (non-breaking) | Lead |

### 9.9 Pending — needs the user
* Enable GitHub Pages: Settings → Pages → Source = **GitHub Actions** (D-G2).
* API keys when deploying the Worker: `OPENROUTER_API_KEY` (required for AI parsing); optional `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` (free account; historical tracks), `FLIGHTAWARE_API_KEY`, `AERODATABOX_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
* An actual itinerary photo for an end-to-end test.

### 9.10 Open engineering items (lead)
* Continuous cruise-altitude cap for short flights (D-R2).
* Apply library fixes from adsbdb verification (D-D3).
* Verify live upstream response shapes (AeroDataBox, AeroAPI, OpenSky, adsb.lol, OpenRouter PDF plugin) once keys exist — current worker fixtures are written from documentation.
