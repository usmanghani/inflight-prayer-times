/** Shared model for the results sections. */
import type { AircraftState, Airport, FlightLeg, MinuteSample, PrayerWindow } from '../../types';
import { tzAt, utcOffsetMinutes } from '../../time/tz';
import type { ComputeOk } from '../computeCore';
import type { AppSettings } from '../model';
import { fmtInTz, offsetLabel, tzColumns, type TzColumn, type TripTz } from '../format';

export interface Trip extends TripTz {
  legs: FlightLeg[];
  airports: Map<string, Airport>;
  start: Date;
  end: Date;
}

export function buildTrip(legs: FlightLeg[], airports: Map<string, Airport>): Trip {
  const sorted = [...legs].sort((a, b) => a.departureUtc.getTime() - b.departureUtc.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const o = airports.get(first.from);
  const d = airports.get(last.to);
  return {
    legs: sorted,
    airports,
    start: first.departureUtc,
    end: last.arrivalUtc,
    originIata: first.from,
    destIata: last.to,
    originTz: o?.tz ?? 'UTC',
    destTz: d?.tz ?? 'UTC',
  };
}

/** Observable scrub position (index into result.samples), shared by the map, chart, timeline and table. */
export class ScrubState {
  private i = 0;
  private subs = new Set<(i: number) => void>();
  constructor(public readonly max: number) {}
  get index(): number {
    return this.i;
  }
  set(i: number): void {
    const n = Math.max(0, Math.min(this.max, Math.round(Number.isFinite(i) ? i : 0)));
    if (n === this.i) return;
    this.i = n;
    this.subs.forEach((f) => f(n));
  }
  subscribe(f: (i: number) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
}

export interface ResultsModel {
  trip: Trip;
  settings: AppSettings;
  data: ComputeOk;
  cols: TzColumn[];
  scrub: ScrubState;
}

export function buildResultsModel(trip: Trip, settings: AppSettings, data: ComputeOk): ResultsModel {
  return {
    trip,
    settings,
    data,
    cols: tzColumns(settings.tzChoices, trip),
    scrub: new ScrubState(Math.max(0, data.result.samples.length - 1)),
  };
}

/** Zone to use for column `col` at the given position. */
export function zoneFor(col: TzColumn, pos: { lat: number; lon: number }): string {
  return col.tz ?? tzAt(pos.lat, pos.lon);
}

export function timeIn(col: TzColumn, d: Date | null, pos: { lat: number; lon: number }, opts?: { seconds?: boolean; date?: boolean }): string {
  return fmtInTz(d, zoneFor(col, pos), opts);
}

export function offsetIn(col: TzColumn, d: Date, pos: { lat: number; lon: number }): string {
  return offsetLabel(d, zoneFor(col, pos));
}

/** The first column with a fixed zone (for axes); UTC when none. */
export function primaryCol(model: ResultsModel): TzColumn {
  return model.cols.find((c) => c.tz) ?? { key: 'utc', label: 'UTC', tz: 'UTC' };
}

/** Index of the sample closest to time `t` (samples are time-ordered). */
export function sampleIndexAt(samples: MinuteSample[], t: Date): number {
  const ms = t.getTime();
  let lo = 0;
  let hi = samples.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].state.time.getTime() < ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1].state.time.getTime() - ms) <= Math.abs(samples[lo].state.time.getTime() - ms)) return lo - 1;
  return lo;
}

/** Evenly thin an array to at most maxN entries, always keeping the first and last. */
export function decimate<T>(arr: T[], maxN: number): T[] {
  if (arr.length <= maxN || maxN < 2) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (maxN - 1);
  for (let k = 0; k < maxN; k++) out.push(arr[Math.round(k * step)]);
  return out;
}

export const WINDOW_COLOR_VAR: Record<PrayerWindow, string> = {
  fajr: 'var(--c-fajr)',
  sunrise: 'var(--c-sunrise)',
  dhuhr: 'var(--c-dhuhr)',
  asr: 'var(--c-asr)',
  maghrib: 'var(--c-maghrib)',
  isha: 'var(--c-isha)',
};

/** Raw hex values for Leaflet markers (CSS vars cannot be read there reliably). */
export const WINDOW_HEX: Record<PrayerWindow, string> = {
  fajr: '#8b5cf6',
  sunrise: '#eab308',
  dhuhr: '#10b981',
  asr: '#f97316',
  maghrib: '#e11d48',
  isha: '#3b82f6',
};

export function stateTz(s: AircraftState): { lat: number; lon: number } {
  return { lat: s.lat, lon: s.lon };
}

const TICK_HOURS = [1, 2, 3, 4, 6, 12, 24, 48];

export interface AxisTick {
  ms: number;
  label: string;
  /** Set when the calendar day (in `zone`) changes at this tick, e.g. "Tue 13 Oct". */
  day?: string;
}

/** Whole-hour ticks (in `zone`) between t0 and t1, thinned to roughly <= maxTicks. */
export function axisTicks(t0: number, t1: number, zone: string, maxTicks = 9): AxisTick[] {
  const spanH = Math.max(1e-6, (t1 - t0) / 3600000);
  const stepH = TICK_HOURS.find((x) => spanH / x <= maxTicks) ?? 48;
  const stepMs = stepH * 3600000;
  let off = 0;
  try {
    off = utcOffsetMinutes(new Date(t0), zone) * 60000;
  } catch {
    off = 0;
  }
  const out: AxisTick[] = [];
  let tick = Math.ceil((t0 + off) / stepMs) * stepMs - off;
  let lastDay = '';
  for (let guard = 0; tick <= t1 && guard < 80; tick += stepMs, guard++) {
    const d = new Date(tick);
    const label = fmtInTz(d, zone, { date: false });
    const day = fmtInTz(d, zone, { date: true }).replace(/ \d\d:\d\d.*$/, '');
    out.push({ ms: tick, label, day: day !== lastDay ? day : undefined });
    lastDay = day;
  }
  return out;
}
