/**
 * The pure computation behind the Calculate button. Runs inside the Web Worker
 * (compute.worker.ts) or, when Workers are unavailable, on the main thread.
 * Input and output are structured-clone friendly (Dates survive postMessage;
 * Journey.stateAt is a function, so the journey is rebuilt here from the legs).
 */
import type { Airport, FlightLeg, InflightResult, PrayerSettings, StaticPrayerTimes } from '../types';
import { buildJourney } from '../flight/journey';
import { computeInflight } from '../prayer/inflight';
import { prayerTasks, windowTimeline, type PrayerTask } from '../prayer/summary';
import { computeStaticTimes, makroohIntervals, solarDateAt } from '../prayer/static';

export interface ComputeRequest {
  legs: FlightLeg[];
  /** Airports referenced by the legs (so the worker does not need the 500 kB airport database). */
  airports: Airport[];
  settings: PrayerSettings;
  stepMinutes: number;
}

export interface GroundReference {
  iata: string;
  tz: string;
  solarDate: string;
  role: 'origin' | 'layover' | 'destination';
  times: StaticPrayerTimes;
  makrooh: { start: Date; end: Date; label: string }[];
}

export interface ComputeOk {
  ok: true;
  result: InflightResult;
  tasks: PrayerTask[];
  timeline: ReturnType<typeof windowTimeline>;
  ground: GroundReference[];
  /** Per result.events entry: latitude (signed) its time was borrowed from, when note is 'nearestLatitude'. */
  eventBorrowed: (number | null)[];
  computeMs: number;
}

export interface ComputeFail {
  ok: false;
  error: string;
}

export type ComputeResponse = ComputeOk | ComputeFail;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function runCompute(req: ComputeRequest): ComputeResponse {
  try {
    const t0 = now();
    const byIata = new Map(req.airports.map((a) => [a.iata, a] as const));
    const resolve = (iata: string): Airport | undefined => byIata.get((iata ?? '').trim().toUpperCase());
    const journey = buildJourney(req.legs, resolve);
    const result = computeInflight(journey, req.settings, { stepMinutes: req.stepMinutes });
    const tasks = prayerTasks(result, journey);
    const timeline = windowTimeline(result);

    const ground: GroundReference[] = [];
    const legs = journey.legs;
    const addGround = (iata: string, at: Date, role: GroundReference['role']): void => {
      const a = resolve(iata);
      if (!a) return;
      const solarDate = solarDateAt(at, a.lon);
      const times = computeStaticTimes({ lat: a.lat, lon: a.lon, elevationM: a.elevationM }, solarDate, req.settings);
      ground.push({ iata: a.iata, tz: a.tz, solarDate, role, times, makrooh: makroohIntervals(times) });
    };
    legs.forEach((leg, i) => {
      addGround(leg.from, leg.departureUtc, i === 0 ? 'origin' : 'layover');
    });
    const last = legs[legs.length - 1];
    if (last) addGround(last.to, last.arrivalUtc, 'destination');

    const eventBorrowed = result.events.map((ev): number | null => {
      if (ev.note !== 'nearestLatitude') return null;
      try {
        const base = solarDateAt(ev.time, ev.state.lon);
        const t0 = Date.parse(`${base}T00:00:00Z`);
        for (const k of [0, -1, 1]) {
          const d = new Date(t0 + k * 86_400_000).toISOString().slice(0, 10);
          const st = computeStaticTimes({ lat: ev.state.lat, lon: ev.state.lon, elevationM: ev.state.altitudeM }, d, req.settings);
          const pt = st[ev.prayer as 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'];
          if (pt.time && Math.abs(pt.time.getTime() - ev.time.getTime()) < 5 * 60_000) {
            const b = st.borrowedLatitudes?.[ev.prayer] ?? st.borrowedLatitude;
            return typeof b === 'number' && Number.isFinite(b) ? b : null;
          }
        }
      } catch {
        /* display only */
      }
      return null;
    });

    return { ok: true, result, tasks, timeline, ground, eventBorrowed, computeMs: Math.round(now() - t0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
