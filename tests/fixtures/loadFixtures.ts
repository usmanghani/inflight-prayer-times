/// <reference types="vite/client" />
import type { TrackPoint } from '../../src/types';
import type { FixturePoint, TrackFixture } from './fixtureTypes';

export interface LoadedFixture extends TrackFixture {
  /** File name, e.g. "EK226_2026-10-12_adsblol.json". */
  file: string;
  /** Human label: "<file without .json>". */
  name: string;
}

const modules = import.meta.glob<TrackFixture>('./tracks/*.json', { eager: true, import: 'default' });

function isFixture(x: unknown): x is TrackFixture {
  const f = x as TrackFixture | undefined;
  return (
    !!f && typeof f === 'object' && !!f.meta && typeof f.meta.flightNumber === 'string' &&
    typeof f.meta.from === 'string' && typeof f.meta.to === 'string' && Array.isArray(f.points) &&
    f.points.every((p) => typeof p.t === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.altM))
  );
}

/** All track fixtures in tests/fixtures/tracks, sorted by file name. Invalid files are ignored. */
export function loadTrackFixtures(): LoadedFixture[] {
  return Object.entries(modules)
    .filter(([, v]) => isFixture(v))
    .map(([path, v]) => {
      const file = path.split('/').pop() as string;
      return { ...v, file, name: file.replace(/\.json$/, '') };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function toTrackPoints(points: FixturePoint[]): TrackPoint[] {
  return points.map((p) => ({ lat: p.lat, lon: p.lon, altitudeM: p.altM, time: new Date(p.t) }));
}
