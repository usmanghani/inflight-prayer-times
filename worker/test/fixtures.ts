import adsbdb from './fixtures/adsbdb-UAE226.json';
import adsblolCallsign from './fixtures/adsblol-callsign.json';
import adsblolTrace from './fixtures/adsblol-trace.json';
import aeroapiFlights from './fixtures/aeroapi-EK226.json';
import aeroapiTrack from './fixtures/aeroapi-track.json';
import aerodatabox from './fixtures/aerodatabox-EK226.json';
import openrouterOk from './fixtures/openrouter-ok.json';
import openskyTrack from './fixtures/opensky-track.json';

const files: Record<string, unknown> = {
  'adsbdb-UAE226.json': adsbdb,
  'adsblol-callsign.json': adsblolCallsign,
  'adsblol-trace.json': adsblolTrace,
  'aeroapi-EK226.json': aeroapiFlights,
  'aeroapi-track.json': aeroapiTrack,
  'aerodatabox-EK226.json': aerodatabox,
  'openrouter-ok.json': openrouterOk,
  'opensky-track.json': openskyTrack,
};

/** Fresh deep copy of a recorded sample upstream response. */
export const fx = (name: string): any => JSON.parse(JSON.stringify(files[name]));
