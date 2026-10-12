export type FlightSource = 'aerodatabox' | 'flightaware' | 'adsbdb';
export type TrackSource = 'flightaware' | 'opensky' | 'adsblol';

export interface FlightLegInfo {
  flightNumber: string;
  from: string;
  to: string;
  scheduledDepartureUtc?: string;
  scheduledArrivalUtc?: string;
  actualDepartureUtc?: string;
  actualArrivalUtc?: string;
  aircraftIcao24?: string;
  aircraftType?: string;
}

export interface FlightResult {
  source: FlightSource;
  legs: FlightLegInfo[];
}

export interface TrackPointOut {
  lat: number;
  lon: number;
  altitudeM?: number;
  time: string; // ISO
}

export interface TrackResult {
  source: TrackSource;
  attribution: string;
  points: TrackPointOut[];
}
