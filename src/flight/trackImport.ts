import type { TrackPoint } from '../types';

const FT_TO_M = 0.3048;

/**
 * Parse an imported flight track (KML, GPX, Flightradar24 CSV or generic CSV) into points.
 * Pure string/regex parsing so it works in Node tests and in the browser alike.
 * Invalid points are dropped; points are sorted by time when every point has one.
 */
export function parseTrackFile(text: string, filename: string): TrackPoint[] {
  const src = (text ?? '').replace(/^﻿/, '');
  if (!src.trim()) throw new Error(`"${filename}" is empty.`);
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const head = src.slice(0, 4000).toLowerCase();
  const looksXml = src.trimStart().startsWith('<');

  let raw: TrackPoint[];
  let kind: string;
  if (ext === 'gpx' || (looksXml && /<gpx[\s>]/.test(head)) || (looksXml && /<(trkpt|rtept)[\s>]/.test(src))) {
    raw = parseGpx(src);
    kind = 'GPX';
  } else if (ext === 'kml' || (looksXml && /<kml[\s>]|<gx:track|<linestring/.test(head + src.slice(0, 20000).toLowerCase()))) {
    raw = parseKml(src);
    kind = 'KML';
  } else if (looksXml) {
    // Unknown XML flavour: try both.
    raw = parseGpx(src);
    kind = 'GPX';
    if (raw.length === 0) { raw = parseKml(src); kind = 'KML'; }
  } else {
    raw = parseCsv(src);
    kind = 'CSV';
  }

  const pts = raw.filter(isValidPoint);
  if (pts.length < 2) {
    throw new Error(
      pts.length === 0
        ? `Could not find any valid track points in "${filename}" (read as ${kind}). Supported: KML, GPX and CSV with latitude/longitude columns (Flightradar24 exports work).`
        : `Only ${pts.length} valid track point was found in "${filename}"; a track needs at least 2.`,
    );
  }
  // Sort only when every point carries a time; otherwise file order is the path order.
  if (pts.every((p) => p.time)) {
    return pts
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.time!.getTime() - b.p.time!.getTime() || a.i - b.i)
      .map((x) => x.p);
  }
  return pts;
}

function isValidPoint(p: TrackPoint): boolean {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return false;
  if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return false;
  if (p.lat === 0 && p.lon === 0) return false; // "null island" is almost always a missing fix
  if (p.altitudeM !== undefined && !Number.isFinite(p.altitudeM)) delete p.altitudeM;
  if (p.time && Number.isNaN(p.time.getTime())) delete p.time;
  return true;
}

function mk(lat: number, lon: number, alt?: number, time?: Date): TrackPoint {
  const p: TrackPoint = { lat, lon };
  if (alt !== undefined && Number.isFinite(alt)) p.altitudeM = alt;
  if (time && !Number.isNaN(time.getTime())) p.time = time;
  return p;
}

function parseTime(s: string | undefined): Date | undefined {
  if (s === undefined) return undefined;
  const v = s.trim();
  if (!v) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return new Date(n > 1e11 ? n : n * 1000); // > 1e11 → already milliseconds
  }
  // "YYYY-MM-DD HH:MM[:SS]" without zone: treat as UTC, not the machine's local time.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(v);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ───────────────────────────── KML ─────────────────────────────

function parseKml(src: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  // 1. <gx:Track>: parallel <when> and <gx:coord> lists.
  const trackRe = /<gx:Track\b[^>]*>([\s\S]*?)<\/gx:Track>/gi;
  let m: RegExpExecArray | null;
  while ((m = trackRe.exec(src))) {
    const body = m[1];
    const whens = [...body.matchAll(/<when>\s*([^<]*?)\s*<\/when>/gi)].map((x) => x[1]);
    const coords = [...body.matchAll(/<(?:gx:)?coord>\s*([^<]*?)\s*<\/(?:gx:)?coord>/gi)].map((x) => x[1]);
    for (let i = 0; i < coords.length; i++) {
      const [lon, lat, alt] = coords[i].split(/[\s,]+/).map(Number);
      out.push(mk(lat, lon, Number.isNaN(alt) ? undefined : alt, parseTime(whens[i])));
    }
  }
  if (out.length) return out;
  // 2. <LineString><coordinates>lon,lat,alt ...</coordinates> (Point placemarks are ignored on purpose).
  const lsRe = /<LineString\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi;
  while ((m = lsRe.exec(src))) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok) continue;
      const [lon, lat, alt] = tok.split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
      out.push(mk(lat, lon, alt));
    }
  }
  return out;
}

// ───────────────────────────── GPX ─────────────────────────────

function parseGpx(src: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const attrs = m[2];
    const lat = Number(/\blat\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
    const body = m[3] ?? '';
    const ele = /<ele>\s*([^<]*?)\s*<\/ele>/i.exec(body)?.[1];
    const time = /<time>\s*([^<]*?)\s*<\/time>/i.exec(body)?.[1];
    out.push(mk(lat, lon, ele !== undefined && ele !== '' ? Number(ele) : undefined, parseTime(time)));
  }
  return out;
}

// ───────────────────────────── CSV ─────────────────────────────

function splitCsvLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function detectDelimiter(header: string): string {
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t']) {
    const n = splitCsvLine(header, d).length;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

const clean = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function findCol(headers: string[], exact: string[], contains: string[] = []): number {
  const cl = headers.map(clean);
  for (const e of exact) { const i = cl.indexOf(e); if (i >= 0) return i; }
  for (const c of contains) { const i = cl.findIndex((h) => h.includes(c)); if (i >= 0) return i; }
  return -1;
}

function parseCsv(src: string): TrackPoint[] {
  const lines = src.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const delim = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delim);

  const latC = findCol(headers, ['lat', 'latitude'], ['latitude']);
  const lonC = findCol(headers, ['lon', 'lng', 'long', 'longitude'], ['longitude']);
  const posC = findCol(headers, ['position', 'latlon', 'latlng', 'coordinates', 'coords']);
  const hasLL = latC >= 0 && lonC >= 0;
  if (!hasLL && posC < 0) {
    throw new Error('CSV needs latitude/longitude columns (e.g. "lat,lon") or a Flightradar24 "Position" column.');
  }
  // Flightradar24: "Timestamp,UTC,Callsign,Position,Altitude,Speed,Direction" — altitude is in feet.
  const cl = headers.map(clean);
  const isFr24 = !hasLL && posC >= 0 && cl.includes('timestamp');
  const altC = findCol(headers, ['altitude', 'alt', 'altm', 'altft', 'baroaltitude', 'geoaltitude', 'elevation', 'ele'], ['alt']);
  let altFactor = 1;
  if (altC >= 0) {
    const h = headers[altC].toLowerCase();
    if (/\b(ft|feet|foot)\b|_ft\b|ft$/.test(h) || (isFr24 && !/\b(m|meters?|metres?)\b|_m\b/.test(h))) altFactor = FT_TO_M;
  }
  const timeC = findCol(
    headers,
    isFr24 ? ['timestamp'] : ['timestamp', 'time', 'timeutc', 'utc', 'datetime', 'date', 'timestamputc', 'epoch'],
    ['timestamp', 'time'],
  );

  const out: TrackPoint[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r], delim);
    let lat: number, lon: number;
    if (hasLL) {
      lat = Number(cells[latC]);
      lon = Number(cells[lonC]);
    } else {
      const parts = (cells[posC] ?? '').split(/[\s,;]+/).filter(Boolean);
      lat = Number(parts[0]);
      lon = Number(parts[1]);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let alt: number | undefined;
    if (altC >= 0 && (cells[altC] ?? '') !== '') {
      const a = Number(cells[altC]);
      if (Number.isFinite(a)) alt = a * altFactor;
    }
    let time = timeC >= 0 ? parseTime(cells[timeC]) : undefined;
    if (!time && isFr24) time = parseTime(cells[findCol(headers, ['utc'])]); // fall back to the ISO column
    out.push(mk(lat, lon, alt, time));
  }
  return out;
}
