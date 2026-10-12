/**
 * Real flight library: a curated set of long-running scheduled flights used for
 * one-click demos, sample itineraries and the route-matrix regression tests.
 *
 * IMPORTANT: airline schedules change constantly (seasonal timetables, retimings,
 * route suspensions, flight-number changes, aircraft swaps). The entries below are
 * REPRESENTATIVE: real city pairs flown by the named carriers, with realistic
 * departure/arrival local times anchored to the northern-autumn (October)
 * timetable. Flight numbers and minutes are approximate and may no longer match
 * today's published schedule. Always trust your own ticket over this library.
 *
 * Because arrival times are stored as local clock times, converting a flight to a
 * leg on a date where DST differs from the reference season (e.g. mid-winter) can
 * shift the computed block time by about +/- 1 hour. That is intentional: it is
 * what the local timetable arithmetic gives; edit the times in the UI if needed.
 */
import type { Airport, FlightLeg } from '../types';

export type RouteRegion =
  | 'south-asia' | 'middle-east' | 'east-asia' | 'southeast-asia' | 'europe'
  | 'north-africa' | 'east-africa' | 'west-africa' | 'south-africa'
  | 'south-america' | 'australia' | 'new-zealand' | 'polar' | 'domestic-us';

export interface LibraryFlight {
  flightNumber: string;      // e.g. 'EK226'
  airline: string;           // 'Emirates'
  from: string;              // IATA
  to: string;                // IATA
  depLocal: string;          // 'HH:mm' local at origin
  arrLocal: string;          // 'HH:mm' local at destination
  arrDayOffset: number;      // 0, 1, 2 or -1 relative to departure local date
  region: RouteRegion;
  usCoast: 'east' | 'west' | 'none';
  /** outbound = leaves the US / Pakistan side as grouped; return = heads back to it. */
  direction: 'outbound' | 'return';
  notes?: string;
}

type Coast = LibraryFlight['usCoast'];
type Dir = LibraryFlight['direction'];

function f(
  flightNumber: string, airline: string, from: string, to: string,
  depLocal: string, arrLocal: string, arrDayOffset: number,
  region: RouteRegion, usCoast: Coast, direction: Dir, notes?: string,
): LibraryFlight {
  return {
    flightNumber, airline, from, to, depLocal, arrLocal, arrDayOffset, region, usCoast, direction,
    ...(notes ? { notes } : {}),
  };
}

export const FLIGHT_LIBRARY: LibraryFlight[] = [
  // ── south-asia ──
  f('EK601', 'Emirates', 'KHI', 'DXB', '02:55', '04:20', 0, 'south-asia', 'none', 'outbound'),
  f('EK603', 'Emirates', 'KHI', 'DXB', '10:40', '12:05', 0, 'south-asia', 'none', 'outbound'),
  f('EK600', 'Emirates', 'DXB', 'KHI', '04:05', '07:25', 0, 'south-asia', 'none', 'return'),
  f('EK602', 'Emirates', 'DXB', 'KHI', '15:30', '18:50', 0, 'south-asia', 'none', 'return'),
  f('PK211', 'Pakistan International Airlines', 'KHI', 'DXB', '08:30', '09:55', 0, 'south-asia', 'none', 'outbound'),
  f('PK212', 'Pakistan International Airlines', 'DXB', 'KHI', '11:15', '14:35', 0, 'south-asia', 'none', 'return'),
  f('FZ330', 'flydubai', 'KHI', 'DXB', '06:10', '07:35', 0, 'south-asia', 'none', 'outbound'),
  f('FZ331', 'flydubai', 'DXB', 'KHI', '20:15', '23:35', 0, 'south-asia', 'none', 'return'),
  f('QR605', 'Qatar Airways', 'KHI', 'DOH', '06:30', '07:40', 0, 'south-asia', 'none', 'outbound'),
  f('QR604', 'Qatar Airways', 'DOH', 'KHI', '08:15', '13:00', 0, 'south-asia', 'none', 'return'),
  f('QR608', 'Qatar Airways', 'DOH', 'KHI', '21:55', '02:45', 1, 'south-asia', 'none', 'return'),
  f('TK708', 'Turkish Airlines', 'KHI', 'IST', '04:30', '08:20', 0, 'south-asia', 'none', 'outbound'),
  f('TK709', 'Turkish Airlines', 'IST', 'KHI', '02:30', '10:50', 0, 'south-asia', 'none', 'return'),
  f('SV706', 'Saudia', 'KHI', 'JED', '04:50', '07:35', 0, 'south-asia', 'none', 'outbound'),
  f('SV705', 'Saudia', 'JED', 'KHI', '09:30', '16:00', 0, 'south-asia', 'none', 'return'),
  f('PK741', 'Pakistan International Airlines', 'KHI', 'JED', '02:15', '05:00', 0, 'south-asia', 'none', 'outbound'),
  f('PK742', 'Pakistan International Airlines', 'JED', 'KHI', '05:30', '12:00', 0, 'south-asia', 'none', 'return'),
  f('SV718', 'Saudia', 'KHI', 'RUH', '09:20', '11:10', 0, 'south-asia', 'none', 'outbound'),
  f('SV717', 'Saudia', 'RUH', 'KHI', '13:05', '18:40', 0, 'south-asia', 'none', 'return'),
  f('EY201', 'Etihad Airways', 'KHI', 'AUH', '10:05', '12:00', 0, 'south-asia', 'none', 'outbound'),
  f('EY200', 'Etihad Airways', 'AUH', 'KHI', '02:45', '06:25', 0, 'south-asia', 'none', 'return'),
  f('EK622', 'Emirates', 'DXB', 'LHE', '09:05', '13:35', 0, 'south-asia', 'none', 'return'),
  f('EK623', 'Emirates', 'LHE', 'DXB', '04:45', '07:10', 0, 'south-asia', 'none', 'outbound'),
  f('QR628', 'Qatar Airways', 'DOH', 'LHE', '02:10', '08:10', 0, 'south-asia', 'none', 'return'),
  f('QR629', 'Qatar Airways', 'LHE', 'DOH', '05:20', '07:10', 0, 'south-asia', 'none', 'outbound'),
  f('EK614', 'Emirates', 'DXB', 'ISB', '09:50', '14:25', 0, 'south-asia', 'none', 'return'),
  f('EK615', 'Emirates', 'ISB', 'DXB', '14:05', '16:30', 0, 'south-asia', 'none', 'outbound'),
  f('QR632', 'Qatar Airways', 'DOH', 'ISB', '08:40', '14:40', 0, 'south-asia', 'none', 'return'),
  f('QR633', 'Qatar Airways', 'ISB', 'DOH', '12:30', '14:25', 0, 'south-asia', 'none', 'outbound'),
  f('TK710', 'Turkish Airlines', 'IST', 'ISB', '01:55', '10:25', 0, 'south-asia', 'none', 'return'),
  f('TK711', 'Turkish Airlines', 'ISB', 'IST', '06:15', '10:10', 0, 'south-asia', 'none', 'outbound'),
  f('EK511', 'Emirates', 'DXB', 'DEL', '09:20', '14:20', 0, 'south-asia', 'none', 'outbound'),
  f('EK512', 'Emirates', 'DEL', 'DXB', '04:10', '06:35', 0, 'south-asia', 'none', 'outbound'),
  f('EK500', 'Emirates', 'DXB', 'BOM', '10:00', '14:45', 0, 'south-asia', 'none', 'outbound'),
  f('EK501', 'Emirates', 'BOM', 'DXB', '04:55', '06:50', 0, 'south-asia', 'none', 'outbound'),
  f('EK568', 'Emirates', 'DXB', 'BLR', '09:30', '14:50', 0, 'south-asia', 'none', 'outbound'),
  f('EK569', 'Emirates', 'BLR', 'DXB', '04:30', '07:10', 0, 'south-asia', 'none', 'outbound'),
  f('QR570', 'Qatar Airways', 'DOH', 'DEL', '03:00', '09:30', 0, 'south-asia', 'none', 'outbound'),
  f('QR571', 'Qatar Airways', 'DEL', 'DOH', '05:45', '07:25', 0, 'south-asia', 'none', 'outbound'),
  f('AI101', 'Air India', 'DEL', 'JFK', '02:30', '08:45', 0, 'south-asia', 'east', 'return'),
  f('AI102', 'Air India', 'JFK', 'DEL', '20:30', '20:35', 1, 'south-asia', 'east', 'outbound'),
  f('AI173', 'Air India', 'DEL', 'SFO', '09:30', '12:55', 0, 'south-asia', 'west', 'return'),
  f('AI174', 'Air India', 'SFO', 'DEL', '19:30', '23:20', 1, 'south-asia', 'west', 'outbound'),
  f('AI175', 'Air India', 'SFO', 'BLR', '18:30', '23:30', 1, 'south-asia', 'west', 'outbound'),
  f('AI176', 'Air India', 'BLR', 'SFO', '02:30', '07:05', 0, 'south-asia', 'west', 'return'),
  f('UA83', 'United Airlines', 'EWR', 'DEL', '21:30', '21:50', 1, 'south-asia', 'east', 'outbound'),
  f('UA82', 'United Airlines', 'DEL', 'EWR', '02:40', '09:05', 0, 'south-asia', 'east', 'return'),
  f('UA863', 'United Airlines', 'SFO', 'DEL', '18:30', '22:20', 1, 'south-asia', 'west', 'outbound'),
  f('UA862', 'United Airlines', 'DEL', 'SFO', '22:30', '02:10', 1, 'south-asia', 'west', 'return'),
  // ── middle-east ──
  f('EK201', 'Emirates', 'JFK', 'DXB', '23:00', '19:50', 1, 'middle-east', 'east', 'outbound'),
  f('EK202', 'Emirates', 'DXB', 'JFK', '02:55', '08:20', 0, 'middle-east', 'east', 'return'),
  f('EK203', 'Emirates', 'JFK', 'DXB', '11:00', '07:50', 1, 'middle-east', 'east', 'outbound'),
  f('EK204', 'Emirates', 'DXB', 'JFK', '09:40', '15:10', 0, 'middle-east', 'east', 'return'),
  f('EK211', 'Emirates', 'DXB', 'EWR', '08:25', '14:25', 0, 'middle-east', 'east', 'return'),
  f('EK212', 'Emirates', 'EWR', 'DXB', '22:50', '19:35', 1, 'middle-east', 'east', 'outbound'),
  f('EK231', 'Emirates', 'DXB', 'IAD', '08:35', '14:20', 0, 'middle-east', 'east', 'return'),
  f('EK232', 'Emirates', 'IAD', 'DXB', '11:40', '08:35', 1, 'middle-east', 'east', 'outbound'),
  // ── polar ──
  f('EK225', 'Emirates', 'DXB', 'SFO', '09:55', '15:05', 0, 'polar', 'west', 'return', 'Arctic/high-latitude routing; sun and twilight behave unusually'),
  f('EK226', 'Emirates', 'SFO', 'DXB', '16:35', '19:25', 1, 'polar', 'west', 'outbound', 'Arctic/high-latitude routing; sun and twilight behave unusually'),
  // ── middle-east ──
  f('EK215', 'Emirates', 'DXB', 'LAX', '10:15', '15:25', 0, 'middle-east', 'west', 'return'),
  f('EK216', 'Emirates', 'LAX', 'DXB', '23:25', '02:00', 2, 'middle-east', 'west', 'outbound'),
  f('EK229', 'Emirates', 'DXB', 'SEA', '08:50', '12:20', 0, 'middle-east', 'west', 'return'),
  f('EK230', 'Emirates', 'SEA', 'DXB', '16:45', '18:40', 1, 'middle-east', 'west', 'outbound'),
  f('EK237', 'Emirates', 'DXB', 'BOS', '03:45', '09:15', 0, 'middle-east', 'east', 'return'),
  f('EK238', 'Emirates', 'BOS', 'DXB', '22:40', '19:10', 1, 'middle-east', 'east', 'outbound'),
  f('QR701', 'Qatar Airways', 'DOH', 'JFK', '07:55', '14:15', 0, 'middle-east', 'east', 'return'),
  f('QR702', 'Qatar Airways', 'JFK', 'DOH', '22:30', '17:50', 1, 'middle-east', 'east', 'outbound'),
  f('QR707', 'Qatar Airways', 'DOH', 'IAD', '08:20', '14:45', 0, 'middle-east', 'east', 'return'),
  f('QR708', 'Qatar Airways', 'IAD', 'DOH', '21:30', '17:10', 1, 'middle-east', 'east', 'outbound'),
  f('QR735', 'Qatar Airways', 'DOH', 'SFO', '11:05', '16:55', 0, 'middle-east', 'west', 'return'),
  f('QR736', 'Qatar Airways', 'SFO', 'DOH', '16:10', '16:55', 1, 'middle-east', 'west', 'outbound'),
  f('QR739', 'Qatar Airways', 'DOH', 'LAX', '08:20', '14:20', 0, 'middle-east', 'west', 'return'),
  f('QR740', 'Qatar Airways', 'LAX', 'DOH', '15:30', '16:25', 1, 'middle-east', 'west', 'outbound'),
  f('QR727', 'Qatar Airways', 'DOH', 'SEA', '08:10', '12:45', 0, 'middle-east', 'west', 'return'),
  f('QR728', 'Qatar Airways', 'SEA', 'DOH', '17:30', '17:05', 1, 'middle-east', 'west', 'outbound'),
  f('QR721', 'Qatar Airways', 'DOH', 'DFW', '08:05', '15:05', 0, 'middle-east', 'none', 'return'),
  f('QR722', 'Qatar Airways', 'DFW', 'DOH', '17:00', '14:30', 1, 'middle-east', 'none', 'outbound'),
  f('EY11', 'Etihad Airways', 'AUH', 'JFK', '09:05', '14:40', 0, 'middle-east', 'east', 'return'),
  f('EY12', 'Etihad Airways', 'JFK', 'AUH', '22:20', '18:55', 1, 'middle-east', 'east', 'outbound'),
  f('TK1', 'Turkish Airlines', 'IST', 'JFK', '10:10', '13:50', 0, 'middle-east', 'east', 'return'),
  f('TK2', 'Turkish Airlines', 'JFK', 'IST', '22:25', '14:55', 1, 'middle-east', 'east', 'outbound'),
  f('TK79', 'Turkish Airlines', 'IST', 'SFO', '12:05', '15:00', 0, 'middle-east', 'west', 'return'),
  f('TK80', 'Turkish Airlines', 'SFO', 'IST', '17:10', '15:20', 1, 'middle-east', 'west', 'outbound'),
  f('TK9', 'Turkish Airlines', 'IST', 'LAX', '11:20', '14:35', 0, 'middle-east', 'west', 'return'),
  f('TK10', 'Turkish Airlines', 'LAX', 'IST', '17:15', '15:50', 1, 'middle-east', 'west', 'outbound'),
  f('TK33', 'Turkish Airlines', 'IST', 'IAD', '13:25', '17:30', 0, 'middle-east', 'east', 'return'),
  f('TK34', 'Turkish Airlines', 'IAD', 'IST', '17:35', '10:30', 1, 'middle-east', 'east', 'outbound'),
  // ── north-africa ──
  f('EK927', 'Emirates', 'DXB', 'CAI', '08:10', '10:45', 0, 'north-africa', 'none', 'outbound'),
  f('EK928', 'Emirates', 'CAI', 'DXB', '13:15', '18:05', 0, 'north-africa', 'none', 'outbound'),
  f('AT200', 'Royal Air Maroc', 'CMN', 'JFK', '10:50', '13:55', 0, 'north-africa', 'east', 'return'),
  f('AT201', 'Royal Air Maroc', 'JFK', 'CMN', '22:30', '10:45', 1, 'north-africa', 'east', 'outbound'),
  f('MS986', 'EgyptAir', 'CAI', 'JFK', '09:40', '14:45', 0, 'north-africa', 'east', 'return'),
  f('MS985', 'EgyptAir', 'JFK', 'CAI', '23:55', '17:30', 1, 'north-africa', 'east', 'outbound'),
  // ── europe ──
  f('BA117', 'British Airways', 'JFK', 'LHR', '19:15', '07:00', 1, 'europe', 'east', 'outbound'),
  f('BA112', 'British Airways', 'LHR', 'JFK', '08:40', '11:55', 0, 'europe', 'east', 'return'),
  f('BA283', 'British Airways', 'SFO', 'LHR', '16:20', '10:45', 1, 'europe', 'west', 'outbound'),
  f('BA286', 'British Airways', 'LHR', 'SFO', '11:20', '14:40', 0, 'europe', 'west', 'return'),
  f('BA269', 'British Airways', 'LAX', 'LHR', '17:10', '11:30', 1, 'europe', 'west', 'outbound'),
  f('BA268', 'British Airways', 'LHR', 'LAX', '11:00', '14:25', 0, 'europe', 'west', 'return'),
  f('BA49', 'British Airways', 'SEA', 'LHR', '16:30', '10:00', 1, 'europe', 'west', 'outbound'),
  f('BA48', 'British Airways', 'LHR', 'SEA', '14:00', '16:20', 0, 'europe', 'west', 'return'),
  f('AF7', 'Air France', 'JFK', 'CDG', '19:25', '08:40', 1, 'europe', 'east', 'outbound'),
  f('AF8', 'Air France', 'CDG', 'JFK', '13:15', '15:40', 0, 'europe', 'east', 'return'),
  f('AF83', 'Air France', 'SFO', 'CDG', '15:15', '11:05', 1, 'europe', 'west', 'outbound'),
  f('AF84', 'Air France', 'CDG', 'SFO', '13:00', '15:25', 0, 'europe', 'west', 'return'),
  f('LH400', 'Lufthansa', 'JFK', 'FRA', '17:55', '07:20', 1, 'europe', 'east', 'outbound'),
  f('LH401', 'Lufthansa', 'FRA', 'JFK', '11:20', '13:55', 0, 'europe', 'east', 'return'),
  f('LH455', 'Lufthansa', 'FRA', 'SFO', '13:15', '15:55', 0, 'europe', 'west', 'return'),
  f('LH454', 'Lufthansa', 'SFO', 'FRA', '13:10', '08:50', 1, 'europe', 'west', 'outbound'),
  f('KL642', 'KLM', 'JFK', 'AMS', '18:45', '07:55', 1, 'europe', 'east', 'outbound'),
  f('KL641', 'KLM', 'AMS', 'JFK', '10:30', '12:55', 0, 'europe', 'east', 'return'),
  f('KL605', 'KLM', 'AMS', 'SFO', '11:05', '13:30', 0, 'europe', 'west', 'return'),
  f('KL606', 'KLM', 'SFO', 'AMS', '15:30', '11:00', 1, 'europe', 'west', 'outbound'),
  f('IB6251', 'Iberia', 'JFK', 'MAD', '20:40', '09:55', 1, 'europe', 'east', 'outbound'),
  f('IB6250', 'Iberia', 'MAD', 'JFK', '11:55', '14:25', 0, 'europe', 'east', 'return'),
  f('UA901', 'United Airlines', 'IAD', 'LHR', '17:35', '05:55', 1, 'europe', 'east', 'outbound'),
  f('UA900', 'United Airlines', 'LHR', 'IAD', '10:40', '14:25', 0, 'europe', 'east', 'return'),
  f('EK2', 'Emirates', 'LHR', 'DXB', '14:20', '00:25', 1, 'europe', 'none', 'outbound'),
  f('EK1', 'Emirates', 'DXB', 'LHR', '07:50', '12:15', 0, 'europe', 'none', 'outbound'),
  f('BA107', 'British Airways', 'LHR', 'DXB', '20:30', '06:25', 1, 'europe', 'none', 'outbound'),
  f('BA106', 'British Airways', 'DXB', 'LHR', '09:15', '13:45', 0, 'europe', 'none', 'outbound'),
  f('QR7', 'Qatar Airways', 'LHR', 'DOH', '13:10', '21:10', 0, 'europe', 'none', 'outbound'),
  f('QR8', 'Qatar Airways', 'DOH', 'LHR', '07:30', '12:35', 0, 'europe', 'none', 'outbound'),
  // ── east-africa ──
  f('KQ2', 'Kenya Airways', 'JFK', 'NBO', '23:05', '21:05', 1, 'east-africa', 'east', 'outbound'),
  f('KQ3', 'Kenya Airways', 'NBO', 'JFK', '23:00', '07:45', 1, 'east-africa', 'east', 'return'),
  f('ET500', 'Ethiopian Airlines', 'IAD', 'ADD', '23:25', '19:45', 1, 'east-africa', 'east', 'outbound'),
  f('ET501', 'Ethiopian Airlines', 'ADD', 'IAD', '23:55', '06:40', 1, 'east-africa', 'east', 'return'),
  f('ET600', 'Ethiopian Airlines', 'ADD', 'DXB', '09:00', '13:45', 0, 'east-africa', 'none', 'outbound'),
  f('ET601', 'Ethiopian Airlines', 'DXB', 'ADD', '11:50', '14:40', 0, 'east-africa', 'none', 'outbound'),
  // ── west-africa ──
  f('DL59', 'Delta Air Lines', 'JFK', 'ACC', '20:30', '10:05', 1, 'west-africa', 'east', 'outbound'),
  f('DL58', 'Delta Air Lines', 'ACC', 'JFK', '22:55', '05:15', 1, 'west-africa', 'east', 'return'),
  f('DL57', 'Delta Air Lines', 'ATL', 'LOS', '21:00', '13:10', 1, 'west-africa', 'east', 'outbound'),
  f('DL56', 'Delta Air Lines', 'LOS', 'ATL', '23:00', '05:35', 1, 'west-africa', 'east', 'return'),
  f('EK783', 'Emirates', 'DXB', 'LOS', '09:25', '14:50', 0, 'west-africa', 'none', 'outbound'),
  f('EK784', 'Emirates', 'LOS', 'DXB', '23:55', '10:25', 1, 'west-africa', 'none', 'outbound'),
  // ── south-africa ──
  f('DL200', 'Delta Air Lines', 'ATL', 'JNB', '19:30', '16:55', 1, 'south-africa', 'east', 'outbound'),
  f('DL201', 'Delta Air Lines', 'JNB', 'ATL', '18:30', '05:15', 1, 'south-africa', 'east', 'return'),
  f('SA204', 'South African Airways', 'JFK', 'JNB', '19:55', '17:30', 1, 'south-africa', 'east', 'outbound'),
  f('SA203', 'South African Airways', 'JNB', 'JFK', '19:35', '05:05', 1, 'south-africa', 'east', 'return'),
  f('EK761', 'Emirates', 'DXB', 'JNB', '08:50', '15:25', 0, 'south-africa', 'none', 'outbound'),
  f('EK762', 'Emirates', 'JNB', 'DXB', '20:40', '06:45', 1, 'south-africa', 'none', 'outbound'),
  f('EK773', 'Emirates', 'DXB', 'CPT', '09:30', '16:45', 0, 'south-africa', 'none', 'outbound'),
  f('EK774', 'Emirates', 'CPT', 'DXB', '21:30', '08:00', 1, 'south-africa', 'none', 'outbound'),
  // ── south-america ──
  f('AA930', 'American Airlines', 'JFK', 'GRU', '21:35', '08:30', 1, 'south-america', 'east', 'outbound'),
  f('AA931', 'American Airlines', 'GRU', 'JFK', '22:45', '07:40', 1, 'south-america', 'east', 'return'),
  f('AA950', 'American Airlines', 'JFK', 'EZE', '21:20', '08:50', 1, 'south-america', 'east', 'outbound'),
  f('AA951', 'American Airlines', 'EZE', 'JFK', '21:50', '07:25', 1, 'south-america', 'east', 'return'),
  f('LA532', 'LATAM Airlines', 'JFK', 'SCL', '22:55', '10:55', 1, 'south-america', 'east', 'outbound'),
  f('LA533', 'LATAM Airlines', 'SCL', 'JFK', '23:15', '08:35', 1, 'south-america', 'east', 'return'),
  f('AV22', 'Avianca', 'JFK', 'BOG', '09:00', '13:25', 0, 'south-america', 'east', 'outbound'),
  f('AV21', 'Avianca', 'BOG', 'JFK', '10:35', '17:10', 0, 'south-america', 'east', 'return'),
  f('LA2465', 'LATAM Airlines', 'JFK', 'LIM', '23:30', '06:00', 1, 'south-america', 'east', 'outbound'),
  f('LA2466', 'LATAM Airlines', 'LIM', 'JFK', '00:30', '09:25', 0, 'south-america', 'east', 'return'),
  f('AV15', 'Avianca', 'LAX', 'BOG', '23:05', '07:45', 1, 'south-america', 'west', 'outbound'),
  f('AV16', 'Avianca', 'BOG', 'LAX', '01:20', '06:05', 0, 'south-america', 'west', 'return'),
  f('EK247', 'Emirates', 'DXB', 'GRU', '02:50', '10:25', 0, 'south-america', 'none', 'outbound'),
  f('EK248', 'Emirates', 'GRU', 'DXB', '23:00', '19:30', 1, 'south-america', 'none', 'outbound'),
  // ── australia ──
  f('QF12', 'Qantas', 'LAX', 'SYD', '22:35', '07:10', 2, 'australia', 'west', 'outbound'),
  f('QF11', 'Qantas', 'SYD', 'LAX', '10:45', '05:55', 0, 'australia', 'west', 'return'),
  f('QF94', 'Qantas', 'LAX', 'MEL', '22:30', '08:05', 2, 'australia', 'west', 'outbound'),
  f('QF93', 'Qantas', 'MEL', 'LAX', '11:25', '07:45', 0, 'australia', 'west', 'return'),
  f('UA839', 'United Airlines', 'SFO', 'SYD', '22:15', '07:15', 2, 'australia', 'west', 'outbound'),
  f('UA840', 'United Airlines', 'SYD', 'SFO', '11:30', '07:00', 0, 'australia', 'west', 'return'),
  f('UA100', 'United Airlines', 'SFO', 'BNE', '22:50', '06:20', 2, 'australia', 'west', 'outbound'),
  f('UA101', 'United Airlines', 'BNE', 'SFO', '11:50', '07:50', 0, 'australia', 'west', 'return'),
  f('EK412', 'Emirates', 'DXB', 'SYD', '10:00', '07:00', 1, 'australia', 'none', 'outbound'),
  f('EK413', 'Emirates', 'SYD', 'DXB', '18:25', '01:40', 1, 'australia', 'none', 'outbound'),
  f('EK408', 'Emirates', 'DXB', 'MEL', '09:50', '06:40', 1, 'australia', 'none', 'outbound'),
  f('EK407', 'Emirates', 'MEL', 'DXB', '21:25', '04:25', 1, 'australia', 'none', 'outbound'),
  f('EK430', 'Emirates', 'DXB', 'BNE', '09:45', '05:50', 1, 'australia', 'none', 'outbound'),
  f('EK431', 'Emirates', 'BNE', 'DXB', '21:55', '06:05', 1, 'australia', 'none', 'outbound'),
  // ── new-zealand ──
  f('NZ6', 'Air New Zealand', 'SFO', 'AKL', '20:25', '05:20', 2, 'new-zealand', 'west', 'outbound'),
  f('NZ5', 'Air New Zealand', 'AKL', 'SFO', '12:20', '04:00', 0, 'new-zealand', 'west', 'return'),
  f('NZ2', 'Air New Zealand', 'LAX', 'AKL', '22:00', '07:10', 2, 'new-zealand', 'west', 'outbound'),
  f('NZ1', 'Air New Zealand', 'AKL', 'LAX', '11:10', '03:10', 0, 'new-zealand', 'west', 'return'),
  f('NZ8', 'Air New Zealand', 'JFK', 'AKL', '16:50', '03:20', 2, 'new-zealand', 'east', 'outbound'),
  f('NZ7', 'Air New Zealand', 'AKL', 'JFK', '09:45', '09:05', 0, 'new-zealand', 'east', 'return'),
  // ── polar ──
  f('SQ21', 'Singapore Airlines', 'EWR', 'SIN', '10:00', '16:45', 1, 'polar', 'east', 'outbound', 'Long-range polar routing'),
  f('SQ22', 'Singapore Airlines', 'SIN', 'EWR', '08:35', '15:15', 0, 'polar', 'east', 'return', 'Long-range polar routing'),
  f('CX840', 'Cathay Pacific', 'JFK', 'HKG', '01:10', '04:55', 1, 'polar', 'east', 'outbound', 'Polar routing over the Arctic'),
  f('CX841', 'Cathay Pacific', 'HKG', 'JFK', '01:05', '05:05', 0, 'polar', 'east', 'return', 'Polar routing over the Arctic'),
  f('AA177', 'American Airlines', 'DFW', 'HKG', '00:15', '05:30', 1, 'polar', 'none', 'outbound', 'Polar routing over the Arctic'),
  f('AA178', 'American Airlines', 'HKG', 'DFW', '00:30', '04:10', 0, 'polar', 'none', 'return', 'Polar routing over the Arctic'),
  // ── southeast-asia ──
  f('SQ32', 'Singapore Airlines', 'SFO', 'SIN', '23:45', '08:00', 2, 'southeast-asia', 'west', 'outbound'),
  f('SQ31', 'Singapore Airlines', 'SIN', 'SFO', '09:30', '10:25', 0, 'southeast-asia', 'west', 'return'),
  f('PR102', 'Philippine Airlines', 'MNL', 'SFO', '10:30', '07:55', 0, 'southeast-asia', 'west', 'return'),
  f('PR103', 'Philippine Airlines', 'SFO', 'MNL', '23:35', '05:05', 2, 'southeast-asia', 'west', 'outbound'),
  f('PR126', 'Philippine Airlines', 'MNL', 'JFK', '10:15', '15:20', 0, 'southeast-asia', 'east', 'return'),
  f('PR127', 'Philippine Airlines', 'JFK', 'MNL', '00:10', '04:45', 1, 'southeast-asia', 'east', 'outbound'),
  f('EK343', 'Emirates', 'DXB', 'KUL', '03:30', '14:45', 0, 'southeast-asia', 'none', 'outbound'),
  f('EK344', 'Emirates', 'KUL', 'DXB', '01:15', '05:05', 0, 'southeast-asia', 'none', 'outbound'),
  // ── east-asia ──
  f('CX872', 'Cathay Pacific', 'SFO', 'HKG', '01:20', '07:30', 1, 'east-asia', 'west', 'outbound'),
  f('CX873', 'Cathay Pacific', 'HKG', 'SFO', '23:55', '21:40', 0, 'east-asia', 'west', 'return'),
  f('CX880', 'Cathay Pacific', 'LAX', 'HKG', '01:00', '07:40', 1, 'east-asia', 'west', 'outbound'),
  f('CX881', 'Cathay Pacific', 'HKG', 'LAX', '23:40', '21:20', 0, 'east-asia', 'west', 'return'),
  f('JL6', 'Japan Airlines', 'JFK', 'HND', '11:00', '14:05', 1, 'east-asia', 'east', 'outbound'),
  f('JL5', 'Japan Airlines', 'HND', 'JFK', '11:00', '10:30', 0, 'east-asia', 'east', 'return'),
  f('NH10', 'ANA', 'JFK', 'HND', '11:20', '14:30', 1, 'east-asia', 'east', 'outbound'),
  f('NH9', 'ANA', 'HND', 'JFK', '23:10', '22:45', 0, 'east-asia', 'east', 'return'),
  f('UA837', 'United Airlines', 'SFO', 'HND', '11:25', '14:50', 1, 'east-asia', 'west', 'outbound'),
  f('UA838', 'United Airlines', 'HND', 'SFO', '18:05', '11:50', 0, 'east-asia', 'west', 'return'),
  f('NH106', 'ANA', 'LAX', 'HND', '12:30', '16:20', 1, 'east-asia', 'west', 'outbound'),
  f('NH105', 'ANA', 'HND', 'LAX', '23:50', '18:10', 0, 'east-asia', 'west', 'return'),
  f('UA79', 'United Airlines', 'EWR', 'NRT', '11:35', '14:50', 1, 'east-asia', 'east', 'outbound'),
  f('UA78', 'United Airlines', 'NRT', 'EWR', '17:35', '17:30', 0, 'east-asia', 'east', 'return'),
  f('KE82', 'Korean Air', 'JFK', 'ICN', '11:30', '15:20', 1, 'east-asia', 'east', 'outbound'),
  f('KE81', 'Korean Air', 'ICN', 'JFK', '10:00', '11:00', 0, 'east-asia', 'east', 'return'),
  f('KE12', 'Korean Air', 'LAX', 'ICN', '12:00', '16:45', 1, 'east-asia', 'west', 'outbound'),
  f('KE11', 'Korean Air', 'ICN', 'LAX', '17:00', '12:35', 0, 'east-asia', 'west', 'return'),
  f('KE24', 'Korean Air', 'SFO', 'ICN', '11:55', '16:50', 1, 'east-asia', 'west', 'outbound'),
  f('KE23', 'Korean Air', 'ICN', 'SFO', '17:45', '12:30', 0, 'east-asia', 'west', 'return'),
  f('BR12', 'EVA Air', 'LAX', 'TPE', '00:40', '05:20', 1, 'east-asia', 'west', 'outbound'),
  f('BR11', 'EVA Air', 'TPE', 'LAX', '17:00', '13:45', 0, 'east-asia', 'west', 'return'),
  f('BR8', 'EVA Air', 'SFO', 'TPE', '00:55', '05:15', 1, 'east-asia', 'west', 'outbound'),
  f('BR7', 'EVA Air', 'TPE', 'SFO', '17:10', '13:20', 0, 'east-asia', 'west', 'return'),
  f('MU587', 'China Eastern', 'LAX', 'PVG', '23:30', '03:55', 2, 'east-asia', 'west', 'outbound'),
  f('MU588', 'China Eastern', 'PVG', 'LAX', '13:30', '10:05', 0, 'east-asia', 'west', 'return'),
  f('UA857', 'United Airlines', 'SFO', 'PVG', '13:00', '16:50', 1, 'east-asia', 'west', 'outbound'),
  f('UA858', 'United Airlines', 'PVG', 'SFO', '13:50', '09:50', 0, 'east-asia', 'west', 'return'),
  // ── domestic-us ──
  f('AA1', 'American Airlines', 'JFK', 'LAX', '08:00', '11:20', 0, 'domestic-us', 'east', 'outbound'),
  f('AA2', 'American Airlines', 'LAX', 'JFK', '08:30', '16:35', 0, 'domestic-us', 'west', 'outbound'),
  f('UA1', 'United Airlines', 'EWR', 'SFO', '08:00', '11:25', 0, 'domestic-us', 'east', 'outbound'),
  f('UA2', 'United Airlines', 'SFO', 'EWR', '08:35', '16:50', 0, 'domestic-us', 'west', 'outbound'),];

export interface SampleItinerary {
  id: string;
  title: string;
  /** dayOffset is in days from the trip start date (departure local date of the first leg). */
  legs: { flightNumber: string; dayOffset: number }[];
}

export const SAMPLE_ITINERARIES: SampleItinerary[] = [
  { id: 'khi-dxb-sfo', title: 'Karachi → Dubai → San Francisco (Emirates)', legs: [
    { flightNumber: 'EK601', dayOffset: 0 }, { flightNumber: 'EK225', dayOffset: 0 } ] },
  { id: 'sfo-dxb-khi', title: 'San Francisco → Dubai → Karachi (Emirates, Arctic routing)', legs: [
    { flightNumber: 'EK226', dayOffset: 0 }, { flightNumber: 'EK600', dayOffset: 2 } ] },
  { id: 'khi-doh-sfo', title: 'Karachi → Doha → San Francisco (Qatar Airways)', legs: [
    { flightNumber: 'QR605', dayOffset: 0 }, { flightNumber: 'QR735', dayOffset: 0 } ] },
  { id: 'sfo-doh-khi', title: 'San Francisco → Doha → Karachi (Qatar Airways)', legs: [
    { flightNumber: 'QR736', dayOffset: 0 }, { flightNumber: 'QR608', dayOffset: 1 } ] },
  { id: 'khi-ist-sfo', title: 'Karachi → Istanbul → San Francisco (Turkish Airlines)', legs: [
    { flightNumber: 'TK708', dayOffset: 0 }, { flightNumber: 'TK79', dayOffset: 0 } ] },
  { id: 'sfo-ist-khi', title: 'San Francisco → Istanbul → Karachi (Turkish Airlines)', legs: [
    { flightNumber: 'TK80', dayOffset: 0 }, { flightNumber: 'TK709', dayOffset: 2 } ] },
  { id: 'jfk-doh-khi', title: 'New York → Doha → Karachi (Qatar Airways)', legs: [
    { flightNumber: 'QR702', dayOffset: 0 }, { flightNumber: 'QR608', dayOffset: 1 } ] },
  { id: 'khi-dxb-jfk', title: 'Karachi → Dubai → New York (Emirates)', legs: [
    { flightNumber: 'EK601', dayOffset: 0 }, { flightNumber: 'EK204', dayOffset: 0 } ] },
  { id: 'sfo-lhr-dxb-khi', title: 'San Francisco → London → Dubai → Karachi', legs: [
    { flightNumber: 'BA283', dayOffset: 0 }, { flightNumber: 'EK2', dayOffset: 1 }, { flightNumber: 'EK600', dayOffset: 2 } ] },
  { id: 'lax-syd', title: 'Los Angeles → Sydney (Qantas, crosses the date line)', legs: [
    { flightNumber: 'QF12', dayOffset: 0 } ] },
  { id: 'jfk-jnb', title: 'New York → Johannesburg (South African)', legs: [
    { flightNumber: 'SA204', dayOffset: 0 } ] },
  { id: 'sfo-akl', title: 'San Francisco → Auckland (Air New Zealand)', legs: [
    { flightNumber: 'NZ6', dayOffset: 0 } ] },
  { id: 'jfk-hkg-polar', title: 'New York → Hong Kong (Cathay Pacific, polar route)', legs: [
    { flightNumber: 'CX840', dayOffset: 0 } ] },
  { id: 'ewr-sin-polar', title: 'Newark → Singapore (Singapore Airlines, polar route)', legs: [
    { flightNumber: 'SQ21', dayOffset: 0 } ] },
];

// ───────────────────────────── lookup ─────────────────────────────

export function normalizeFlightNumber(s: string): string {
  return (s ?? '').replace(/[\s-]+/g, '').toUpperCase();
}

let byNumber: Map<string, LibraryFlight> | null = null;

/** Case/space-insensitive lookup: 'ek 226' === 'EK226'. */
export function findLibraryFlight(flightNumber: string): LibraryFlight | undefined {
  if (!byNumber) {
    byNumber = new Map();
    for (const fl of FLIGHT_LIBRARY) byNumber.set(normalizeFlightNumber(fl.flightNumber), fl);
  }
  return byNumber.get(normalizeFlightNumber(flightNumber));
}

// ───────────────────────────── local time → UTC ─────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function tzOffsetMs(tz: string, utcMs: number): number {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    dtfCache.set(tz, dtf);
  }
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in an IANA zone → UTC ms. DST-correct (gaps resolve forward, overlaps to the first occurrence). */
function wallToUtcMs(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two fixed-point iterations settle on the right offset on both sides of a transition.
  let t = naive - tzOffsetMs(tz, naive);
  t = naive - tzOffsetMs(tz, t);
  return t;
}

function parseDate(s: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parseTime(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid time "${s}", expected HH:mm`);
  return [Number(m[1]), Number(m[2])];
}

function addDays(date: string, days: number): [number, number, number] {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function ymd(parts: [number, number, number]): string {
  return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}`;
}

export function libraryFlightToLeg(
  fl: LibraryFlight,
  depLocalDate: string,
  resolve: (iata: string) => Airport | undefined,
  id?: string,
): FlightLeg {
  const from = resolve(fl.from);
  const to = resolve(fl.to);
  if (!from) throw new Error(`Unknown airport ${fl.from} for ${fl.flightNumber}`);
  if (!to) throw new Error(`Unknown airport ${fl.to} for ${fl.flightNumber}`);

  const [dy, dm, dd] = addDays(depLocalDate, 0);
  const [dh, dmi] = parseTime(fl.depLocal);
  const departureMs = wallToUtcMs(from.tz, dy, dm, dd, dh, dmi);

  const [ay, am, ad] = addDays(depLocalDate, fl.arrDayOffset);
  const [ah, ami] = parseTime(fl.arrLocal);
  let arrivalMs = wallToUtcMs(to.tz, ay, am, ad, ah, ami);
  // Guard against inconsistent data around DST changes: arrival must follow departure.
  if (arrivalMs <= departureMs) arrivalMs += 24 * 3600 * 1000;

  return {
    id: id ?? `${fl.flightNumber}-${ymd([dy, dm, dd])}`,
    flightNumber: fl.flightNumber,
    from: fl.from,
    to: fl.to,
    departureUtc: new Date(departureMs),
    arrivalUtc: new Date(arrivalMs),
  };
}

export function itineraryToLegs(
  it: SampleItinerary,
  startDate: string,
  resolve: (iata: string) => Airport | undefined,
): FlightLeg[] {
  return it.legs.map((l, i) => {
    const fl = findLibraryFlight(l.flightNumber);
    if (!fl) throw new Error(`Flight ${l.flightNumber} (itinerary ${it.id}) not in library`);
    return libraryFlightToLeg(fl, ymd(addDays(startDate, l.dayOffset)), resolve, `${it.id}-${i + 1}`);
  });
}
