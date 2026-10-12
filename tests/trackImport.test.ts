import { describe, expect, it } from 'vitest';
import { parseTrackFile } from '../src/flight/trackImport';

const KML_GX = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><Placemark><name>EK 607</name>
<gx:Track>
<when>2026-10-12T16:40:00Z</when><when>2026-10-12T16:50:00Z</when><when>2026-10-12T17:00:00Z</when>
<gx:coord>67.16 24.90 30</gx:coord>
<gx:coord>64.00 25.10 9000</gx:coord>
<gx:coord>60.00 25.30 10600</gx:coord>
</gx:Track></Placemark></Document></kml>`;

const KML_LS = `<kml><Document>
<Placemark><name>Airport</name><Point><coordinates>67.16,24.90,0</coordinates></Point></Placemark>
<Placemark><LineString><tessellate>1</tessellate><coordinates>
 67.16,24.90,0 64.0,25.1,9000
 60.0,25.3,10600
 </coordinates></LineString></Placemark></kml>`;

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="x"><trk><name>t</name><trkseg>
<trkpt lat="24.9" lon="67.1"><ele>20</ele><time>2026-10-12T16:40:00Z</time></trkpt>
<trkpt lat="25.1" lon="64.0"><ele>9000.5</ele><time>2026-10-12T16:50:00Z</time></trkpt>
<trkpt lat="25.3" lon="60.0"/>
<trkpt lat="95" lon="60.0"><ele>1</ele></trkpt>
<trkpt lat="25.4" lon="58.0"><time>2026-10-12T17:10:00Z</time></trkpt>
</trkseg></trk></gpx>`;

const FR24 = `Timestamp,UTC,Callsign,Position,Altitude,Speed,Direction
1760287200,2026-10-12T16:40:00Z,UAE607,"24.9065,67.1608",0,0,270
1760287800,2026-10-12T16:50:00Z,UAE607,"25.1,64.0",30000,450,275
1760288400,2026-10-12T17:00:00Z,UAE607,"25.3,60.0",35000,480,276
`;

describe('parseTrackFile', () => {
  it('KML gx:Track with when/coord (lon lat alt order)', () => {
    const p = parseTrackFile(KML_GX, 'flight.kml');
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ lat: 24.9, lon: 67.16, altitudeM: 30 });
    expect(p[0].time!.toISOString()).toBe('2026-10-12T16:40:00.000Z');
    expect(p[2]).toMatchObject({ lat: 25.3, lon: 60, altitudeM: 10600 });
  });

  it('KML LineString coordinates (ignores Point placemarks)', () => {
    const p = parseTrackFile(KML_LS, 'track.kml');
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ lat: 24.9, lon: 67.16, altitudeM: 0 });
    expect(p[1]).toMatchObject({ lat: 25.1, lon: 64, altitudeM: 9000 });
    expect(p[0].time).toBeUndefined();
  });

  it('GPX trkpt with ele/time, self-closing points and invalid points dropped', () => {
    const p = parseTrackFile(GPX, 'x.gpx');
    expect(p).toHaveLength(4); // lat=95 dropped
    expect(p[1].altitudeM).toBe(9000.5);
    expect(p[2].altitudeM).toBeUndefined();
    expect(p[2].time).toBeUndefined();
    expect(p[3]).toMatchObject({ lat: 25.4, lon: 58 });
  });

  it('Flightradar24 CSV: quoted "lat,lon" position and altitude in feet → metres', () => {
    const p = parseTrackFile(FR24, 'UAE607.csv');
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ lat: 24.9065, lon: 67.1608, altitudeM: 0 });
    expect(p[1].altitudeM).toBeCloseTo(30000 * 0.3048, 6);
    expect(p[2].altitudeM).toBeCloseTo(10668, 6);
    expect(p[1].time!.getTime()).toBe(1760287800 * 1000);
  });

  it('FR24 CSV with CRLF and BOM', () => {
    const p = parseTrackFile('﻿' + FR24.replace(/\n/g, '\r\n'), 'a.csv');
    expect(p).toHaveLength(3);
  });

  it('generic CSV: lat/lon/alt (metres) and unix seconds', () => {
    const csv = 'time,lat,lon,alt\n1760287200,24.9,67.1,10\n1760287800,25.1,64.0,9000\n1760288400,25.3,60.0,10500\n';
    const p = parseTrackFile(csv, 'gen.csv');
    expect(p).toHaveLength(3);
    expect(p[1].altitudeM).toBe(9000);
    expect(p[1].time!.getTime()).toBe(1760287800000);
  });

  it('generic CSV: latitude/longitude/altitude_ft + ISO time, semicolons, and shuffled order sorted by time', () => {
    const csv = 'Latitude;Longitude;Altitude (ft);Time (UTC)\n25.3;60.0;35000;2026-10-12 17:00:00\n24.9;67.1;0;2026-10-12 16:40:00\n25.1;64.0;30000;2026-10-12T16:50:00Z\n';
    const p = parseTrackFile(csv, 'gen.csv');
    expect(p.map((x) => x.lat)).toEqual([24.9, 25.1, 25.3]);
    expect(p[1].altitudeM).toBeCloseTo(9144, 6);
    expect(p[0].time!.toISOString()).toBe('2026-10-12T16:40:00.000Z'); // zone-less timestamps are UTC
  });

  it('generic CSV with lng header and no altitude/time keeps file order', () => {
    const p = parseTrackFile('lng,lat\n10,20\n11,21\n12,22\nbad,row\n', 'g.csv');
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual({ lat: 20, lon: 10 });
  });

  it('sniffs the format when the extension is unhelpful', () => {
    expect(parseTrackFile(GPX, 'track.txt')).toHaveLength(4);
    expect(parseTrackFile(KML_GX, 'track.xml')).toHaveLength(3);
    expect(parseTrackFile(FR24, 'track.txt')).toHaveLength(3);
  });

  it('drops null-island and out-of-range points', () => {
    const p = parseTrackFile('lat,lon\n0,0\n10,20\n91,20\n10,200\n11,21\n', 'g.csv');
    expect(p).toEqual([{ lat: 10, lon: 20 }, { lat: 11, lon: 21 }]);
  });

  it('throws friendly errors when nothing is parseable', () => {
    expect(() => parseTrackFile('', 'a.csv')).toThrow(/empty/);
    expect(() => parseTrackFile('hello world', 'a.txt')).toThrow(/latitude\/longitude|Position/);
    expect(() => parseTrackFile('<gpx></gpx>', 'a.gpx')).toThrow(/Could not find/);
    expect(() => parseTrackFile('<kml><Document></Document></kml>', 'a.kml')).toThrow(/Could not find/);
    expect(() => parseTrackFile('lat,lon\nx,y\n', 'a.csv')).toThrow(/Could not find/);
    expect(() => parseTrackFile('lat,lon\n10,20\n', 'a.csv')).toThrow(/at least 2/);
  });
});
