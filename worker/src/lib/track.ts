import type { TrackPointOut } from './types';

export const MAX_TRACK_POINTS = 2500;

/**
 * Validate/clean points: finite lat/lon in range, valid time, sorted by time,
 * duplicate timestamps dropped, rounded; evenly decimated above `max` (keeps first/last).
 */
export function cleanTrack(points: TrackPointOut[], max = MAX_TRACK_POINTS): TrackPointOut[] {
  const valid: TrackPointOut[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    const t = Date.parse(p.time);
    if (Number.isNaN(t)) continue;
    const pt: TrackPointOut = {
      lat: Math.round(p.lat * 1e5) / 1e5,
      lon: Math.round(p.lon * 1e5) / 1e5,
      time: new Date(t).toISOString(),
    };
    if (p.altitudeM != null && Number.isFinite(p.altitudeM)) pt.altitudeM = Math.max(0, Math.round(p.altitudeM));
    valid.push(pt);
  }
  valid.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const dedup: TrackPointOut[] = [];
  for (const p of valid) {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.time === p.time) continue;
    dedup.push(p);
  }
  if (dedup.length <= max) return dedup;
  const out: TrackPointOut[] = [];
  const step = (dedup.length - 1) / (max - 1);
  let last = -1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    if (idx !== last) out.push(dedup[idx]!);
    last = idx;
  }
  return out;
}

export function filterWindow(points: TrackPointOut[], beginMs?: number, endMs?: number): TrackPointOut[] {
  return points.filter((p) => {
    const t = Date.parse(p.time);
    return (beginMs == null || t >= beginMs) && (endMs == null || t <= endMs);
  });
}
