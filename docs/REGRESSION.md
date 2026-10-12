# Regression data tooling

The in-flight engine computes where the aircraft is every minute and, from that position, which prayer window is
active. Most tests drive it with the great-circle + climb/cruise/descent *model*. This tooling pulls **real flown
tracks** (and checks the flight library against real route data) so we can measure how far the model is from reality.

```
scripts/fixtures/            CLI tools (TypeScript, run with vite-node)
  lib/                       http cache + rate limiter, ICAO airline map, thinning, tar1090 parser, fixture IO
  sources/                   adsbdb · adsblol · opensky · flightaware
  verify-library.ts          library route check against adsbdb      → tests/fixtures/library-verification.json
  capture-live.ts            tracks of flights airborne right now    → tests/fixtures/tracks/*_adsblol.json
  fetch-history.ts           historical tracks (credentials needed)  → tests/fixtures/tracks/*_{opensky,flightaware}.json
tests/fixtures/
  tracks/                    <FLIGHT>_<YYYY-MM-DD>_<source>.json
  snapshots/                 compact event snapshots written by the test
  loadFixtures.ts            loads every track fixture (import.meta.glob)
tests/realTracks.test.ts     replays complete fixtures through the engine
```

## Running the tools

All tools run with `vite-node` (no build step). Behind an HTTPS proxy Node's `fetch` needs `NODE_USE_ENV_PROXY=1`
(Node >= 22.21) to honour `HTTPS_PROXY`.

```sh
# 1. check every library flight against adsbdb (≈4 min the first time; responses are cached for 7 days)
npx vite-node scripts/fixtures/verify-library.ts            # [--limit N] [--refresh] [--no-docs]

# 2. capture flights that are airborne right now (adsb.lol, no key)
npx vite-node scripts/fixtures/capture-live.ts              # one pass (~15 min: one lookup per library flight scheduled around now)
npx vite-node scripts/fixtures/capture-live.ts --watch 120  # keep polling for 2 h; landed flights are re-saved as complete
npx vite-node scripts/fixtures/capture-live.ts --flight EK1,QR8 --watch 600 --poll 4   # only these flights (fast scans)
# options: --all (scan the whole library), --poll <min> (default 5), --full-every <n> (full rescan every n polls, default 6)

# 3. historical tracks (needs credentials, see below)
npx vite-node scripts/fixtures/fetch-history.ts --date 2026-10-10 --flight EK226 --source opensky

# 4. replay the fixtures
npx vitest run tests/realTracks.test.ts
npx tsc --noEmit -p scripts/fixtures/tsconfig.json          # typecheck the scripts
```

Suggested `package.json` scripts: `"fixtures:verify"`, `"fixtures:live"`, `"fixtures:history"`, `"typecheck:scripts"`
(each prefixing `NODE_USE_ENV_PROXY=1` is harmless on a direct connection).

Politeness: every host is limited to 2 requests/second, requests time out after 30 s (60 s for traces) and are retried with
exponential backoff on network errors, 429 and 5xx (Retry-After is honoured). Responses are cached in
`scripts/fixtures/.cache/` (gitignored): adsbdb 7 days, OpenSky/FlightAware history 1–7 days, live adsb.lol data
never (traces 1–2 min). Delete the directory to start fresh.

## Data sources, licences and terms

| Source | Used for | Credentials | Licence / terms |
|---|---|---|---|
| [adsbdb](https://www.adsbdb.com) `api.adsbdb.com/v0/callsign/<cs>` | callsign → origin/destination (library check, route of live flights) | none | Free, community database; be gentle (we cache and use ≤ 2 req/s). Only facts (routes) are stored, in `library-verification.json`. |
| [adsb.lol](https://adsb.lol) `api.adsb.lol/v2/callsign/<cs>`, `globe.adsb.lol/data/traces/<xx>/trace_full_<hex>.json` | live positions and the full ADS-B trace of the aircraft (current UTC day) | none | **ODbL 1.0.** Fixtures carry `"Data © adsb.lol contributors, ODbL 1.0"`; keep that attribution wherever the data is shown/redistributed. Derived databases must stay under ODbL. |
| [OpenSky Network](https://opensky-network.org) `/api/flights/*`, `/api/tracks/all` | historical tracks | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` (free account → API client, OAuth2 client-credentials, token URL `auth.opensky-network.org/…/openid-connect/token`) | Research / non-commercial use, attribution required (Schäfer et al., IPSN 2014). Anonymous access cannot read history (HTTP 403). OpenSky fixtures are **gitignored** by default; publish only after checking the terms. |
| [FlightAware AeroAPI](https://www.flightaware.com/aeroapi/) `/flights/{ident}`, `/flights/{id}/track` | historical tracks (plan-dependent, usually ≤ 10 days) | `FLIGHTAWARE_API_KEY` | Commercial, per-query billing, **no redistribution**. FlightAware fixtures are **gitignored** (`tests/fixtures/.gitignore`). Altitude is in hundreds of feet (converted). |

A source without credentials is skipped with a message naming the missing variables; nothing else is affected.
Never commit keys: export them in your shell (or a local, untracked `.env` you `source`).

```sh
export OPENSKY_CLIENT_ID=…  OPENSKY_CLIENT_SECRET=…
export FLIGHTAWARE_API_KEY=…
```

### ICAO callsigns

ADS-B callsigns use the airline's ICAO prefix (EK226 → `UAE226`, QR8 → `QTR8`, TK79 → `THY79`, PK211 → `PIA211`).
`scripts/fixtures/lib/airlines.ts` maps every airline in the library (33) plus a few extras; airports are mapped to ICAO
through `src/data/airports.ts`. Add a line there when the library gains a new airline (`verify-library` warns about gaps).

## Fixture format

`tests/fixtures/tracks/<FLIGHT>_<YYYY-MM-DD>_<source>.json` (date = UTC date of the first point):

```json
{
  "meta": {
    "flightNumber": "EK1", "callsign": "UAE1", "from": "DXB", "to": "LHR",
    "date": "2026-10-12", "source": "adsblol",
    "attribution": "Data © adsb.lol contributors, ODbL 1.0", "license": "ODbL-1.0 (…)",
    "fetchedAt": "2026-10-12T11:30:00.000Z", "icao24": "8963f2",
    "complete": true, "notes": "aircraft A6-EOU (A388)"
  },
  "points": [ { "t": "2026-10-12T03:52:11.000Z", "lat": 25.2431, "lon": 55.3699, "altM": 60 }, … ]
}
```

* Thinned to **at most one point per minute** (first and last point always kept; sparse stretches are kept as is),
  lat/lon rounded to 4 decimals (~10 m), altitude (barometric, above sea level) to 10 m. A 7 h flight is ≈ 25 KB.
  One point per line keeps diffs readable.
* Ground points get the airport elevation, so the track starts and ends at field elevation.
* `complete: true` means: the first point is within 40 km of the origin airport, the last within 40 km of the
  destination and not airborne high above it, and no gap of more than 6 h inside the track. Anything else is
  `complete: false` and `notes` says why (`partial: …`). Coverage holes (typically oceans, as adsb.lol is
  ground-station based) are bridged on a great circle by the engine; the largest one is stored as `meta.maxGapMin`
  and mentioned in `notes`. Treat prayer events inside a multi-hour hole as interpolated, not observed.
* The flight number is the library's; `from`/`to` are the *flown* route (from adsbdb, and from the airports at the
  track's ends once the flight has landed), so `notes` records when they differ from the library.
* Saving never replaces a better file: complete beats partial, then the later last point wins.

### How `capture-live` cuts a flight out of a trace

adsb.lol's `trace_full_<hex>.json` (merged with the near-live `trace_recent_<hex>.json`, whose last fixes can be minutes
to hours newer than the full file) holds everything the aircraft did recently (tar1090 format:
`[dtSec, lat, lon, altFt|"ground", gs, track, flags, …]`, with a sparse `flight` callsign record). The trace is split
into airborne runs (plus one ground point either side): a run ends at any ground contact or at a gap > 30 min that is
not a plausible coverage hole (both ends airborne, implied speed 300–1100 km/h). The run whose callsign matches and
that is closest in time to the live sighting is the flight. `--watch` re-fetches after landing and merges what earlier
polls already had, so a flight that crosses the window start of the trace is not truncated. Subsequent polls only look
up the flights already being tracked (a full scan costs ~15 min because adsb.lol answers HTTP 429 above ~1 request
per 1.5 s from our shared IP), and every run first resumes the partial fixtures from the last 2 days, so a flight
captured in the air yesterday is completed by a later run once it has landed. When a flight has landed, `from`/`to`
are replaced by the airports at the ends of the track (a flight with an intermediate stop is cut at the stop,
so the fixture may be only one sector of the library entry).

## `tests/realTracks.test.ts`

For every fixture the test checks the file (well-formed, ≤ 1 point/min, known airports). Then:

* **Partial fixtures** (`complete: false`): the engine must run on the real track without producing NaN.
* **Complete fixtures**: two legs are built on the same route and times (departure = first point, arrival = last
  point): one with `track` = the fixture points (so aircraft position comes from reality), one without (great-circle
  + the climb/cruise/descent profile). Both go through `computeInflight(…, DEFAULT_SETTINGS)` and the test asserts:
  1. no NaN in any sample or event;
  2. the **sequence of prayer windows opened in the air** is identical. Events within 10 min of departure or arrival
     are ignored in both models (a boundary falling that close to take-off/landing may legitimately flip);
  3. each corresponding event is within **25 min** (override with `REAL_TRACK_TOL_MIN=40`, or per fixture in
     `tests/fixtures/tolerances.json` with a written reason);
  4. the real track never strays more than 7000 km from the great circle (sanity check against mislabelled files).
     **Only when the real route stays within 600 km of the great circle** are 2 and 3 asserted. If the airline really
     flew a different corridor (e.g. SQ21 EWR-SIN over Europe, up to 4700 km off the polar great circle) the model
     cannot be expected to agree, so the table is printed as information and nothing is asserted;
  5. the real-track events equal the stored snapshot `tests/fixtures/snapshots/<fixture>.events.txt`
     (UTC minute + position). Intentional engine changes: `npx vitest run tests/realTracks.test.ts -u`.

The test **prints** a table per fixture, e.g. `fajr real 02:41 gc 02:55 Δ -14.0 min`, plus the maximum and mean lateral
deviation of the real track from the great circle. Read a positive Δ as "the real aircraft reached this prayer later
than the model predicted". Typical sources of difference: great-circle vs. the real airway (up to a few hundred km), the
model's constant-speed cruise vs. the actual speed profile (wind, holding, ATC vectors) and the model's block time being
the fixture's real duration. A Δ close to the tolerance is not a bug by itself; it tells how accurate
the model is, and a *systematic* offset points at the profile model. A different window sequence is a real discrepancy
unless it is an edge case at take-off/landing.

Without complete fixtures the comparison tests are replaced by a single passing placeholder, so CI never fails just
because no data was captured. Fixture files are the test inputs: commit new `*_adsblol.json` files (ODbL, with
attribution) together with their snapshot.

## Fixtures captured so far (2026-10-12, adsb.lol)

| Fixture | Route | Status | Real vs great-circle model |
|---|---|---|---|
| `DL56_2026-10-11` | SLC→AMS | complete | within ±13 min (4 events), route 233 km max off GC |
| `JL5_2026-10-11` | JFK→HND (Alaska/Arctic) | complete | Dhuhr −70 min at 67N; others ≤ 14 min (tolerance overridden, see `tolerances.json`) |
| `SQ21_2026-10-11` | EWR→SIN (flown over Europe, 4700 km off the polar GC) | complete | informational only: the great-circle model passes through different windows altogether |
| 16 others (AA177, AA950, AI101, EK1, EK216, MS985, NZ6, NZ8, QR727, QR728, SQ22, SQ32, TK2, UA82, UA839, UA862) | various long-haul | partial (captured in flight) | NaN check only; re-run `capture-live.ts --flight …` after they land to complete them |

## Limitations

* adsb.lol only gives roughly the last day, so history must come from OpenSky or FlightAware, or from captures made
  while the flight is happening (`--watch`). Oceanic stretches have no ADS-B ground coverage: those flights are still
  marked `complete` when both ends are present (holes up to 6 h), with `meta.maxGapMin` recording the hole.
* A callsign is not a schedule: adsb.lol returns whatever aircraft is using the callsign now, which may be a different
  routing than the library entry (see the library verification below).
* Altitudes are barometric (pressure) altitude from ADS-B, not geometric.

<!-- LIBRARY-VERIFICATION:START -->
## Library verification

Every `FLIGHT_LIBRARY` entry was looked up on [adsbdb.com](https://www.adsbdb.com) by ICAO callsign (IATA number as fallback) on 2026-10-12, and the origin/destination was compared with the library. Raw data: `tests/fixtures/library-verification.json`. adsbdb is crowd-sourced and describes the route *currently* associated with a callsign, so a `mismatch` means "check this", not necessarily "wrong"; `not-found` usually means the flight is seasonal/retired or simply missing from adsbdb.

**215 match · 0 mismatch · 0 not found · 0 error** (of 215).

| Airline | ICAO | Flights | Match | Mismatch | Not found | Error |
|---|---|---:|---:|---:|---:|---:|
| AA | AAL | 6 | 6 | 0 | 0 | 0 |
| AF | AFR | 4 | 4 | 0 | 0 | 0 |
| AI | AIC | 6 | 6 | 0 | 0 | 0 |
| AT | RAM | 2 | 2 | 0 | 0 | 0 |
| AV | AVA | 2 | 2 | 0 | 0 | 0 |
| BA | BAW | 10 | 10 | 0 | 0 | 0 |
| BR | EVA | 4 | 4 | 0 | 0 | 0 |
| CX | CPA | 8 | 8 | 0 | 0 | 0 |
| DL | DAL | 6 | 6 | 0 | 0 | 0 |
| EK | UAE | 50 | 50 | 0 | 0 | 0 |
| ET | ETH | 3 | 3 | 0 | 0 | 0 |
| EY | ETD | 4 | 4 | 0 | 0 | 0 |
| FZ | FDB | 2 | 2 | 0 | 0 | 0 |
| IB | IBE | 2 | 2 | 0 | 0 | 0 |
| JL | JAL | 2 | 2 | 0 | 0 | 0 |
| KE | KAL | 6 | 6 | 0 | 0 | 0 |
| KL | KLM | 4 | 4 | 0 | 0 | 0 |
| LA | LAN | 6 | 6 | 0 | 0 | 0 |
| LH | DLH | 4 | 4 | 0 | 0 | 0 |
| MS | MSR | 2 | 2 | 0 | 0 | 0 |
| MU | CES | 2 | 2 | 0 | 0 | 0 |
| NH | ANA | 4 | 4 | 0 | 0 | 0 |
| NZ | ANZ | 4 | 4 | 0 | 0 | 0 |
| PK | PIA | 4 | 4 | 0 | 0 | 0 |
| PR | PAL | 2 | 2 | 0 | 0 | 0 |
| QF | QFA | 6 | 6 | 0 | 0 | 0 |
| QR | QTR | 23 | 23 | 0 | 0 | 0 |
| SA | SAA | 2 | 2 | 0 | 0 | 0 |
| SQ | SIA | 4 | 4 | 0 | 0 | 0 |
| SV | SVA | 4 | 4 | 0 | 0 | 0 |
| TK | THY | 11 | 11 | 0 | 0 | 0 |
| UA | UAL | 16 | 16 | 0 | 0 | 0 |

<details><summary>All 215 flights</summary>

| Flight | Library | adsbdb | Status |
|---|---|---|---|
| EK601 | KHI-DXB | KHI-DXB | match |
| EK603 | KHI-DXB | KHI-DXB | match |
| EK600 | DXB-KHI | DXB-KHI | match |
| EK602 | DXB-KHI | DXB-KHI | match |
| PK213 | KHI-DXB | KHI-DXB | match |
| PK214 | DXB-KHI | DXB-KHI | match |
| FZ330 | KHI-DXB | KHI-DXB | match |
| FZ331 | DXB-KHI | DXB-KHI | match |
| QR605 | KHI-DOH | KHI-DOH | match |
| QR604 | DOH-KHI | DOH-KHI | match |
| QR606 | DOH-KHI | DOH-KHI | match |
| TK719 | KHI-IST | KHI-IST | match |
| TK718 | IST-KHI | IST-KHI | match |
| SV701 | KHI-JED | KHI-JED | match |
| SV700 | JED-KHI | JED-KHI | match |
| PK731 | KHI-JED | KHI-JED | match |
| PK732 | JED-KHI | JED-KHI | match |
| SV707 | KHI-RUH | KHI-RUH | match |
| SV708 | RUH-KHI | RUH-KHI | match |
| EY299 | KHI-AUH | KHI-AUH | match |
| EY298 | AUH-KHI | AUH-KHI | match |
| EK622 | DXB-LHE | DXB-LHE | match |
| EK623 | LHE-DXB | LHE-DXB | match |
| QR628 | DOH-LHE | DOH-LHE | match |
| QR629 | LHE-DOH | LHE-DOH | match |
| EK614 | DXB-ISB | DXB-ISB | match |
| EK615 | ISB-DXB | ISB-DXB | match |
| QR632 | DOH-ISB | DOH-ISB | match |
| QR633 | ISB-DOH | ISB-DOH | match |
| TK710 | IST-ISB | IST-ISB | match |
| TK711 | ISB-IST | ISB-IST | match |
| EK512 | DXB-DEL | DXB-DEL | match |
| EK511 | DEL-DXB | DEL-DXB | match |
| EK500 | DXB-BOM | DXB-BOM | match |
| EK501 | BOM-DXB | BOM-DXB | match |
| EK568 | DXB-BLR | DXB-BLR | match |
| EK569 | BLR-DXB | BLR-DXB | match |
| QR570 | DOH-DEL | DOH-DEL | match |
| QR571 | DEL-DOH | DEL-DOH | match |
| AI101 | DEL-JFK | DEL-JFK | match |
| AI102 | JFK-DEL | JFK-DEL | match |
| AI173 | DEL-SFO | DEL-SFO | match |
| AI174 | SFO-DEL | SFO-DEL | match |
| AI176 | SFO-BLR | SFO-BLR | match |
| AI175 | BLR-SFO | BLR-SFO | match |
| UA82 | EWR-DEL | EWR-DEL | match |
| UA83 | DEL-EWR | DEL-EWR | match |
| UA868 | SFO-DEL | SFO-DEL | match |
| UA867 | DEL-SFO | DEL-SFO | match |
| EK202 | JFK-DXB | JFK-DXB | match |
| EK201 | DXB-JFK | DXB-JFK | match |
| EK204 | JFK-DXB | JFK-DXB | match |
| EK203 | DXB-JFK | DXB-JFK | match |
| EK223 | DXB-EWR | DXB-EWR | match |
| EK224 | EWR-DXB | EWR-DXB | match |
| EK231 | DXB-IAD | DXB-IAD | match |
| EK232 | IAD-DXB | IAD-DXB | match |
| EK225 | DXB-SFO | DXB-SFO | match |
| EK226 | SFO-DXB | SFO-DXB | match |
| EK215 | DXB-LAX | DXB-LAX | match |
| EK216 | LAX-DXB | LAX-DXB | match |
| EK229 | DXB-SEA | DXB-SEA | match |
| EK230 | SEA-DXB | SEA-DXB | match |
| EK237 | DXB-BOS | DXB-BOS | match |
| EK238 | BOS-DXB | BOS-DXB | match |
| QR701 | DOH-JFK | DOH-JFK | match |
| QR702 | JFK-DOH | JFK-DOH | match |
| QR707 | DOH-IAD | DOH-IAD | match |
| QR708 | IAD-DOH | IAD-DOH | match |
| QR737 | DOH-SFO | DOH-SFO | match |
| QR738 | SFO-DOH | SFO-DOH | match |
| QR739 | DOH-LAX | DOH-LAX | match |
| QR740 | LAX-DOH | LAX-DOH | match |
| QR727 | DOH-PHL | DOH-PHL | match |
| QR728 | PHL-DOH | PHL-DOH | match |
| QR729 | DOH-DFW | DOH-DFW | match |
| QR730 | DFW-DOH | DFW-DOH | match |
| EY101 | AUH-JFK | AUH-JFK | match |
| EY100 | JFK-AUH | JFK-AUH | match |
| TK1 | IST-JFK | IST-JFK | match |
| TK2 | JFK-IST | JFK-IST | match |
| TK79 | IST-SFO | IST-SFO | match |
| TK9 | IST-LAX | IST-LAX | match |
| TK10 | LAX-IST | LAX-IST | match |
| TK7 | IST-IAD | IST-IAD | match |
| TK8 | IAD-IST | IAD-IST | match |
| EK927 | DXB-CAI | DXB-CAI | match |
| EK928 | CAI-DXB | CAI-DXB | match |
| AT200 | CMN-JFK | CMN-JFK | match |
| AT201 | JFK-CMN | JFK-CMN | match |
| MS985 | CAI-JFK | CAI-JFK | match |
| MS986 | JFK-CAI | JFK-CAI | match |
| BA112 | JFK-LHR | JFK-LHR | match |
| BA117 | LHR-JFK | LHR-JFK | match |
| BA286 | SFO-LHR | SFO-LHR | match |
| BA285 | LHR-SFO | LHR-SFO | match |
| BA268 | LAX-LHR | LAX-LHR | match |
| BA269 | LHR-LAX | LHR-LAX | match |
| BA48 | SEA-LHR | SEA-LHR | match |
| BA49 | LHR-SEA | LHR-SEA | match |
| AF7 | JFK-CDG | JFK-CDG | match |
| AF8 | CDG-JFK | CDG-JFK | match |
| AF83 | SFO-CDG | SFO-CDG | match |
| AF84 | CDG-SFO | CDG-SFO | match |
| LH401 | JFK-FRA | JFK-FRA | match |
| LH400 | FRA-JFK | FRA-JFK | match |
| LH454 | FRA-SFO | FRA-SFO | match |
| LH455 | SFO-FRA | SFO-FRA | match |
| KL642 | JFK-AMS | JFK-AMS | match |
| KL641 | AMS-JFK | AMS-JFK | match |
| KL605 | AMS-SFO | AMS-SFO | match |
| KL606 | SFO-AMS | SFO-AMS | match |
| IB6250 | JFK-MAD | JFK-MAD | match |
| IB6251 | MAD-JFK | MAD-JFK | match |
| UA918 | IAD-LHR | IAD-LHR | match |
| UA919 | LHR-IAD | LHR-IAD | match |
| EK2 | LHR-DXB | LHR-DXB | match |
| EK1 | DXB-LHR | DXB-LHR | match |
| BA107 | LHR-DXB | LHR-DXB | match |
| BA106 | DXB-LHR | DXB-LHR | match |
| QR8 | LHR-DOH | LHR-DOH | match |
| QR7 | DOH-LHR | DOH-LHR | match |
| ET501 | IAD-ADD | IAD-ADD | match |
| ET600 | ADD-DXB | ADD-DXB | match |
| ET601 | DXB-ADD | DXB-ADD | match |
| DL156 | JFK-ACC | JFK-ACC | match |
| DL157 | ACC-JFK | ACC-JFK | match |
| DL54 | ATL-LOS | ATL-LOS | match |
| DL55 | LOS-ATL | LOS-ATL | match |
| EK783 | DXB-LOS | DXB-LOS | match |
| EK784 | LOS-DXB | LOS-DXB | match |
| DL200 | ATL-JNB | ATL-JNB | match |
| DL201 | JNB-ATL | JNB-ATL | match |
| SA204 | JFK-JNB | JFK-JNB | match |
| SA203 | JNB-JFK | JNB-JFK | match |
| EK761 | DXB-JNB | DXB-JNB | match |
| EK762 | JNB-DXB | JNB-DXB | match |
| EK772 | DXB-CPT | DXB-CPT | match |
| EK773 | CPT-DXB | CPT-DXB | match |
| AA951 | JFK-GRU | JFK-GRU | match |
| AA950 | GRU-JFK | GRU-JFK | match |
| AA953 | JFK-EZE | JFK-EZE | match |
| AA954 | EZE-JFK | EZE-JFK | match |
| LA533 | JFK-SCL | JFK-SCL | match |
| LA532 | SCL-JFK | SCL-JFK | match |
| AV21 | JFK-BOG | JFK-BOG | match |
| AV20 | BOG-JFK | BOG-JFK | match |
| LA2467 | JFK-LIM | JFK-LIM | match |
| LA2468 | LIM-JFK | LIM-JFK | match |
| LA535 | LAX-LIM | LAX-LIM | match |
| LA534 | LIM-LAX | LIM-LAX | match |
| EK261 | DXB-GRU | DXB-GRU | match |
| EK262 | GRU-DXB | GRU-DXB | match |
| QF12 | LAX-SYD | LAX-SYD | match |
| QF11 | SYD-LAX | SYD-LAX | match |
| QF94 | LAX-MEL | LAX-MEL | match |
| QF93 | MEL-LAX | MEL-LAX | match |
| UA863 | SFO-SYD | SFO-SYD | match |
| UA870 | SYD-SFO | SYD-SFO | match |
| QF16 | LAX-BNE | LAX-BNE | match |
| QF15 | BNE-LAX | BNE-LAX | match |
| EK414 | DXB-SYD | DXB-SYD | match |
| EK415 | SYD-DXB | SYD-DXB | match |
| EK408 | DXB-MEL | DXB-MEL | match |
| EK407 | MEL-DXB | MEL-DXB | match |
| EK430 | DXB-BNE | DXB-BNE | match |
| EK431 | BNE-DXB | BNE-DXB | match |
| NZ7 | SFO-AKL | SFO-AKL | match |
| NZ8 | AKL-SFO | AKL-SFO | match |
| NZ2 | LAX-AKL | LAX-AKL | match |
| NZ1 | AKL-LAX | AKL-LAX | match |
| SQ21 | EWR-SIN | EWR-SIN | match |
| SQ22 | SIN-EWR | SIN-EWR | match |
| CX841 | JFK-HKG | JFK-HKG | match |
| CX840 | HKG-JFK | HKG-JFK | match |
| CX899 | EWR-HKG | EWR-HKG | match |
| CX890 | HKG-EWR | HKG-EWR | match |
| SQ31 | SFO-SIN | SFO-SIN | match |
| SQ32 | SIN-SFO | SIN-SFO | match |
| PR104 | MNL-SFO | MNL-SFO | match |
| PR105 | SFO-MNL | SFO-MNL | match |
| EK344 | DXB-KUL | DXB-KUL | match |
| EK343 | KUL-DXB | KUL-DXB | match |
| CX873 | SFO-HKG | SFO-HKG | match |
| CX872 | HKG-SFO | HKG-SFO | match |
| CX881 | LAX-HKG | LAX-HKG | match |
| CX880 | HKG-LAX | HKG-LAX | match |
| JL5 | JFK-HND | JFK-HND | match |
| JL6 | HND-JFK | HND-JFK | match |
| NH109 | JFK-HND | JFK-HND | match |
| NH110 | HND-JFK | HND-JFK | match |
| UA875 | SFO-HND | SFO-HND | match |
| UA876 | HND-SFO | HND-SFO | match |
| UA837 | SFO-NRT | SFO-NRT | match |
| UA838 | NRT-SFO | NRT-SFO | match |
| NH105 | LAX-HND | LAX-HND | match |
| NH106 | HND-LAX | HND-LAX | match |
| UA79 | EWR-NRT | EWR-NRT | match |
| UA78 | NRT-EWR | NRT-EWR | match |
| KE82 | JFK-ICN | JFK-ICN | match |
| KE81 | ICN-JFK | ICN-JFK | match |
| KE12 | LAX-ICN | LAX-ICN | match |
| KE11 | ICN-LAX | ICN-LAX | match |
| KE24 | SFO-ICN | SFO-ICN | match |
| KE23 | ICN-SFO | ICN-SFO | match |
| BR11 | LAX-TPE | LAX-TPE | match |
| BR12 | TPE-LAX | TPE-LAX | match |
| BR7 | SFO-TPE | SFO-TPE | match |
| BR8 | TPE-SFO | TPE-SFO | match |
| MU578 | LAX-PVG | LAX-PVG | match |
| MU577 | PVG-LAX | PVG-LAX | match |
| AA1 | JFK-LAX | JFK-LAX | match |
| AA2 | LAX-JFK | LAX-JFK | match |
| UA19 | JFK-SFO | JFK-SFO | match |
| UA8 | SFO-JFK | SFO-JFK | match |

</details>
<!-- LIBRARY-VERIFICATION:END -->

### Library corrections (2026-10-12)

The first audit found 122 of the 223 library flights disagreeing with adsbdb (52 same city pair in the opposite
direction, 70 a different pair) and 3 not found; 98 matched. The library was corrected so that **every entry now
matches adsbdb (215 of 215)**, 14 of them additionally confirmed by a live adsb.lol track fixture. Evidence order:
live ADS-B track fixture, then adsbdb, then general knowledge; where the two direct sources agreed with the
caller's knowledge (e.g. BA117 = LHR→JFK, BA112 = JFK→LHR, QR7 = DOH→LHR, QR8 = LHR→DOH, LH400 = FRA→JFK,
JL5 = JFK→HND) the number moved to follow them. There are no `manual` overrides.

* **Swapped** (46 entries / 23 pairs: flight numbers exchanged between the two directions, schedule times stay with the
  route): EK201/202, EK203/204, EK511/512, AI175/176, UA82/83, MS985/986, BA112/117, BA268/269, BA48/49, LH400/401,
  LH454/455, IB6250/6251, QR7/8, LA532/533, CX840/841, SQ31/32, EK343/344, CX872/873, CX880/881, JL5/6, NH105/106,
  BR11/12, BR7/8.
* **Renumbered** to the adsbdb-confirmed number for the same route (flight numbers found with
  `scripts/fixtures/find-flights.ts`): PK211→PK213, PK212→PK214, QR608→QR606, TK708→TK719, TK709→TK718,
  SV706→SV701, SV705→SV700, PK741→PK731, PK742→PK732, SV718→SV707, SV717→SV708, EY201→EY299, EY200→EY298,
  UA863→UA868, UA862→UA867, EK211→EK223, EK212→EK224, QR735→QR737, QR736→QR738, QR721→QR729, QR722→QR730,
  EY11→EY101, EY12→EY100, TK33→TK7, TK34→TK8, BA283→BA286 (SFO→LHR), BA286→BA285 (LHR→SFO), UA901→UA918,
  UA900→UA919, ET500→ET501 (IAD→ADD), DL59→DL156, DL58→DL157, DL57→DL54, DL56→DL55, EK773→EK772 (DXB→CPT),
  EK774→EK773 (CPT→DXB), AA930→AA951, AA931→AA950, AA950→AA953, AA951→AA954, AV22→AV21, AV21→AV20,
  LA2465→LA2467, LA2466→LA2468, UA839→UA863 (SFO→SYD), UA840→UA870, EK412→EK414, EK413→EK415, EK247→EK261,
  EK248→EK262, NZ6→NZ7, NZ5→NZ8, PR102→PR104, PR103→PR105, NH10→NH109, NH9→NH110, MU587→MU578, MU588→MU577,
  UA837→UA875 (SFO→HND), UA838→UA876 (HND→SFO).
* **Replaced** by a confirmed flight on the same region / coast: QR727/728 DOH⇄SEA → DOH⇄PHL (live fixtures);
  AV15/16 LAX⇄BOG → LA535/534 LAX⇄LIM; UA100/101 SFO⇄BNE → QF16/15 LAX⇄BNE; UA1/2 EWR⇄SFO → UA19/8 JFK⇄SFO.
  **Added**: UA837/838 SFO⇄NRT (adsbdb), CX899/CX890 EWR⇄HKG (polar).
* **Removed** (no confirmed flight): KQ2/KQ3 JFK⇄NBO (not in adsbdb), ET501 ADD→IAD (no confirmed ADD→US), TK80 SFO→IST
  (adsbdb: IST-JNB), NZ8/NZ7 JFK⇄AKL, PR126/127 MNL⇄JFK, UA857/858 SFO⇄PVG, AA177/178 DFW⇄HKG.
* **Re-labelled / times from live tracks**: SQ21/SQ22 EWR⇄SIN are no longer `polar` (live ADS-B 2026-10-11: via Europe,
  max 54° N, and via Canada, max 63° N); JL5, SQ21, SQ22, MS985, EK216 and NZ8 got the departure/arrival times seen in
  their live fixtures. Genuinely high-latitude flights keep `polar`: CX840/841 JFK⇄HKG, CX899/890 EWR⇄HKG (great circle
  ≈ 84° N) and EK225/226 DXB⇄SFO (≈ 88° N); the tests require ≥ 78° N for the `polar` region. adsb.lol has no coverage
  at these latitudes, so the polar claim rests on the great circle, not on a track.
* **Not covered** (no confirmed nonstop flight; listed in `tests/flights.test.ts` as `COVERAGE_GAPS`/`ONE_WAY_PAIRS`):
  US West Coast ⇄ North / East / West / South Africa, US East Coast ⇄ Australia and ⇄ New Zealand, ADD → US,
  SFO → IST (only IST → SFO).

Each `FLIGHT_LIBRARY` entry carries `verification: { source: 'adsbdb' | 'adsb.lol' | 'manual', checkedAt, note? }`
(`manual` = documented override of adsbdb and requires a note); `tests/flights.test.ts` cross-checks it against
`library-verification.json` and the live fixtures. To find a flight number for a route:
`NODE_USE_ENV_PROXY=1 npx vite-node scripts/fixtures/find-flights.ts EK:DXB:EWR:221 --span 40 [--list]`.

