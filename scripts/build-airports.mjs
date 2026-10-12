#!/usr/bin/env node
/**
 * Build src/data/airports.json from the OurAirports public-domain dataset.
 *
 *   npm run build:airports            (downloads the CSV)
 *   node scripts/build-airports.mjs path/to/airports.csv   (use a local copy)
 *
 * Keeps airports with a 3-letter IATA code that are large/medium airports, or
 * any non-closed, non-heliport airport with scheduled service. The IANA time
 * zone is resolved with `tz-lookup` (CC0). Output is a compact columnar JSON.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tzlookup from 'tz-lookup';

const CSV_URL =
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src/data/airports.json');

/** RFC-4180 style CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const RANK = { large_airport: 3, medium_airport: 2, small_airport: 1 };

async function loadCsv() {
  const arg = process.argv[2];
  if (arg) return readFile(arg, 'utf8');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return res.text();
}

async function main() {
  const text = await loadCsv();
  const table = parseCsv(text);
  const header = table.shift();
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const k of [
    'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'iso_country',
    'municipality', 'scheduled_service', 'icao_code', 'ident', 'iata_code',
  ]) {
    if (!(k in col)) throw new Error(`CSV missing column ${k}`);
  }

  /** @type {Map<string, {rank:number, sched:boolean, row:any[]}>} */
  const best = new Map();
  let tzFailures = 0;
  for (const r of table) {
    const iata = (r[col.iata_code] || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    const type = r[col.type];
    if (type === 'closed' || type === 'heliport' || type === 'seaplane_base' && r[col.scheduled_service] !== 'yes') continue;
    const sched = r[col.scheduled_service] === 'yes';
    const keep = type === 'large_airport' || type === 'medium_airport' || sched;
    if (!keep) continue;
    const lat = parseFloat(r[col.latitude_deg]);
    const lon = parseFloat(r[col.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const rank = RANK[type] ?? 0;
    const prev = best.get(iata);
    // prefer large > medium > small, then scheduled service
    if (prev && (prev.rank > rank || (prev.rank === rank && prev.sched >= sched))) continue;

    let tz;
    try {
      tz = tzlookup(lat, lon);
    } catch {
      tzFailures++;
      continue;
    }
    const elevFt = parseFloat(r[col.elevation_ft]);
    const elevationM = Number.isFinite(elevFt) ? Math.round(elevFt * 0.3048) : 0;
    const icao = (r[col.icao_code] || (/^[A-Z]{4}$/.test(r[col.ident]) ? r[col.ident] : '') || '').trim();
    best.set(iata, {
      rank,
      sched,
      row: [
        iata,
        icao,
        r[col.name].trim(),
        (r[col.municipality] || '').trim(),
        r[col.iso_country].trim(),
        Math.round(lat * 1e4) / 1e4,
        Math.round(lon * 1e4) / 1e4,
        elevationM,
        tz,
      ],
    });
  }

  const rows = [...best.values()].map((v) => v.row).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = {
    fields: ['iata', 'icao', 'name', 'city', 'country', 'lat', 'lon', 'elevationM', 'tz'],
    rows,
  };
  await mkdir(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(OUT, json + '\n');
  console.log(
    `Wrote ${rows.length} airports to ${OUT} (${(json.length / 1024).toFixed(0)} KiB)` +
      (tzFailures ? `; ${tzFailures} skipped (tz lookup failed)` : ''),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
