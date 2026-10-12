# How in-flight prayer times are calculated

This document explains the method for users and for scholars who want to check it. The code lives in
`src/prayer/inflight.ts` (the engine), `src/prayer/static.ts` (prayer times for one fixed place) and
`src/astro/solar.ts` (the Sun). Everything runs in your browser; nothing is sent anywhere.

> **Short version.** We move an imaginary observer along your flight path minute by minute. At every minute we ask
> the ordinary question "which prayer window is it *here, now*?" using the prayer times of the exact spot below the
> aircraft. When the answer changes between two minutes, we narrow the change down to the second.

## 1. The five steps

1. **Where is the aircraft?** From the departure/arrival airports and times we build a route (great circle, or your
   waypoints, or an imported real track) and a flight profile (taxi, climb, cruise at about 11 000 m, descent, taxi).
   This gives, for any instant, latitude, longitude, altitude and heading (`Journey.stateAt(t)`). Layovers keep the
   aircraft at the airport.
2. **Sample.** From departure to arrival (always including the exact arrival instant) we sample every
   `stepMinutes` (default 1 minute). For a 17 h flight that is about 1 020 samples.
3. **Prayer times for the place below the aircraft.** For each sample we compute the full set of prayer times for that
   latitude, longitude and altitude on the *local solar date* there, and find which window the instant falls into
   (`windowAt`). The windows are named after the event that opens them:
   Fajr → Sunrise → Dhuhr → Asr → Maghrib → Isha → (Fajr …). "Sunrise" is the stretch between sunrise and Dhuhr; it
   has no obligatory prayer but is kept so that the timeline is complete.
4. **Bisect.** When two consecutive samples are in different windows, we cut the interval in half repeatedly,
   re-evaluating the window at the *exact* aircraft position at each midpoint, until the bracket is no longer than
   `refineSeconds` (default 1 s). The event time is the first instant at which the new window is seen. If the
   aircraft was at 66.1° N 41.2° W at that instant, the event says so.
5. **Flag oddities.** Things a fixed-place calculator never meets (a window that re-opens, one that never opens, a
   sun that does not set) are reported as anomalies with a plain-language message (section 6).

The sampled function `f(t) = window(t, position(t))` is piecewise constant. Bisection finds one boundary inside an
interval; when the two ends differ by more than one step in the daily cycle (for example Asr to Isha) we first
subdivide the interval into eight parts, recursively, so that a short window lying between them is not lost
(section 7).

## 2. Prayer times at a fixed place

Every prayer is "the Sun reaches a certain altitude `a`". From spherical astronomy the hour angle `H` at which that
happens satisfies

```
cos H = (sin a − sin φ · sin δ) / (cos φ · cos δ)
```

with φ the latitude and δ the Sun's declination. The time is solar noon minus or plus `H/15` hours. Declination and
the equation of time change during the day, so each crossing is iterated four times (each pass re-evaluates the Sun
at the estimated time). The Sun's position uses the NOAA/Meeus low-precision series (about 0.01° in declination).

| Event | Sun altitude `a` |
|---|---|
| Sunrise / Maghrib (sunset) | −(0.833° + dip) |
| Fajr | −(Fajr angle) (− dip if enabled for twilight) |
| Isha | −(Isha angle), or Maghrib + fixed minutes (Umm al-Qura, Gulf, Qatar) |
| Maghrib (Ja'fari, Tehran) | −4° / −4.5° (Sun angle instead of sunset) |
| Asr | `atan(1 / (k + tan |φ − δ|))`, with shadow factor k = 1 (Shafi'i, Maliki, Hanbali, Ja'fari) or 2 (Hanafi) |
| Dhuhr | solar transit (apparent noon) |

0.833° is the usual allowance for atmospheric refraction (34′) plus the Sun's apparent radius (16′). Per-prayer
offsets (ihtiyat) in minutes are added at the end.

The "local solar date" is the UTC date of `t + longitude/15 hours`, so that each place uses the day whose noon is
nearest. To decide the window we compute the events of the previous, current and next solar day, sort them in time
and take the last event at or before `t`.

## 3. Horizon dip for an aircraft

From the ground the Sun sets when its upper limb touches the horizon. From 11 km the horizon is *lower* than the
astronomical horizon by the dip angle

```
dip (degrees) = 0.0347 · √h        (h in metres; ≈ 3.6° at 11 000 m, standard refraction)
```

so the Sun is still visible after it has "set" for people below, and rises earlier. With the dip enabled
(default), sunrise and Maghrib use the altitude −(0.833° + dip). In the air this moves Maghrib later (by roughly
15–25 minutes between the equator and 55° latitude) and sunrise earlier by the same amount. The dip is derived from the real aircraft
altitude at each sample; `h` is clamped at zero so a negative elevation never produces NaN.

**Twilight dip (off by default).** Whether the angles for Fajr and Isha should also be measured from the lowered
horizon is a matter of opinion: twilight is a property of the sky glow, not of where the visible horizon is. The
setting `dipForTwilight` applies the dip to those angles too; it is off unless you turn it on. Many scholars
advise using the ground-level Fajr and Isha; the dip for sunrise and sunset corresponds to what is actually seen
from the window.

## 4. Madhab and method differences

* **Asr.** Hanafi: shadow of an object equals *twice* its length plus the noon shadow. Shafi'i, Maliki, Hanbali
  and Ja'fari: *once*. In the default Hanafi setting Asr starts about 50–55 minutes later than Shafi'i Asr between the equator and 50° latitude around the equinox. The engine is
  setting-agnostic: change the madhab and everything is recomputed.
* **Fajr and Isha.** Methods differ in the twilight angle (Karachi 18°/18°, MWL 18°/17°, ISNA 15°/15°, Egypt
  19.5°/17.5°, Tehran 17.7°/14°, Ja'fari/Leva 16°/14° …). You may enter any angle from 0° to 30°.
* **Isha: white or red twilight (shafaq abyad / shafaq ahmar).** Hanafi (Imam Abu Hanifa's position) starts Isha
  when the *white* twilight disappears; the majority starts it with the disappearance of the *red* glow, which is
  earlier. The engine does not model the colour of twilight; it uses angles: Karachi 18° is the usual Hanafi reading of the
  white twilight, and the default profile uses ≈12° for the red twilight only where 18° never occurs (see Profiles).
* **Isha by interval.** Umm al-Qura, Gulf and Qatar set Isha a fixed number of minutes after Maghrib (90 min).
  This is reported as `note: 'interval'`.
* **Ja'fari.** Maghrib is when the redness in the eastern sky disappears, approximated by a Sun angle of 4°
  (Leva) or 4.5° (Tehran) below the horizon instead of sunset. The Ja'fari/Tehran presets also compute Islamic
  midnight as the midpoint between sunset and Fajr (instead of sunset to sunrise).
* **Midnight.** The end of the preferred time for Isha. The engine reports it in the static times; the in-flight
  windows themselves end at Fajr.
* **Travel concessions.** Shortening (qasr) and combining (jam') depend on the madhab and are *not* applied to the
  windows; the summary only displays the plain windows. See `MADHAB_INFO` for notes.

### Profiles

The app ships two named bundles of settings (`PROFILES` in `src/prayer/methods.ts`, applied with `applyProfile`).
Both are Hanafi with the Karachi 18°/18° angles and the Hanafi Asr; they differ in what happens where 18° twilight
does not occur. **`DEFAULT_SETTINGS` is the Barelvi profile.** The `profile` field of the settings is informational
(for the UI); every other setting can still be changed individually.

| | **Barelvi (Ahl-e-Sunnat), default** | **Deobandi** |
|---|---|---|
| Madhab, method | Hanafi, Karachi 18°/18° | Hanafi, Karachi 18°/18° |
| Maghrib | sunset **+ 3 minutes** (ihtiyat, as in the Dawat-e-Islami timetables) | sunset |
| Where Isha's 18° is not reached | **Isha at the red twilight (≈12°)**, prayed as *ada* | Isha borrowed from the nearest location where 18° is reached |
| Where Fajr's 18° is not reached | Fajr borrowed from the nearest location where 18° is reached (`fajrFallback: 'nearestLocation'`) | same |
| Polar day / night | nearest location with a normal day | nearest location with a normal day |
| High-latitude rule | `redTwilight`, `redTwilightAngle: 12` | `nearestLatitude` |

*Fiqh basis (Barelvi).* In the Hanafi school Imam Abu Hanifa places the start of Isha at the disappearance of the
white twilight (shafaq abyad, ≈18°); his two students, Abu Yusuf and Muhammad (the *Sahibayn*), at the disappearance of the red twilight
(shafaq ahmar, ≈12° on the usual reckoning). Where the white twilight never disappears (summer nights at high
latitudes) Isha is not waived: out of necessity the ruling of the Sahibayn is followed, Isha is prayed after the red twilight as *ada*,
and the Imam's 18° applies again as soon as it occurs. This is the position of the Darul Ifta Ahlesunnat (Dawat-e-Islami)
fatwa FAM-1200 (Mufti Muhammad Qasim Attari, 16 May 2026). Dawat-e-Islami's London timetable back-solves to Fajr 18.2°, Isha (Hanafi) 18.0° and
Maghrib about 3 minutes after sunset, which the profile reproduces. Fajr has no shallower twilight to fall back on in
this fatwa, so the engine borrows the 18° Fajr of the nearest place where it occurs (optionally `fajrFallback:
'redTwilight'` applies 12° to Fajr too). *Deobandi:* the nearest-location (*aqrab al-bilad*) approach for both Fajr and Isha.

Sources: Barelvi: [fatwaqa.com](https://www.fatwaqa.com/ur/fatawa/namaz/bright-night-mein-isha-ka-waqt),
[Al-Jamiatul Ashrafia](https://www.aljamiatulashrafia.in/answer.php?qid=1401&cat=9484635342544&uit=1983642563487650970&lang=EN),
[Dawat-e-Islami UK timetable](https://www.dawateislami.net/prayer-times/world/united-kingdom). Deobandi:
[Wifaq ul Ulama UK](https://www.wifaqululama.co.uk/highlat/), [AskImam 15287](https://www.askimam.org/public/question_detail/15287).
The app presents these as published opinions, not rulings; consult your scholar.

## 5. High-latitude rules

Near the poles in summer the Sun may not get 18° below the horizon (no true night), or not set at all. Then Fajr and
Isha, and in the extreme Sunrise and Maghrib, cannot be found from the Sun's angle. The chosen rule decides:

| Rule | Isha / Fajr |
|---|---|
| Angle-based | portion of the night = angle/60: Isha = sunset + (Isha° / 60) · night; Fajr = sunrise − (Fajr° / 60) · night |
| One seventh | Isha at sunset + night/7; Fajr at sunrise − night/7 |
| Middle of the night | Isha at sunset + night/2; Fajr = sunrise − night/2 |
| Red twilight (default) | **Isha:** the Isha angle (18°) if it is reached; else the red-twilight angle (12°, `redTwilightAngle`) if reached (note `redTwilight`); else the nearest location where 12° is reached. **Fajr:** its angle (18°) if reached; else, by default, borrowed from the nearest location where it is reached (`fajrFallback: 'nearestLocation'`), or the same 12° cascade as Isha (`'redTwilight'`) |
| Nearest latitude | take the missing Fajr/Isha from the nearest place (same longitude and date) where that twilight angle is actually reached (*aqrab al-bilad*, see below) |
| None | the time is left empty (`null`, `noEvent`) |

"night" is sunset to the next sunrise. Portion rules also *shorten* a twilight time that lies further from sunset or
sunrise than the portion allows. Every time that comes from a rule is marked with the note
`highLatitudeRule`, `redTwilight` (Isha or Fajr at the red-twilight angle, the Sahibayn's ruling) or `nearestLatitude`
(borrowed from another latitude; `borrowedLatitudes` says which one per event); the engine turns each such event into a `highLatitudeRuleUsed` anomaly so
that you can see where the rule, not the Sun, decided the time.

### Polar day and polar night: nearest location (*aqrab al-bilad*)

When the Sun does not rise or set at all (polar day or night; any rule except *None*), the schedule is borrowed from
the **nearest place where the needed events exist**, computed dynamically for that date, longitude and elevation
(setting `polarFallback`, default `nearestLocation`):

1. Start at the observer's latitude and step toward the equator in 0.25° steps (same longitude, same observer
   elevation, so the horizon dip stays consistent) until the Sun rises and sets on that date, rises again the next
   day (night length, Islamic midnight), Asr exists (the noon Sun is above the horizon) and, for methods with a Maghrib
   angle (Tehran, Ja'fari), that angle is reached.
2. Bisect between the last failing and the first passing latitude down to 0.01°, then move another 0.05° toward the
   equator so the borrowed place is safely inside the region where the events exist.
3. Take Sunrise, Asr, Maghrib and the night length from that latitude. **Dhuhr stays at the real place**: solar transit
   does not depend on latitude. The borrowed latitude is reported as `borrowedLatitude` for display.
4. Fajr and Isha: if the twilight angle is reached at the borrowed latitude it is used; otherwise the configured
   high-latitude rule is applied there. With the *Nearest latitude* rule the search simply continues toward the equator
   for the latitude where that specific twilight angle is reached (searched separately for Fajr and Isha).

Examples (21 June, no elevation): Tromsø (69.65° N) borrows ≈ 65.7° N, because the Sun only sets south of
90° − 23.44° − 0.83°; 80° N and 89.9° N borrow the same latitude. On 21 December Tromsø borrows ≈ 66.5° N (the limit is
set by Asr: the noon Sun must be above the horizon). With *Nearest latitude* and an 18° twilight angle, Fajr and Isha
come from about 48.5° N. At 11 000 m the dip of 3.64° moves the sunset limit to about 62° N.

The same dynamic search is used when the rule is *Nearest latitude* at a place where the Sun does set but 18° twilight
never occurs (e.g. Reykjavik in June): only the missing twilight times are borrowed, and a borrowed time that would
fall on the wrong side of the local sunrise/sunset is replaced by the angle-based portion. Searches are memoised per
date, longitude (0.1°) and altitude set, so they cost well under a millisecond.

Isha always has to come after Maghrib, including a positive Maghrib offset (Barelvi +3 min) and an angle-based Maghrib;
a borrowed time that would break this, or a Fajr that would not precede sunrise, is replaced by the angle-based share of
the night. Isha by interval (Umm al-Qura) is measured from the displayed Maghrib, i.e. including its offset.

The in-flight messages describe the method actually used: *red twilight (12°) per the Sahibayn*, *borrowed from the
nearest location with a normal night (≈48.5°N on this meridian)*, or the share of the night. They name 48.5° only when
`polarFallback` is `'fixedLatitude'`. "Flying west faster than the sun" is only reported when the aircraft's westward
longitude rate really exceeds 15°/h (its westward ground speed exceeds the Sun's apparent 1 669.8·cos φ km/h); near the
poles (|φ| > 80° or a sweep faster than 30°/h) the message says the aircraft crosses meridians quickly so that local
solar time runs backwards; a repeat caused by a rule recomputing times says so.

`polarFallback: 'fixedLatitude'` restores the legacy behaviour (always latitude ±48.5°). If the search ever found
nothing (it cannot for real parameters: the equator always has sunrise and sunset) the engine falls back to ±48.5°.

## 6. Anomalies

| Kind | When | What it means for the traveller |
|---|---|---|
| `windowRepeated` | the window sequence moves backwards (Asr → Dhuhr, Maghrib → Asr, Dhuhr → Sunrise …) | The Sun moves west at 15° of longitude per hour. An aircraft at latitude φ and ground speed v covers `v / (111 · cos φ)` degrees of longitude per hour, which exceeds 15° when v > 1 670 · cos φ km/h: about 900 km/h above 57° latitude. Flying west faster than that, local solar time runs backwards and the Sun appears to rise again in the west. Typical on polar routes such as the Arctic crossings to California and Asia, or any westbound flight above about 60° N. The earlier prayer was already prayed in its time; scholars generally hold that it remains valid. |
| `windowSkipped` | a transition passes over one or more windows (Asr → Isha: no Maghrib) | The place has no sunset/Maghrib at that moment, or two events fall at the same instant. Follow the high-latitude rule you chose or consult a scholar. |
| `highLatitudeRuleUsed` | an event time comes from a high-latitude rule | see section 5 |
| `polarDay` / `polarNight` | the Sun stays above / below the sunrise-sunset horizon that day at the aircraft's place | Reported once per contiguous stretch (a change from polar day to polar night starts a new one). |

The engine says what it sees; it does not decide on a ruling. Each anomaly has a message intended for the screen,
for example: *"Flying west faster than the sun near 73°N: the sun appears to rise again in the west; the Sunrise
window re-opened after Dhuhr. Scholars generally hold that a prayer already prayed within its valid time remains
valid; consult a scholar about any repeat or combining."*

Near the pole the lines of equal local time converge, so a few windows can open and close within a few minutes over
tens of kilometres (for example over 82° N). That is the arithmetic of the situation, not a bug.

## 7. Sampling, short windows and precision

* **Step.** `stepMinutes` defaults to 1. At 900 km/h that is 15 km between samples.
* **Bisection** uses the exact positions (never rounded), 1 s default (`refineSeconds`), about 6
  evaluations per event for a 60 s interval.
* **Short windows.** A jump that is not "the next window in the cycle" (Maghrib → Fajr, say) triggers a recursive
  8-way subdivision of the interval before bisection, so a 2-minute Isha window at a 5-minute step is still found.
  The test-suite checks this directly.
* **Cost.** About 0.1 s for a 17 h flight at 1-minute steps in Node; a cap of 12 000 samples protects against
  absurd step sizes.
* **Time zone under the aircraft.** Looked up by the position (a 0.5° cache for aircraft in the air, exact for the
  ground), with the nautical `Etc/GMT±N` zone over the oceans.
* **Qibla.** The initial great-circle bearing to the Kaaba is computed for each sample, and relative to the heading
  (positive = turn right). It is only meaningful in the air; on the ground the heading is 0.

## 8. Numeric guards

* Every `acos`/`asin` argument is clamped to [−1, 1]; if the unclamped value is out of range the event does not
  exist there and the high-latitude rule is used instead. No prayer time is `NaN` or an `Invalid Date`: it is a valid
  date or `null` with a reason.
* Poles (`cos φ = 0`), `tan 90°` in Asr, negative or non-finite altitudes (clamped to ≥ 0), longitudes outside
  ±180° (normalised) are handled explicitly.
* Zero-length legs, zero-duration journeys (one sample, no events), arrival not after departure (rejected by the
  journey builder), and invalid dates (empty result) never throw.
* **Antimeridian.** Positions are normalised to [−180, 180); the local solar date uses the longitude, so crossing
  the date line changes the solar date by one day exactly where the clock does, and the window sequence is not
  disturbed. Route interpolation takes the short way round.
* Events are strictly chronological, within [departure, arrival], and the final sample is always the exact arrival.

## 9. Limitations

* Airline schedules in the sample library are *representative*, not live timetables. Use the times on your ticket.
* Real flights deviate from the great circle (jet streams, airways, weather, polar routing, air-traffic control):
  prayer windows over the ocean can shift by several minutes. Importing the real track improves this.
* The Sun's position is accurate to about a minute of time at most; the largest uncertainty is the choice of
  method and the high-latitude rule, not the astronomy.
* The altitude profile is a simple model (climb, cruise, descent). The dip depends on the square root of
  altitude, so small errors matter little.
* Atmospheric refraction at the horizon is standard (0.833°); at altitude, with a depressed horizon, it varies with
  temperature and pressure.
* This software computes times. It does **not** issue rulings: whether to pray at the time shown in the air, how
  to face the Qibla, whether to shorten or combine, and what to do when the Sun re-rises or never sets are matters
  for a qualified scholar. Consult one.
