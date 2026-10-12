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

**98 match · 122 mismatch · 3 not found · 0 error** (of 223).

| Airline | ICAO | Flights | Match | Mismatch | Not found | Error |
|---|---|---:|---:|---:|---:|---:|
| AA | AAL | 8 | 2 | 6 | 0 | 0 |
| AF | AFR | 4 | 4 | 0 | 0 | 0 |
| AI | AIC | 6 | 4 | 2 | 0 | 0 |
| AT | RAM | 2 | 2 | 0 | 0 | 0 |
| AV | AVA | 4 | 0 | 4 | 0 | 0 |
| BA | BAW | 10 | 2 | 8 | 0 | 0 |
| BR | EVA | 4 | 0 | 4 | 0 | 0 |
| CX | CPA | 6 | 0 | 6 | 0 | 0 |
| DL | DAL | 6 | 2 | 4 | 0 | 0 |
| EK | UAE | 50 | 34 | 15 | 1 | 0 |
| ET | ETH | 4 | 2 | 2 | 0 | 0 |
| EY | ETD | 4 | 0 | 4 | 0 | 0 |
| FZ | FDB | 2 | 2 | 0 | 0 | 0 |
| IB | IBE | 2 | 0 | 2 | 0 | 0 |
| JL | JAL | 2 | 0 | 2 | 0 | 0 |
| KE | KAL | 6 | 6 | 0 | 0 | 0 |
| KL | KLM | 4 | 4 | 0 | 0 | 0 |
| KQ | KQA | 2 | 0 | 0 | 2 | 0 |
| LA | LAN | 4 | 0 | 4 | 0 | 0 |
| LH | DLH | 4 | 0 | 4 | 0 | 0 |
| MS | MSR | 2 | 0 | 2 | 0 | 0 |
| MU | CES | 2 | 0 | 2 | 0 | 0 |
| NH | ANA | 4 | 0 | 4 | 0 | 0 |
| NZ | ANZ | 6 | 2 | 4 | 0 | 0 |
| PK | PIA | 4 | 0 | 4 | 0 | 0 |
| PR | PAL | 4 | 1 | 3 | 0 | 0 |
| QF | QFA | 4 | 4 | 0 | 0 | 0 |
| QR | QTR | 23 | 14 | 9 | 0 | 0 |
| SA | SAA | 2 | 2 | 0 | 0 | 0 |
| SQ | SIA | 4 | 2 | 2 | 0 | 0 |
| SV | SVA | 4 | 0 | 4 | 0 | 0 |
| TK | THY | 12 | 7 | 5 | 0 | 0 |
| UA | UAL | 18 | 2 | 16 | 0 | 0 |

### Mismatches

52 are the same city pair in the opposite direction (the library numbers the two directions the other way round, or adsbdb has it inverted), 70 are a different pair (seasonal re-routing, retimed / renumbered flight, or a wrong adsbdb entry). Verify against an airline timetable before changing the library.

| Flight | Library | adsbdb | Kind |
|---|---|---|---|
| PK211 | KHI-DXB | ISB-DXB | different |
| PK212 | DXB-KHI | DXB-ISB | different |
| QR608 | DOH-KHI | DOH-LHE | different |
| TK708 | KHI-IST | IST-DAC | different |
| TK709 | IST-KHI | DAC-KHI | different |
| SV706 | KHI-JED | SUB-DPS | different |
| SV705 | JED-KHI | KHI-JED | reversed |
| PK741 | KHI-JED | ISB-JED | different |
| PK742 | JED-KHI | JED-ISB | different |
| SV718 | KHI-RUH | JED-LHE | different |
| SV717 | RUH-KHI | KHI-RUH | reversed |
| EY201 | KHI-AUH | BOM-AUH | different |
| EY200 | AUH-KHI | AUH-BOM | different |
| EK511 | DXB-DEL | DEL-DXB | reversed |
| EK512 | DEL-DXB | DXB-DEL | reversed |
| AI175 | SFO-BLR | BLR-SFO | reversed |
| AI176 | BLR-SFO | SFO-BLR | reversed |
| UA83 | EWR-DEL | DEL-EWR | reversed |
| UA82 | DEL-EWR | EWR-DEL | reversed |
| UA863 | SFO-DEL | SFO-SYD | different |
| UA862 | DEL-SFO | HKG-SFO | different |
| EK201 | JFK-DXB | DXB-JFK | reversed |
| EK202 | DXB-JFK | JFK-DXB | reversed |
| EK203 | JFK-DXB | DXB-JFK | reversed |
| EK204 | DXB-JFK | JFK-DXB | reversed |
| EK211 | DXB-EWR | DXB-IAH | different |
| EK212 | EWR-DXB | IAH-DXB | different |
| QR735 | DOH-SFO | GVA-LHR | different |
| QR736 | SFO-DOH | LHR-GVA | different |
| QR727 | DOH-SEA | DOH-PHL | different |
| QR728 | SEA-DOH | PHL-DOH | different |
| QR721 | DOH-DFW | DOH-ORD | different |
| QR722 | DFW-DOH | ORD-DOH | different |
| EY11 | AUH-JFK | AUH-LHR | different |
| EY12 | JFK-AUH | LHR-AUH | different |
| TK80 | SFO-IST | IST-JNB | different |
| TK33 | IST-IAD | IST-IAH | different |
| TK34 | IAD-IST | IAH-IST | different |
| MS986 | CAI-JFK | JFK-CAI | reversed |
| MS985 | JFK-CAI | CAI-JFK | reversed |
| BA117 | JFK-LHR | LHR-JFK | reversed |
| BA112 | LHR-JFK | JFK-LHR | reversed |
| BA283 | SFO-LHR | LHR-LAX | different |
| BA286 | LHR-SFO | SFO-LHR | reversed |
| BA269 | LAX-LHR | LHR-LAX | reversed |
| BA268 | LHR-LAX | LAX-LHR | reversed |
| BA49 | SEA-LHR | LHR-SEA | reversed |
| BA48 | LHR-SEA | SEA-LHR | reversed |
| LH400 | JFK-FRA | FRA-JFK | reversed |
| LH401 | FRA-JFK | JFK-FRA | reversed |
| LH455 | FRA-SFO | SFO-FRA | reversed |
| LH454 | SFO-FRA | FRA-SFO | reversed |
| IB6251 | JFK-MAD | MAD-JFK | reversed |
| IB6250 | MAD-JFK | JFK-MAD | reversed |
| UA901 | IAD-LHR | SFO-LHR | different |
| UA900 | LHR-IAD | LHR-SFO | different |
| QR7 | LHR-DOH | DOH-LHR | reversed |
| QR8 | DOH-LHR | LHR-DOH | reversed |
| ET500 | IAD-ADD | DUB-IAD | different |
| ET501 | ADD-IAD | IAD-ADD | reversed |
| DL59 | JFK-ACC | LHR-BOS | different |
| DL58 | ACC-JFK | BOS-LHR | different |
| DL57 | ATL-LOS | BOM-DTW | different |
| DL56 | LOS-ATL | SLC-AMS | different |
| EK773 | DXB-CPT | CPT-DXB | reversed |
| AA930 | JFK-GRU | GRU-MIA | different |
| AA931 | GRU-JFK | MIA-EZE | different |
| AA950 | JFK-EZE | GRU-JFK | different |
| AA951 | EZE-JFK | JFK-GRU | different |
| LA532 | JFK-SCL | SCL-JFK | reversed |
| LA533 | SCL-JFK | JFK-SCL | reversed |
| AV22 | JFK-BOG | BOG-MEX | different |
| AV21 | BOG-JFK | JFK-BOG | reversed |
| LA2465 | JFK-LIM | LIM-AEP | different |
| LA2466 | LIM-JFK | EZE-LIM | different |
| AV15 | LAX-BOG | MAD-BOG | different |
| AV16 | BOG-LAX | BOG-MAD | different |
| EK247 | DXB-GRU | GIG-EZE | different |
| EK248 | GRU-DXB | GIG-DXB | different |
| UA839 | SFO-SYD | LAX-SYD | different |
| UA840 | SYD-SFO | MEL-LAX | different |
| UA100 | SFO-BNE | SYD-IAH | different |
| UA101 | BNE-SFO | IAH-SYD | different |
| EK412 | DXB-SYD | SYD-CHC | different |
| EK413 | SYD-DXB | CHC-SYD | different |
| NZ6 | SFO-AKL | AKL-LAX | different |
| NZ5 | AKL-SFO | LAX-AKL | different |
| NZ8 | JFK-AKL | AKL-SFO | different |
| NZ7 | AKL-JFK | SFO-AKL | different |
| CX840 | JFK-HKG | HKG-JFK | reversed |
| CX841 | HKG-JFK | JFK-HKG | reversed |
| AA177 | DFW-HKG | JFK-SFO | different |
| AA178 | HKG-DFW | DCA-BOS | different |
| SQ32 | SFO-SIN | SIN-SFO | reversed |
| SQ31 | SIN-SFO | SFO-SIN | reversed |
| PR102 | MNL-SFO | MNL-LAX | different |
| PR103 | SFO-MNL | LAX-MNL | different |
| PR127 | JFK-MNL | JFK-YVR | different |
| EK343 | DXB-KUL | KUL-DXB | reversed |
| EK344 | KUL-DXB | DXB-KUL | reversed |
| CX872 | SFO-HKG | HKG-SFO | reversed |
| CX873 | HKG-SFO | SFO-HKG | reversed |
| CX880 | LAX-HKG | HKG-LAX | reversed |
| CX881 | HKG-LAX | LAX-HKG | reversed |
| JL6 | JFK-HND | HND-JFK | reversed |
| JL5 | HND-JFK | JFK-HND | reversed |
| NH10 | JFK-HND | NRT-JFK | different |
| NH9 | HND-JFK | JFK-NRT | different |
| UA837 | SFO-HND | SFO-NRT | different |
| UA838 | HND-SFO | NRT-SFO | different |
| NH106 | LAX-HND | HND-LAX | reversed |
| NH105 | HND-LAX | LAX-HND | reversed |
| BR12 | LAX-TPE | TPE-LAX | reversed |
| BR11 | TPE-LAX | LAX-TPE | reversed |
| BR8 | SFO-TPE | TPE-SFO | reversed |
| BR7 | TPE-SFO | SFO-TPE | reversed |
| MU587 | LAX-PVG | PVG-JFK | different |
| MU588 | PVG-LAX | JFK-PVG | different |
| UA857 | SFO-PVG | ICN-PVG | different |
| UA858 | PVG-SFO | ICN-SFO | different |
| UA1 | EWR-SFO | SFO-SIN | different |
| UA2 | SFO-EWR | SIN-SFO | different |

<details><summary>Not found / error (3)</summary>

| Flight | Library route | Status |
|---|---|---|
| KQ2 | JFK-NBO | not-found |
| KQ3 | NBO-JFK | not-found |
| EK774 | CPT-DXB | not-found |

</details>

<details><summary>All 223 flights</summary>

| Flight | Library | adsbdb | Status |
|---|---|---|---|
| EK601 | KHI-DXB | KHI-DXB | match |
| EK603 | KHI-DXB | KHI-DXB | match |
| EK600 | DXB-KHI | DXB-KHI | match |
| EK602 | DXB-KHI | DXB-KHI | match |
| PK211 | KHI-DXB | ISB-DXB | mismatch |
| PK212 | DXB-KHI | DXB-ISB | mismatch |
| FZ330 | KHI-DXB | KHI-DXB | match |
| FZ331 | DXB-KHI | DXB-KHI | match |
| QR605 | KHI-DOH | KHI-DOH | match |
| QR604 | DOH-KHI | DOH-KHI | match |
| QR608 | DOH-KHI | DOH-LHE | mismatch |
| TK708 | KHI-IST | IST-DAC | mismatch |
| TK709 | IST-KHI | DAC-KHI | mismatch |
| SV706 | KHI-JED | SUB-DPS | mismatch |
| SV705 | JED-KHI | KHI-JED | mismatch |
| PK741 | KHI-JED | ISB-JED | mismatch |
| PK742 | JED-KHI | JED-ISB | mismatch |
| SV718 | KHI-RUH | JED-LHE | mismatch |
| SV717 | RUH-KHI | KHI-RUH | mismatch |
| EY201 | KHI-AUH | BOM-AUH | mismatch |
| EY200 | AUH-KHI | AUH-BOM | mismatch |
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
| EK511 | DXB-DEL | DEL-DXB | mismatch |
| EK512 | DEL-DXB | DXB-DEL | mismatch |
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
| AI175 | SFO-BLR | BLR-SFO | mismatch |
| AI176 | BLR-SFO | SFO-BLR | mismatch |
| UA83 | EWR-DEL | DEL-EWR | mismatch |
| UA82 | DEL-EWR | EWR-DEL | mismatch |
| UA863 | SFO-DEL | SFO-SYD | mismatch |
| UA862 | DEL-SFO | HKG-SFO | mismatch |
| EK201 | JFK-DXB | DXB-JFK | mismatch |
| EK202 | DXB-JFK | JFK-DXB | mismatch |
| EK203 | JFK-DXB | DXB-JFK | mismatch |
| EK204 | DXB-JFK | JFK-DXB | mismatch |
| EK211 | DXB-EWR | DXB-IAH | mismatch |
| EK212 | EWR-DXB | IAH-DXB | mismatch |
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
| QR735 | DOH-SFO | GVA-LHR | mismatch |
| QR736 | SFO-DOH | LHR-GVA | mismatch |
| QR739 | DOH-LAX | DOH-LAX | match |
| QR740 | LAX-DOH | LAX-DOH | match |
| QR727 | DOH-SEA | DOH-PHL | mismatch |
| QR728 | SEA-DOH | PHL-DOH | mismatch |
| QR721 | DOH-DFW | DOH-ORD | mismatch |
| QR722 | DFW-DOH | ORD-DOH | mismatch |
| EY11 | AUH-JFK | AUH-LHR | mismatch |
| EY12 | JFK-AUH | LHR-AUH | mismatch |
| TK1 | IST-JFK | IST-JFK | match |
| TK2 | JFK-IST | JFK-IST | match |
| TK79 | IST-SFO | IST-SFO | match |
| TK80 | SFO-IST | IST-JNB | mismatch |
| TK9 | IST-LAX | IST-LAX | match |
| TK10 | LAX-IST | LAX-IST | match |
| TK33 | IST-IAD | IST-IAH | mismatch |
| TK34 | IAD-IST | IAH-IST | mismatch |
| EK927 | DXB-CAI | DXB-CAI | match |
| EK928 | CAI-DXB | CAI-DXB | match |
| AT200 | CMN-JFK | CMN-JFK | match |
| AT201 | JFK-CMN | JFK-CMN | match |
| MS986 | CAI-JFK | JFK-CAI | mismatch |
| MS985 | JFK-CAI | CAI-JFK | mismatch |
| BA117 | JFK-LHR | LHR-JFK | mismatch |
| BA112 | LHR-JFK | JFK-LHR | mismatch |
| BA283 | SFO-LHR | LHR-LAX | mismatch |
| BA286 | LHR-SFO | SFO-LHR | mismatch |
| BA269 | LAX-LHR | LHR-LAX | mismatch |
| BA268 | LHR-LAX | LAX-LHR | mismatch |
| BA49 | SEA-LHR | LHR-SEA | mismatch |
| BA48 | LHR-SEA | SEA-LHR | mismatch |
| AF7 | JFK-CDG | JFK-CDG | match |
| AF8 | CDG-JFK | CDG-JFK | match |
| AF83 | SFO-CDG | SFO-CDG | match |
| AF84 | CDG-SFO | CDG-SFO | match |
| LH400 | JFK-FRA | FRA-JFK | mismatch |
| LH401 | FRA-JFK | JFK-FRA | mismatch |
| LH455 | FRA-SFO | SFO-FRA | mismatch |
| LH454 | SFO-FRA | FRA-SFO | mismatch |
| KL642 | JFK-AMS | JFK-AMS | match |
| KL641 | AMS-JFK | AMS-JFK | match |
| KL605 | AMS-SFO | AMS-SFO | match |
| KL606 | SFO-AMS | SFO-AMS | match |
| IB6251 | JFK-MAD | MAD-JFK | mismatch |
| IB6250 | MAD-JFK | JFK-MAD | mismatch |
| UA901 | IAD-LHR | SFO-LHR | mismatch |
| UA900 | LHR-IAD | LHR-SFO | mismatch |
| EK2 | LHR-DXB | LHR-DXB | match |
| EK1 | DXB-LHR | DXB-LHR | match |
| BA107 | LHR-DXB | LHR-DXB | match |
| BA106 | DXB-LHR | DXB-LHR | match |
| QR7 | LHR-DOH | DOH-LHR | mismatch |
| QR8 | DOH-LHR | LHR-DOH | mismatch |
| KQ2 | JFK-NBO |  | not-found |
| KQ3 | NBO-JFK |  | not-found |
| ET500 | IAD-ADD | DUB-IAD | mismatch |
| ET501 | ADD-IAD | IAD-ADD | mismatch |
| ET600 | ADD-DXB | ADD-DXB | match |
| ET601 | DXB-ADD | DXB-ADD | match |
| DL59 | JFK-ACC | LHR-BOS | mismatch |
| DL58 | ACC-JFK | BOS-LHR | mismatch |
| DL57 | ATL-LOS | BOM-DTW | mismatch |
| DL56 | LOS-ATL | SLC-AMS | mismatch |
| EK783 | DXB-LOS | DXB-LOS | match |
| EK784 | LOS-DXB | LOS-DXB | match |
| DL200 | ATL-JNB | ATL-JNB | match |
| DL201 | JNB-ATL | JNB-ATL | match |
| SA204 | JFK-JNB | JFK-JNB | match |
| SA203 | JNB-JFK | JNB-JFK | match |
| EK761 | DXB-JNB | DXB-JNB | match |
| EK762 | JNB-DXB | JNB-DXB | match |
| EK773 | DXB-CPT | CPT-DXB | mismatch |
| EK774 | CPT-DXB |  | not-found |
| AA930 | JFK-GRU | GRU-MIA | mismatch |
| AA931 | GRU-JFK | MIA-EZE | mismatch |
| AA950 | JFK-EZE | GRU-JFK | mismatch |
| AA951 | EZE-JFK | JFK-GRU | mismatch |
| LA532 | JFK-SCL | SCL-JFK | mismatch |
| LA533 | SCL-JFK | JFK-SCL | mismatch |
| AV22 | JFK-BOG | BOG-MEX | mismatch |
| AV21 | BOG-JFK | JFK-BOG | mismatch |
| LA2465 | JFK-LIM | LIM-AEP | mismatch |
| LA2466 | LIM-JFK | EZE-LIM | mismatch |
| AV15 | LAX-BOG | MAD-BOG | mismatch |
| AV16 | BOG-LAX | BOG-MAD | mismatch |
| EK247 | DXB-GRU | GIG-EZE | mismatch |
| EK248 | GRU-DXB | GIG-DXB | mismatch |
| QF12 | LAX-SYD | LAX-SYD | match |
| QF11 | SYD-LAX | SYD-LAX | match |
| QF94 | LAX-MEL | LAX-MEL | match |
| QF93 | MEL-LAX | MEL-LAX | match |
| UA839 | SFO-SYD | LAX-SYD | mismatch |
| UA840 | SYD-SFO | MEL-LAX | mismatch |
| UA100 | SFO-BNE | SYD-IAH | mismatch |
| UA101 | BNE-SFO | IAH-SYD | mismatch |
| EK412 | DXB-SYD | SYD-CHC | mismatch |
| EK413 | SYD-DXB | CHC-SYD | mismatch |
| EK408 | DXB-MEL | DXB-MEL | match |
| EK407 | MEL-DXB | MEL-DXB | match |
| EK430 | DXB-BNE | DXB-BNE | match |
| EK431 | BNE-DXB | BNE-DXB | match |
| NZ6 | SFO-AKL | AKL-LAX | mismatch |
| NZ5 | AKL-SFO | LAX-AKL | mismatch |
| NZ2 | LAX-AKL | LAX-AKL | match |
| NZ1 | AKL-LAX | AKL-LAX | match |
| NZ8 | JFK-AKL | AKL-SFO | mismatch |
| NZ7 | AKL-JFK | SFO-AKL | mismatch |
| SQ21 | EWR-SIN | EWR-SIN | match |
| SQ22 | SIN-EWR | SIN-EWR | match |
| CX840 | JFK-HKG | HKG-JFK | mismatch |
| CX841 | HKG-JFK | JFK-HKG | mismatch |
| AA177 | DFW-HKG | JFK-SFO | mismatch |
| AA178 | HKG-DFW | DCA-BOS | mismatch |
| SQ32 | SFO-SIN | SIN-SFO | mismatch |
| SQ31 | SIN-SFO | SFO-SIN | mismatch |
| PR102 | MNL-SFO | MNL-LAX | mismatch |
| PR103 | SFO-MNL | LAX-MNL | mismatch |
| PR126 | MNL-JFK | MNL-JFK | match |
| PR127 | JFK-MNL | JFK-YVR | mismatch |
| EK343 | DXB-KUL | KUL-DXB | mismatch |
| EK344 | KUL-DXB | DXB-KUL | mismatch |
| CX872 | SFO-HKG | HKG-SFO | mismatch |
| CX873 | HKG-SFO | SFO-HKG | mismatch |
| CX880 | LAX-HKG | HKG-LAX | mismatch |
| CX881 | HKG-LAX | LAX-HKG | mismatch |
| JL6 | JFK-HND | HND-JFK | mismatch |
| JL5 | HND-JFK | JFK-HND | mismatch |
| NH10 | JFK-HND | NRT-JFK | mismatch |
| NH9 | HND-JFK | JFK-NRT | mismatch |
| UA837 | SFO-HND | SFO-NRT | mismatch |
| UA838 | HND-SFO | NRT-SFO | mismatch |
| NH106 | LAX-HND | HND-LAX | mismatch |
| NH105 | HND-LAX | LAX-HND | mismatch |
| UA79 | EWR-NRT | EWR-NRT | match |
| UA78 | NRT-EWR | NRT-EWR | match |
| KE82 | JFK-ICN | JFK-ICN | match |
| KE81 | ICN-JFK | ICN-JFK | match |
| KE12 | LAX-ICN | LAX-ICN | match |
| KE11 | ICN-LAX | ICN-LAX | match |
| KE24 | SFO-ICN | SFO-ICN | match |
| KE23 | ICN-SFO | ICN-SFO | match |
| BR12 | LAX-TPE | TPE-LAX | mismatch |
| BR11 | TPE-LAX | LAX-TPE | mismatch |
| BR8 | SFO-TPE | TPE-SFO | mismatch |
| BR7 | TPE-SFO | SFO-TPE | mismatch |
| MU587 | LAX-PVG | PVG-JFK | mismatch |
| MU588 | PVG-LAX | JFK-PVG | mismatch |
| UA857 | SFO-PVG | ICN-PVG | mismatch |
| UA858 | PVG-SFO | ICN-SFO | mismatch |
| AA1 | JFK-LAX | JFK-LAX | match |
| AA2 | LAX-JFK | LAX-JFK | match |
| UA1 | EWR-SFO | SFO-SIN | mismatch |
| UA2 | SFO-EWR | SIN-SFO | mismatch |

</details>
<!-- LIBRARY-VERIFICATION:END -->
