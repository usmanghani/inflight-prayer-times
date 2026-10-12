# In-Flight Prayer Times

An open-source, fully client-side web app that calculates Islamic prayer times
**along a flight**: it follows the aircraft minute by minute across a multi-leg
itinerary (including layovers) and tells you when and where each prayer window
opens and closes, at the aircraft's actual position and altitude.

**Live app:** https://usmanghani.github.io/inflight-prayer-times/ (once GitHub Pages is enabled)

## Features

- **Itinerary input:** photo or PDF of your itinerary (on-device OCR; the image
  never leaves your device), pasted e-ticket text, a legs editor with airport
  search, or one of the sample routes from a library of real flights.
- **Minute-by-minute calculation:** aircraft position from great-circle routes
  (or an imported real KML/GPX/CSV track) with a realistic climb, cruise and
  descent profile. Prayer window changes are refined to about one second.
- **All madhabs:** Hanafi (default), Shafi'i, Maliki, Hanbali and Ja'fari, plus
  17 calculation presets and custom Fajr/Isha angles.
- **Profiles:**
  - **Barelvi (Ahl-e-Sunnat), the default:**
    - Fajr and Isha at 18°.
    - When 18° is never reached, Isha moves to the red twilight at 12° (the
      Sahibayn's view), following the Darul Ifta Ahlesunnat fatwa.
    - Fajr is then taken from the nearest location where it occurs.
    - Maghrib is 3 minutes after sunset as a precaution.
  - **Deobandi:** uses the nearest location when 18° is never reached.
  - **Custom.**
- **High latitudes and polar flights:**
  - When the sun never rises or sets, times come from the nearest location with
    a normal day (aqrab al-bilad).
  - Unusual effects are reported, not hidden. For example, the sun appears to
    rise again when you fly west faster than it, or near the pole.
- **Altitude:** the horizon dips about 3.6° at cruise altitude, so sunset is
  later and sunrise earlier in the air.
- **Qibla:** both the absolute bearing and its direction relative to the
  aircraft's nose.
- **Time zones:** times in UTC, at origin and destination, and in the time zone
  under the aircraft.
- **Views and exports:** map, timeline, sun-altitude chart, minute-by-minute
  table, and CSV and ICS (calendar) export.
- **Offline:** works offline once loaded (PWA).

## Quick start

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # unit, route-matrix and real-track regression tests
npm run build      # static site in dist/
```

## Optional backend

The app is fully usable without a server. A small, stateless Cloudflare Worker
(`worker/`, with a Vercel adapter) can hold API keys to add:

- reading itinerary photos with AI, defaulting to the low-cost
  `deepseek/deepseek-v4.1-flash` via OpenRouter, with Claude and OpenAI as
  optional alternatives;
- flight lookups and real flown tracks from AeroDataBox, FlightAware, OpenSky,
  adsbdb and adsb.lol.

See [docs/BACKEND.md](docs/BACKEND.md).

## Documentation

- [PLAN.md](PLAN.md): the design and the full **decision record** (fiqh
  choices with sources, algorithms, data, security).
- [docs/ALGORITHM.md](docs/ALGORITHM.md): how the calculation works, including
  madhab differences, high-latitude rules and the numeric safeguards.
- [docs/REGRESSION.md](docs/REGRESSION.md): the real-flight regression data
  tools and library verification.
- [docs/route-report.md](docs/route-report.md): prayer windows for every
  library flight.

## Disclaimer

Flight schedules in the library are representative and change often; check
with your airline. The calculations follow published methods, but this app is
**not a fatwa**. For rulings, follow your own scholar or mufti.

## Data and licences

- Code: MIT ([LICENSE](LICENSE)).
- Airports: [OurAirports](https://ourairports.com/data/) (public domain).
- Time zones: `tz-lookup` (CC0).
- Map: © OpenStreetMap contributors.
- Real-track test fixtures: © adsb.lol contributors, ODbL 1.0.
