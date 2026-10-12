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

## 6. Build steps (parallel sub-agents)

1. **Scaffold + contracts** (lead): Vite/TS/Vitest, `types.ts`.
2. **Agent A — astronomy & prayer engine**: `astro/`, `prayer/methods.ts`,
   `prayer/static.ts`, `geo/qibla.ts` + tests vs. reference values & edge cases.
3. **Agent B — flight & journey**: `geo/geodesy.ts`, `flight/*`, `time/tz.ts`
   + tests (dateline, zero-length, layovers, polar).
4. **Agent C — data & OCR**: airport DB build script, real flight library,
   OCR + itinerary parser + tests.
5. **Agent D — in-flight engine** (after A+B): `prayer/inflight.ts` + route
   matrix regression over the whole flight library.
6. **Agent E — UI** (after all): responsive UI, Leaflet map with track &
   prayer markers, timeline, table, CSV/ICS export, settings persistence,
   dark mode, PWA offline.
7. **Lead — integration review**, GitHub Actions (test + Pages deploy), README.

## 7. Extras beyond the brief

* Qibla direction at every minute, absolute and relative to aircraft heading.
* Makrooh (prohibited) times: sunrise, zawal, sunset.
* Traveller notes: Qasr; Jam' (combining) shown per madhab — Hanafi does not
  combine (except Arafah/Muzdalifah); Shafi'i/Maliki/Hanbali/Ja'fari allow it.
* Times shown in UTC, origin tz, destination tz, and the tz under the aircraft.
* Export to CSV (per-minute) and ICS (calendar events).
* Works offline (PWA) once loaded.
