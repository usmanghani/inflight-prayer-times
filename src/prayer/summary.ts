/** Pure presentation helpers over an InflightResult (no I/O, no DOM). */
import { PRAYER_LABEL, formatLatLon } from './inflight';
import type { AircraftState, InflightResult, Journey, PrayerEvent, PrayerName, PrayerWindow } from '../types';

export interface PrayerTask {
  prayer: 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
  /** The event that opened the window; null if the window was already open at departure. */
  windowStart: PrayerEvent | null;
  /** When the window closes (the next window's event); null if still open at arrival. */
  windowEnd: Date | null;
  /** Aircraft state when the window opened (departure state if already open). */
  startState: AircraftState;
  /** Aircraft state when the window closes; null if still open at arrival. */
  endState: AircraftState | null;
  /** Minutes from window start (or departure) to its end within the journey; null if still open at arrival. */
  durationMin: number | null;
  /** True if the window opens while the aircraft is airborne (false: on the ground, incl. layovers and taxi). */
  inAir: boolean;
  notes: string[];
}

const FARD: readonly PrayerName[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const isFard = (w: PrayerWindow): w is PrayerTask['prayer'] => FARD.includes(w);
const MS_PER_MIN = 60_000;

/** Next window name in the canonical cycle, for wording. */
const NEXT_LABEL: Record<PrayerWindow, string> = {
  fajr: 'sunrise', sunrise: 'Dhuhr', dhuhr: 'Asr', asr: 'Maghrib', maghrib: 'Isha', isha: 'Fajr',
};

function feetLevel(altitudeM: number): string {
  const ft = Math.round((altitudeM * 3.28084) / 100) * 100;
  return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
}

/**
 * The fard prayers whose window opens (or is already open at departure) during the journey,
 * with where and when each window starts and ends. A window ends at the next window change
 * (normally Fajr→Sunrise, Dhuhr→Asr, Asr→Maghrib, Maghrib→Isha, Isha→Fajr).
 */
export function prayerTasks(result: InflightResult, journey: Journey): PrayerTask[] {
  const tasks: PrayerTask[] = [];
  const samples = result.samples;
  if (samples.length === 0) return tasks;
  const startMs = samples[0].state.time.getTime();
  const endMs = samples[samples.length - 1].state.time.getTime();
  const events = result.events;
  const seen = new Map<PrayerName, number>();

  const build = (prayer: PrayerTask['prayer'], startEv: PrayerEvent | null, nextEv: PrayerEvent | null): PrayerTask => {
    const startState = startEv ? startEv.state : samples[0].state;
    const startedMs = startEv ? startEv.time.getTime() : startMs;
    const notes: string[] = [];
    const inAir = !startState.onGround;

    if (!startEv) {
      notes.push('window already open at departure');
    } else if (startState.onGround) {
      const where = startState.airport ?? 'the airport';
      const layover = startState.phase === 'ground' && startedMs > startMs && startedMs < endMs;
      notes.push(`window opens on the ground at ${where}${layover ? ' during layover' : startedMs >= endMs ? ' on arrival' : ''}`);
    } else {
      notes.push(`window opens in the air near ${formatLatLon(startState.lat, startState.lon)} at ${feetLevel(startState.altitudeM)}`);
    }

    const windowEnd = nextEv ? nextEv.time : null;
    const durationMin = windowEnd ? (windowEnd.getTime() - startedMs) / MS_PER_MIN : null;
    if (durationMin !== null && durationMin < 10) notes.push('window is shorter than 10 minutes');
    if (!nextEv) notes.push('window still open at arrival');
    else if (nextEv.anomaly === 'windowRepeated') {
      notes.push(`window ended by an earlier window re-opening (${PRAYER_LABEL[nextEv.prayer]}); expected ${NEXT_LABEL[prayer]}`);
    }
    if (prayer === 'isha') notes.push('Isha is best prayed before Islamic midnight; it ends at Fajr');
    if (startEv?.anomaly === 'windowRepeated') notes.push('this window opened again after a later window (local solar time ran backwards, e.g. flying west faster than the sun)');
    if (startEv?.anomaly === 'windowSkipped') notes.push('a window before this one never opened');
    if (startEv && (startEv.note === 'highLatitudeRule' || startEv.note === 'nearestLatitude' || startEv.note === 'redTwilight')) {
      notes.push(
        startEv.note === 'nearestLatitude' ? 'start time borrowed from the nearest location'
          : startEv.note === 'redTwilight' ? 'start time at the red twilight (Sahibayn) because the full twilight angle is not reached'
            : 'start time from the high-latitude rule',
      );
    }
    const n = (seen.get(prayer) ?? 0) + 1;
    seen.set(prayer, n);
    if (n > 1) notes.push(`this prayer's window opens more than once during the journey (occurrence ${n})`);

    return {
      prayer,
      windowStart: startEv,
      windowEnd,
      startState,
      endState: nextEv ? nextEv.state : null,
      durationMin,
      inAir,
      notes,
    };
  };

  if (isFard(result.initialWindow)) tasks.push(build(result.initialWindow, null, events[0] ?? null));
  events.forEach((ev, i) => {
    if (isFard(ev.prayer)) tasks.push(build(ev.prayer, ev, events[i + 1] ?? null));
  });
  void journey; // reserved: journey metadata (legs/airports) may enrich notes later
  return tasks;
}

/**
 * Contiguous window segments covering the whole journey (for a timeline bar).
 * Zero-length segments are dropped unless the journey itself has zero duration.
 */
export function windowTimeline(result: InflightResult): { window: PrayerWindow; start: Date; end: Date }[] {
  const samples = result.samples;
  if (samples.length === 0) return [];
  const start = samples[0].state.time;
  const end = samples[samples.length - 1].state.time;
  const out: { window: PrayerWindow; start: Date; end: Date }[] = [];
  let curWindow: PrayerWindow = result.initialWindow;
  let curStart = start;
  for (const ev of result.events) {
    if (ev.time.getTime() > curStart.getTime()) out.push({ window: curWindow, start: curStart, end: ev.time });
    curWindow = ev.prayer;
    curStart = ev.time;
  }
  if (end.getTime() > curStart.getTime() || out.length === 0) out.push({ window: curWindow, start: curStart, end });
  return out;
}
