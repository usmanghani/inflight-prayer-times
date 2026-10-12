import type { Airport, AircraftState, FlightLeg, FlightPhase, Journey, LatLon, TrackPoint } from '../types';
import {
  buildPathIndex,
  clampLat,
  haversineKm,
  initialBearingDeg,
  interpolateGreatCircle,
  normalizeLon,
  pathLengthKm,
  type PathIndex,
} from '../geo/geodesy';
import { DEFAULT_PROFILE, profileAt, type ProfileConfig } from './profile';

export type AirportResolver = (iata: string) => Airport | undefined;

const MIN = 60000;
const HOUR = 3600000;

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const code = (s: string) => (s ?? '').trim().toUpperCase();

/** [from, ...waypoints, to] or the imported track points. Throws if an airport is unknown. */
export function legRoute(leg: FlightLeg, resolve: AirportResolver): LatLon[] {
  if (leg.track && leg.track.length >= 2) {
    return leg.track.map((p) => ({ lat: p.lat, lon: p.lon }));
  }
  const from = resolve(leg.from);
  const to = resolve(leg.to);
  if (!from) throw new Error(`Unknown airport "${leg.from}"`);
  if (!to) throw new Error(`Unknown airport "${leg.to}"`);
  return [
    { lat: from.lat, lon: from.lon },
    ...(leg.waypoints ?? []).map((p) => ({ lat: p.lat, lon: p.lon })),
    { lat: to.lat, lon: to.lon },
  ];
}

export function validateLegs(legs: FlightLeg[], resolve: AirportResolver): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(legs) || legs.length === 0) {
    errors.push('No flight legs provided.');
    return { errors, warnings };
  }
  const label = (l: FlightLeg, i: number) =>
    `Leg ${i + 1}${l.flightNumber ? ` (${l.flightNumber})` : ''} ${l.from}→${l.to}`;

  const timed: { leg: FlightLeg; i: number }[] = [];
  legs.forEach((leg, i) => {
    const lb = label(leg, i);
    const from = resolve(leg.from);
    const to = resolve(leg.to);
    if (!from) errors.push(`${lb}: unknown airport "${leg.from}".`);
    if (!to) errors.push(`${lb}: unknown airport "${leg.to}".`);
    if (!isValidDate(leg.departureUtc) || !isValidDate(leg.arrivalUtc)) {
      errors.push(`${lb}: invalid departure or arrival date/time.`);
      return;
    }
    const block = leg.arrivalUtc.getTime() - leg.departureUtc.getTime();
    if (block <= 0) {
      errors.push(`${lb}: arrival is not after departure.`);
    } else if (block > 22 * HOUR) {
      errors.push(`${lb}: block time of ${(block / HOUR).toFixed(1)} h exceeds the 22 h maximum.`);
    }
    timed.push({ leg, i });
    if (code(leg.from) === code(leg.to)) warnings.push(`${lb}: departure and arrival airports are the same.`);
    if (from && to && block > 0 && block <= 22 * HOUR) {
      let km = 0;
      try { km = pathLengthKm(legRoute(leg, resolve)); } catch { km = haversineKm(from, to); }
      if (km >= 1) {
        const kmh = km / (block / HOUR);
        if (kmh > 1100) warnings.push(`${lb}: implied speed ${Math.round(kmh)} km/h is faster than any airliner; check the times.`);
        else if (kmh < 250) warnings.push(`${lb}: implied speed ${Math.round(kmh)} km/h is unusually slow; check the times.`);
      }
    }
  });

  timed.sort((a, b) => a.leg.departureUtc.getTime() - b.leg.departureUtc.getTime() || a.i - b.i);
  for (let k = 0; k + 1 < timed.length; k++) {
    const cur = timed[k], next = timed[k + 1];
    const gap = next.leg.departureUtc.getTime() - cur.leg.arrivalUtc.getTime();
    const names = `${label(cur.leg, cur.i)} and ${label(next.leg, next.i)}`;
    if (gap < 0) errors.push(`${names} overlap in time.`);
    else if (gap > 48 * HOUR) warnings.push(`${names}: layover of ${(gap / HOUR).toFixed(1)} h is longer than 48 h.`);
    if (code(cur.leg.to) !== code(next.leg.from)) {
      warnings.push(`${names}: connection mismatch (arrives ${cur.leg.to}, next flight departs ${next.leg.from}).`);
    }
  }
  return { errors, warnings };
}

// ───────────────────────────── internal per-leg precomputation ─────────────────────────────

interface TimedTrack {
  ms: number[];            // shifted point times, ascending
  pts: TrackPoint[];
  segBearing: number[];    // bearing of segment i (pts[i]→pts[i+1])
  startMs: number;
  endMs: number;
}

interface LegRt {
  leg: FlightLeg;
  from: Airport;
  to: Airport;
  depMs: number;
  arrMs: number;
  blockMin: number;
  cfg: ProfileConfig;
  index: PathIndex;
  timed?: TimedTrack;
  /** Untimed track with altitudes on every point: altitude by distance along the track. */
  trackAlt?: number[];
}

function buildTimed(leg: FlightLeg, depMs: number, arrMs: number): TimedTrack | undefined {
  const tr = leg.track;
  if (!tr || tr.length < 2 || !tr.every((p) => p.time && !Number.isNaN(p.time.getTime()))) return undefined;
  const sorted = tr.map((p, i) => ({ p, i })).sort((a, b) => a.p.time!.getTime() - b.p.time!.getTime() || a.i - b.i).map((x) => x.p);
  let ms = sorted.map((p) => p.time!.getTime());
  // If the track's clock does not overlap the scheduled leg at all (e.g. a past flight imported for a
  // future itinerary), re-anchor it so the track starts at scheduled departure.
  const overlaps = ms[0] < arrMs && ms[ms.length - 1] > depMs;
  const shift = overlaps ? 0 : depMs - ms[0];
  if (shift !== 0) ms = ms.map((t) => t + shift);
  // Per-segment bearing; tiny/duplicate segments inherit a neighbour's bearing.
  const n = sorted.length;
  const raw: (number | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    raw.push(haversineKm(sorted[i], sorted[i + 1]) > 1e-3 ? initialBearingDeg(sorted[i], sorted[i + 1]) : null);
  }
  const seg: number[] = [];
  let carry: number | null = null;
  for (let i = 0; i < raw.length; i++) { if (raw[i] !== null) carry = raw[i]; seg.push(carry ?? NaN); }
  let back = 0;
  for (let i = seg.length - 1; i >= 0; i--) { if (Number.isNaN(seg[i])) seg[i] = back; else back = seg[i]; }
  return { ms, pts: sorted, segBearing: seg, startMs: ms[0], endMs: ms[n - 1] };
}

function airborneState(
  base: Pick<AircraftState, 'time' | 'legIndex'>,
  lat: number, lon: number, altitudeM: number, headingDeg: number, phase: FlightPhase,
): AircraftState {
  return {
    time: base.time, lat, lon, altitudeM, headingDeg,
    phase, legIndex: base.legIndex, onGround: false,
  };
}

function groundState(time: Date, a: Airport, legIndex: number, phase: FlightPhase): AircraftState {
  return {
    time, lat: a.lat, lon: a.lon, altitudeM: a.elevationM, headingDeg: 0,
    phase, legIndex, onGround: true, airport: a.iata,
  };
}

export function buildJourney(legs: FlightLeg[], resolve: AirportResolver, profile?: Partial<ProfileConfig>): Journey {
  const { errors } = validateLegs(legs, resolve);
  if (errors.length > 0) throw new Error(`Invalid itinerary: ${errors.join(' ')}`);

  const sorted = legs
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.departureUtc.getTime() - b.l.departureUtc.getTime() || a.i - b.i)
    .map((x) => x.l);

  const rts: LegRt[] = sorted.map((leg) => {
    const from = resolve(leg.from)!;
    const to = resolve(leg.to)!;
    const depMs = leg.departureUtc.getTime();
    const arrMs = leg.arrivalUtc.getTime();
    const cfg: ProfileConfig = {
      ...DEFAULT_PROFILE,
      ...(profile ?? {}),
      ...(leg.cruiseAltitudeM !== undefined && Number.isFinite(leg.cruiseAltitudeM) ? { cruiseAltitudeM: leg.cruiseAltitudeM } : {}),
    };
    const timed = buildTimed(leg, depMs, arrMs);
    const hasTrack = !!leg.track && leg.track.length >= 2;
    const rt: LegRt = {
      leg, from, to, depMs, arrMs, blockMin: (arrMs - depMs) / MIN, cfg,
      index: buildPathIndex(legRoute(leg, resolve)),
      timed,
    };
    if (hasTrack && !timed && leg.track!.every((p) => Number.isFinite(p.altitudeM))) {
      rt.trackAlt = leg.track!.map((p) => p.altitudeM as number);
    }
    return rt;
  });

  const startMs = rts[0].depMs;
  const endMs = rts[rts.length - 1].arrMs;

  function legState(rt: LegRt, idx: number, ms: number, time: Date): AircraftState {
    const { from, to, blockMin, cfg } = rt;
    const elapsed = (ms - rt.depMs) / MIN;

    if (rt.timed) {
      const tt = rt.timed;
      if (ms < tt.startMs) return groundState(time, from, idx, 'taxi');
      if (ms > tt.endMs) return groundState(time, to, idx, 'taxi');
      // Pseudo-elapsed time so the profile can supply phase (and altitude fallback) for this track.
      const airborneMin = Math.max(blockMin - cfg.taxiOutMin - cfg.taxiInMin, blockMin * 0.5);
      const u = tt.endMs > tt.startMs ? (ms - tt.startMs) / (tt.endMs - tt.startMs) : 0;
      const pseudo = (blockMin - airborneMin) / 2 + u * airborneMin;
      const prof = profileAt(pseudo, blockMin, from.elevationM, to.elevationM, cfg);
      const phase: FlightPhase = prof.phase === 'taxi' || prof.phase === 'ground' ? (u < 0.5 ? 'climb' : 'descent') : prof.phase;

      // Greatest i with ms[i] <= t.
      let lo = 0, hi = tt.ms.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tt.ms[mid] <= ms) lo = mid; else hi = mid - 1;
      }
      const i = lo;
      const last = tt.pts.length - 1;
      let lat: number, lon: number, alt: number | undefined, heading: number;
      if (i >= last) {
        lat = clampLat(tt.pts[last].lat); lon = normalizeLon(tt.pts[last].lon);
        alt = tt.pts[last].altitudeM;
        heading = tt.segBearing[last - 1] ?? 0;
      } else {
        const a = tt.pts[i], b = tt.pts[i + 1];
        const f = (ms - tt.ms[i]) / (tt.ms[i + 1] - tt.ms[i]); // ms[i+1] > ms[i]: i is the greatest index <= t
        const p = interpolateGreatCircle(a, b, f);
        lat = p.lat; lon = p.lon;
        alt = a.altitudeM !== undefined && b.altitudeM !== undefined ? a.altitudeM + (b.altitudeM - a.altitudeM) * f : undefined;
        heading = tt.segBearing[i];
      }
      return airborneState({ time, legIndex: idx }, lat, lon, alt !== undefined && Number.isFinite(alt) ? alt : prof.altitudeM, heading, phase);
    }

    const prof = profileAt(elapsed, blockMin, from.elevationM, to.elevationM, cfg);
    if (prof.phase === 'taxi' || prof.phase === 'ground') {
      // Taxi: on the ground at the departure airport before take-off, the arrival airport after landing.
      return groundState(time, prof.distanceFraction >= 1 ? to : from, idx, prof.phase);
    }
    const loc = rt.index.locate(prof.distanceFraction * rt.index.totalKm);
    let alt = prof.altitudeM;
    if (rt.trackAlt && rt.index.totalKm > 0) {
      const a0 = rt.trackAlt[loc.segment], a1 = rt.trackAlt[loc.segment + 1];
      if (a0 !== undefined && a1 !== undefined) alt = a0 + (a1 - a0) * loc.t;
    }
    return airborneState({ time, legIndex: idx }, loc.point.lat, loc.point.lon, alt, loc.bearingDeg, prof.phase);
  }

  function stateAt(t: Date): AircraftState {
    const raw = t instanceof Date ? t.getTime() : NaN;
    const ms = Number.isFinite(raw) ? raw : startMs;
    const time = new Date(ms);
    if (ms < startMs) return groundState(time, rts[0].from, 0, 'ground');
    if (ms >= endMs) return groundState(time, rts[rts.length - 1].to, rts.length - 1, 'ground');
    // Few legs per journey: linear scan is fine.
    for (let i = 0; i < rts.length; i++) {
      const rt = rts[i];
      if (ms < rt.depMs) return groundState(time, rts[i - 1].to, i - 1, 'ground'); // layover (i >= 1 since ms >= startMs)
      if (ms < rt.arrMs) return legState(rt, i, ms, time);
    }
    return groundState(time, rts[rts.length - 1].to, rts.length - 1, 'ground'); // unreachable
  }

  return { legs: sorted, start: new Date(startMs), end: new Date(endMs), stateAt };
}
