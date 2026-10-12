/**
 * Shared contracts for the in-flight prayer time engine.
 * All instants are JS `Date` (UTC internally). Angles are degrees unless noted.
 */

// ───────────────────────────── Prayer settings ─────────────────────────────

/** Asr shadow rule. Hanafi = shadow factor 2, everyone else = 1. */
export type Madhab = 'hanafi' | 'shafii' | 'maliki' | 'hanbali' | 'jafari';

export type HighLatitudeRule =
  | 'angleBased'      // portion of night = angle/60
  | 'oneSeventh'      // 1/7 of the night
  | 'middleOfNight'   // 1/2 of the night
  | 'nearestLatitude' // compute at ±48.5° (aqrab al-bilad), same longitude
  | 'none';           // leave missing times as null

export type MidnightMode = 'standard' | 'jafari'; // sunset→sunrise | sunset→fajr

export type MethodId =
  | 'karachi' | 'mwl' | 'isna' | 'egypt' | 'ummAlQura' | 'gulf' | 'kuwait'
  | 'qatar' | 'singapore' | 'jakim' | 'diyanet' | 'tehran' | 'jafari'
  | 'france' | 'russia' | 'dubai' | 'custom';

export interface CalculationMethod {
  id: MethodId;
  name: string;
  fajrAngle: number;            // degrees below horizon
  ishaAngle: number | null;     // null when isha is interval-based
  ishaIntervalMin: number | null; // minutes after maghrib (e.g. Umm al-Qura 90)
  maghribAngle: number | null;  // null = sunset; e.g. 4 for Ja'fari
  midnight: MidnightMode;
}

export interface PrayerOffsets {
  fajr: number; sunrise: number; dhuhr: number;
  asr: number; maghrib: number; isha: number; // minutes, may be negative
}

export interface PrayerSettings {
  madhab: Madhab;                // default 'hanafi'
  method: CalculationMethod;     // default Karachi 18/18
  highLatitudeRule: HighLatitudeRule; // default 'angleBased'
  /** Apply altitude horizon dip to sunrise & maghrib (default true). */
  dipForSunriseSunset: boolean;
  /** Also apply altitude horizon dip to fajr/isha twilight angles (default false). */
  dipForTwilight: boolean;
  offsets: PrayerOffsets;
}

// ───────────────────────────── Prayer results ─────────────────────────────

export type PrayerName = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

/** Windows a moment can belong to. 'sunrise' = after sunrise, before dhuhr (no fard prayer). */
export type PrayerWindow = PrayerName; // window named after the event that opens it

/** Why a time was not computed directly from the sun angle. */
export type TimeNote =
  | 'ok'
  | 'highLatitudeRule'   // derived from a high-latitude rule
  | 'interval'           // isha/maghrib by fixed interval
  | 'nearestLatitude'
  | 'noEvent';           // could not be determined at all (value is null)

export interface PrayerTime {
  time: Date | null;   // never an Invalid Date
  note: TimeNote;
}

export interface StaticPrayerTimes {
  /** UTC calendar date (YYYY-MM-DD) of the *local solar* day these belong to. */
  solarDate: string;
  fajr: PrayerTime;
  sunrise: PrayerTime;
  dhuhr: PrayerTime;
  asr: PrayerTime;
  maghrib: PrayerTime;
  isha: PrayerTime;
  midnight: PrayerTime;      // islamic midnight (end of preferred isha time)
  /** Solar noon altitude & whether sun rises/sets at all that day. */
  dayState: 'normal' | 'polarDay' | 'polarNight';
}

export interface Observer {
  lat: number;        // −90..90
  lon: number;        // −180..180 (inputs outside are normalised)
  elevationM: number; // metres above sea level (negative clamped to 0 for dip)
}

// ───────────────────────────── Geography / flights ─────────────────────────────

export interface LatLon { lat: number; lon: number }

export interface Airport {
  iata: string;
  icao?: string;
  name: string;
  city: string;
  country: string;  // ISO 3166-1 alpha-2
  lat: number;
  lon: number;
  elevationM: number;
  tz: string;       // IANA time zone, e.g. "Asia/Karachi"
}

/** A point of an imported/real track or waypoint list. */
export interface TrackPoint {
  lat: number;
  lon: number;
  altitudeM?: number; // if known (imported tracks)
  time?: Date;        // if known (imported tracks)
}

export interface FlightLeg {
  id: string;
  flightNumber?: string;   // e.g. "EK226"
  from: string;            // IATA
  to: string;              // IATA
  departureUtc: Date;
  arrivalUtc: Date;
  /** Optional intermediate waypoints (great-circle segments between them). */
  waypoints?: TrackPoint[];
  /** Optional imported real track; if present it overrides route & profile. */
  track?: TrackPoint[];
  cruiseAltitudeM?: number; // default 11000
}

export type FlightPhase = 'ground' | 'taxi' | 'climb' | 'cruise' | 'descent';

export interface AircraftState {
  time: Date;
  lat: number;
  lon: number;
  altitudeM: number;       // above mean sea level
  headingDeg: number;      // true track 0..360 (0 when on ground / unknown)
  phase: FlightPhase;
  legIndex: number;        // index of leg, or of the leg just completed during a layover
  onGround: boolean;
  airport?: string;        // IATA when on the ground
}

export interface Journey {
  legs: FlightLeg[];
  start: Date;   // first departure
  end: Date;     // last arrival
  /** Position at an arbitrary instant within [start, end] (clamped outside). */
  stateAt(t: Date): AircraftState;
}

// ───────────────────────────── In-flight results ─────────────────────────────

export interface MinuteSample {
  state: AircraftState;
  sunAltitudeDeg: number;
  sunAzimuthDeg: number;
  window: PrayerWindow;     // active window at this moment & place
  qiblaDeg: number;         // true bearing to Kaaba
  qiblaRelativeDeg: number; // relative to aircraft heading (−180..180)
  tz: string;               // IANA tz under the aircraft (Etc/GMT±N over oceans)
}

export type AnomalyKind =
  | 'windowRepeated'   // e.g. Asr → Dhuhr (flying west faster than the sun)
  | 'windowSkipped'    // e.g. Asr → Isha within one minute boundary
  | 'polarDay'         // sun does not set at this location/date
  | 'polarNight'
  | 'highLatitudeRuleUsed';

export interface PrayerEvent {
  prayer: PrayerName;
  time: Date;               // refined to ~1 s
  state: AircraftState;     // aircraft state at that instant
  note: TimeNote;
  anomaly?: AnomalyKind;
}

export interface InflightResult {
  samples: MinuteSample[];
  events: PrayerEvent[];    // chronological window transitions
  anomalies: { time: Date; kind: AnomalyKind; message: string }[];
  /** Window active at departure (so the user knows what is "currently due"). */
  initialWindow: PrayerWindow;
}
