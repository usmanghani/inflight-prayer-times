import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAirport } from '../../../src/data/airports';
import { haversineKm } from '../../../src/geo/geodesy';
import type { FixtureMeta, FixturePoint, FixtureSource, TrackFixture } from '../../../tests/fixtures/fixtureTypes';

export type { FixtureMeta, FixturePoint, FixtureSource, TrackFixture };

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = resolve(HERE, '..', '..', '..', 'tests', 'fixtures');
export const TRACK_DIR = join(FIXTURE_ROOT, 'tracks');

export const SOURCES = {
  adsblol: { attribution: 'Data © adsb.lol contributors, ODbL 1.0', license: 'ODbL-1.0 (https://opendatacommons.org/licenses/odbl/1-0/)' },
  opensky: {
    attribution: 'Data © The OpenSky Network, https://opensky-network.org (Schäfer et al., IPSN 2014)',
    license: 'OpenSky Network terms of use (research / non-commercial, attribution required)',
  },
  flightaware: {
    attribution: 'Data © FlightAware, via AeroAPI',
    license: 'FlightAware AeroAPI terms (no redistribution; keep local)',
  },
} as const;

/** A position fix as it comes from a source, before thinning. t = epoch ms, altM = null when unknown, ground = on the ground. */
export interface RawPoint {
  t: number;
  lat: number;
  lon: number;
  altM: number | null;
  ground?: boolean;
  /** Callsign if the source reports it per point. */
  callsign?: string;
}

const FT_M = 0.3048;
export const ftToM = (ft: number): number => ft * FT_M;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r10 = (x: number): number => Math.round(x / 10) * 10;

/**
 * Thin to at most one point per `minGapSec` (default 60 s), always keeping the first and last point.
 * Real tracks are sampled every few seconds near the airport and every ~10–60 s at cruise, so one point per minute
 * (≈ 15 km at cruise) preserves turns well; a point is never dropped if the gap since the last kept point is
 * already ≥ minGapSec, so sparse (oceanic) stretches are kept verbatim.
 */
export function thin(points: RawPoint[], minGapSec = 60): RawPoint[] {
  if (points.length <= 2) return points.slice();
  const out: RawPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].t - out[out.length - 1].t >= minGapSec * 1000) out.push(points[i]);
  }
  const last = points[points.length - 1];
  // keep the output at <= 1 point/min: let the final point replace a kept point that is closer than minGapSec
  if (out.length > 1 && last.t - out[out.length - 1].t < minGapSec * 1000) out.pop();
  out.push(last);
  return out;
}

/** Round, convert and fill missing altitudes (linear in time between known ones, 0 outside). */
export function toFixturePoints(points: RawPoint[], groundElevM: { from: number; to: number } = { from: 0, to: 0 }): FixturePoint[] {
  const alts: (number | null)[] = points.map((p) => p.altM);
  // ground points before the first airborne point → origin elevation, after the last → destination elevation
  const firstAir = points.findIndex((p) => !p.ground);
  let lastAir = -1;
  points.forEach((p, i) => { if (!p.ground) lastAir = i; });
  points.forEach((p, i) => {
    if (p.ground && alts[i] === null) alts[i] = i < firstAir || firstAir < 0 ? groundElevM.from : i > lastAir ? groundElevM.to : 0;
  });
  // interpolate remaining nulls
  for (let i = 0; i < alts.length; i++) {
    if (alts[i] !== null) continue;
    let a = i - 1; while (a >= 0 && alts[a] === null) a--;
    let b = i + 1; while (b < alts.length && alts[b] === null) b++;
    if (a < 0 && b >= alts.length) alts[i] = 0;
    else if (a < 0) alts[i] = alts[b];
    else if (b >= alts.length) alts[i] = alts[a];
    else {
      const f = (points[i].t - points[a].t) / (points[b].t - points[a].t);
      alts[i] = (alts[a] as number) + ((alts[b] as number) - (alts[a] as number)) * f;
    }
  }
  return points.map((p, i) => ({
    t: new Date(p.t).toISOString(),
    lat: r4(p.lat),
    lon: r4(p.lon),
    altM: Math.max(0, r10(alts[i] as number)),
  }));
}

export interface Completeness {
  complete: boolean;
  startKm: number | null;
  endKm: number | null;
  maxGapMin: number;
  reasons: string[];
}

/**
 * A track is "complete" when it starts near the origin airport, ends near the destination, and has no gap > maxGapMin
 * (default 6 h: oceanic coverage holes are normal and are bridged on a great circle, `meta.maxGapMin` records them).
 */
export function assessCompleteness(
  points: RawPoint[], from: string, to: string, opts: { maxGapMin?: number; nearKm?: number; nearAltM?: number } = {},
): Completeness {
  const maxGapMin = opts.maxGapMin ?? 360;
  const nearKm = opts.nearKm ?? 40;
  const nearAltM = opts.nearAltM ?? 1500;
  const reasons: string[] = [];
  const a = getAirport(from);
  const b = getAirport(to);
  let gap = 0;
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, (points[i].t - points[i - 1].t) / 60000);
  const first = points[0];
  const last = points[points.length - 1];
  const startKm = a && first ? haversineKm(a, first) : null;
  const endKm = b && last ? haversineKm(b, last) : null;
  if (!a || !b) reasons.push('unknown airport');
  if (points.length < 10) reasons.push('fewer than 10 points');
  if (startKm === null || startKm > nearKm) reasons.push(`starts ${startKm === null ? '?' : Math.round(startKm)} km from ${from}`);
  else if (!first.ground && (first.altM ?? 0) > nearAltM) reasons.push(`first point is airborne at ${Math.round(first.altM ?? 0)} m`);
  if (endKm === null || endKm > nearKm) reasons.push(`ends ${endKm === null ? '?' : Math.round(endKm)} km from ${to}`);
  else if (!last.ground && (last.altM ?? 0) > nearAltM) reasons.push(`last point is airborne at ${Math.round(last.altM ?? 0)} m`);
  if (gap > maxGapMin) reasons.push(`largest gap ${Math.round(gap)} min`);
  return { complete: reasons.length === 0, startKm, endKm, maxGapMin: gap, reasons };
}

export function fixtureFileName(flightNumber: string, date: string, source: string): string {
  return `${flightNumber}_${date}_${source}.json`;
}

export function fixturePath(flightNumber: string, date: string, source: string): string {
  return join(TRACK_DIR, fixtureFileName(flightNumber, date, source));
}

/** One point per line keeps the files small and diff-friendly. */
export function serializeFixture(fx: TrackFixture): string {
  const meta = JSON.stringify(fx.meta, null, 2).replace(/\n/g, '\n  ');
  const pts = fx.points.map((p) => `    ${JSON.stringify(p)}`).join(',\n');
  return `{\n  "meta": ${meta},\n  "points": [\n${pts}\n  ]\n}\n`;
}

export function readFixture(path: string): TrackFixture | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')) as TrackFixture; } catch { return undefined; }
}

export interface SaveResult { path: string; action: 'created' | 'replaced' | 'kept-existing'; points: number; complete: boolean }

/**
 * Save a fixture unless a better one is already on disk: a complete track always beats a partial one, and
 * otherwise the track with the later last point (i.e. more of the flight) wins.
 */
export function saveFixture(fx: TrackFixture): SaveResult {
  const path = fixturePath(fx.meta.flightNumber, fx.meta.date, fx.meta.source);
  const old = readFixture(path);
  const better = (() => {
    if (!old) return true;
    if (fx.meta.complete !== old.meta.complete) return fx.meta.complete;
    const oldLast = old.points[old.points.length - 1]?.t ?? '';
    const newLast = fx.points[fx.points.length - 1]?.t ?? '';
    if (newLast !== oldLast) return newLast > oldLast;
    return fx.points.length >= old.points.length;
  })();
  if (!better) return { path, action: 'kept-existing', points: old!.points.length, complete: old!.meta.complete };
  mkdirSync(TRACK_DIR, { recursive: true });
  writeFileSync(path, serializeFixture(fx));
  return { path, action: old ? 'replaced' : 'created', points: fx.points.length, complete: fx.meta.complete };
}

/** Build a fixture from raw points (thinning + rounding + completeness check). */
export function buildFixture(args: {
  flightNumber: string; callsign: string; from: string; to: string; source: FixtureSource;
  points: RawPoint[]; icao24?: string; notes?: string[]; forcePartial?: boolean;
}): TrackFixture {
  const src = SOURCES[args.source as keyof typeof SOURCES] ?? { attribution: String(args.source), license: 'unknown' };
  const raw = args.points.slice().sort((a, b) => a.t - b.t);
  const cmp = assessCompleteness(raw, args.from, args.to);
  const notes = [...(args.notes ?? [])];
  const complete = cmp.complete && !args.forcePartial;
  if (!complete && cmp.reasons.length) notes.push(`partial: ${cmp.reasons.join('; ')}`);
  const thinned = thin(raw);
  const a = getAirport(args.from);
  const b = getAirport(args.to);
  return {
    meta: {
      flightNumber: args.flightNumber,
      callsign: args.callsign,
      from: args.from,
      to: args.to,
      date: new Date(raw[0].t).toISOString().slice(0, 10),
      source: args.source,
      attribution: src.attribution,
      license: src.license,
      fetchedAt: new Date().toISOString(),
      ...(args.icao24 ? { icao24: args.icao24 } : {}),
      complete,
      maxGapMin: Math.round(cmp.maxGapMin),
      ...(notes.length ? { notes: notes.join(' | ') } : {}),
    },
    points: toFixturePoints(thinned, { from: a?.elevationM ?? 0, to: b?.elevationM ?? 0 }),
  };
}
