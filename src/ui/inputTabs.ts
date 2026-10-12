/** The three ways of filling the legs editor: photo / PDF, pasted text, sample routes. */
import type { AirportApi } from './airportInput';
import { h, setChildren, uid, todayIso, clear } from './dom';
import { type LegDraft, legToDraft } from './model';
import { parsedToDrafts, type ParsedLike } from './parsed';
import { createTabs, type TabsHandle } from './tabs';
import { createPhotoPanel } from './photoPanel';
import { parseRoute, type HealthResponse } from '../api/client';
import {
  FLIGHT_LIBRARY,
  SAMPLE_ITINERARIES,
  findSampleItinerary,
  itineraryToLegs,
  libraryFlightToLeg,
  type LibraryFlight,
  type RouteRegion,
} from '../data/flights';

export interface InputContext {
  api: AirportApi;
  /** Replace the editor content. `calculate` runs the computation straight away (trusted data only). */
  setLegs(legs: LegDraft[], opts?: { review?: boolean; message?: string; calculate?: boolean }): void;
  addLeg(leg: LegDraft): void;
  announce(text: string): void;
}

export interface InputTabs {
  el: HTMLElement;
  tabs: TabsHandle;
  setBackend(health: HealthResponse | null): void;
  /** Release object URLs, listeners and any reading in progress. */
  dispose(): void;
}

async function parseLocal(text: string, api: AirportApi): Promise<ParsedLike[]> {
  const { parseItineraryText } = await import('../ocr/parseItinerary');
  return parseItineraryText(text, { isKnownIata: (c) => !!api.getAirport(c), referenceDate: new Date() });
}

// ───────────────────────────── paste tab ─────────────────────────────

function createPastePanel(ctx: InputContext): { el: HTMLElement; setBackend(hh: HealthResponse | null): void } {
  const id = uid('paste');
  const ta = h('textarea', {
    id, rows: 8, class: 'mono', spellcheck: 'false',
    placeholder: 'Paste your e-ticket or booking text, e.g.\nEK 601  KHI 02:55 → DXB 04:20  12 Oct 2026\nEK 225  DXB 09:55 → SFO 15:05',
  });
  const aiId = uid('paste-ai');
  const aiCheck = h('input', { type: 'checkbox', id: aiId });
  const aiRow = h('div', { class: 'check', hidden: true }, aiCheck, h('label', { for: aiId }, 'Also use AI to read it (the text is sent to your backend)'));
  const status = h('div', { class: 'status-line', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'btn primary', onClick: () => void run() }, 'Read itinerary');

  async function run(): Promise<void> {
    const text = ta.value;
    if (!text.trim()) {
      setChildren(status, 'Paste some text first.');
      return;
    }
    btn.disabled = true;
    setChildren(status, 'Reading…');
    try {
      let parsed: ParsedLike[] | null = null;
      let source = 'Text parser';
      if (aiCheck.checked && !aiRow.hidden) {
        try {
          const res = await parseRoute(text, { referenceDate: todayIso() });
          parsed = res.legs;
          source = `AI (${res.model})`;
          if (res.legs.length === 1 && res.waypoints.length > 0) {
            // Carry explicit waypoints over to the only leg.
            const drafts = parsedToDrafts(res.legs, ctx.api.getAirport);
            drafts[0].waypoints = res.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
            ctx.setLegs(drafts, { review: true, message: 'Read by AI from your text.' });
            setChildren(status, `${source}: found 1 flight with ${res.waypoints.length} waypoints. Review it below.`);
            return;
          }
        } catch (e) {
          setChildren(status, `AI reading failed (${e instanceof Error ? e.message : 'error'}); using the on-device parser.`);
        }
      }
      if (!parsed) parsed = await parseLocal(text, ctx.api);
      if (parsed.length === 0) {
        setChildren(status, 'No flights were recognised. Try including flight numbers, airport codes and times, or enter the legs by hand.');
        return;
      }
      const drafts = parsedToDrafts(parsed, ctx.api.getAirport);
      ctx.setLegs(drafts, { review: true, message: 'Read from your text. Check every airport, date and time.' });
      setChildren(status, `${source}: found ${drafts.length} flight${drafts.length === 1 ? '' : 's'}. Review them in "Your flights" and press Calculate.`);
      ctx.announce(`Found ${drafts.length} flights. Please review them.`);
    } finally {
      btn.disabled = false;
    }
  }

  const el = h(
    'div',
    { class: 'paste-panel' },
    h('label', { for: id }, 'Paste itinerary text'),
    ta,
    aiRow,
    h('div', { class: 'row' }, btn),
    status,
  );
  return {
    el,
    setBackend(health) {
      aiRow.hidden = !health || !health.ok;
    },
  };
}

// ───────────────────────────── samples tab ─────────────────────────────

const REGION_LABEL: Record<RouteRegion, string> = {
  'south-asia': 'South Asia',
  'middle-east': 'Middle East',
  'east-asia': 'East Asia',
  'southeast-asia': 'Southeast Asia',
  europe: 'Europe',
  'north-africa': 'North Africa',
  'east-africa': 'East Africa',
  'west-africa': 'West Africa',
  'south-africa': 'Southern Africa',
  'south-america': 'South America',
  australia: 'Australia',
  'new-zealand': 'New Zealand',
  polar: 'Polar routes',
  'domestic-us': 'United States (domestic)',
};

function createSamplesPanel(ctx: InputContext): HTMLElement {
  const dateId = uid('sdate');
  const date = h('input', { id: dateId, type: 'date', value: todayIso() });
  const selId = uid('ssel');
  const sel = h(
    'select',
    { id: selId },
    SAMPLE_ITINERARIES.map((s) => h('option', { value: s.id }, s.title)),
  );
  const msg = h('div', { class: 'status-line', role: 'status', 'aria-live': 'polite' });

  const validDate = (): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : null);

  function loadSample(): void {
    const d = validDate();
    if (!d) {
      setChildren(msg, 'Pick a valid date first.');
      return;
    }
    const it = findSampleItinerary(sel.value);
    if (!it) return;
    try {
      const legs = itineraryToLegs(it, d, ctx.api.getAirport);
      ctx.setLegs(legs.map((l) => legToDraft(l, ctx.api.getAirport)), { calculate: true });
      setChildren(msg, `Loaded “${it.title}”. Schedules are representative; edit the times to match your ticket.`);
    } catch (e) {
      setChildren(msg, `Could not load that route: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  // Library browser
  const qId = uid('lq');
  const q = h('input', { id: qId, type: 'search', placeholder: 'Search flight, airline or airport (e.g. EK, SFO, Doha)', autocomplete: 'off' });
  const fRegion = h('select', { 'aria-label': 'Region' }, h('option', { value: '' }, 'All regions'),
    (Object.keys(REGION_LABEL) as RouteRegion[]).map((r) => h('option', { value: r }, REGION_LABEL[r])));
  const fCoast = h('select', { 'aria-label': 'US coast' }, h('option', { value: '' }, 'Any US coast'),
    h('option', { value: 'east' }, 'US East Coast'), h('option', { value: 'west' }, 'US West Coast'), h('option', { value: 'none' }, 'Not US-connected'));
  const fDir = h('select', { 'aria-label': 'Direction' }, h('option', { value: '' }, 'Both directions'),
    h('option', { value: 'outbound' }, 'Outbound'), h('option', { value: 'return' }, 'Return'));
  const results = h('div', { class: 'lib-results' });
  const count = h('div', { class: 'hint', 'aria-live': 'polite' });

  function addFlight(fl: LibraryFlight): void {
    const d = validDate();
    if (!d) {
      setChildren(msg, 'Pick a valid date first.');
      return;
    }
    try {
      const leg = libraryFlightToLeg(fl, d, ctx.api.getAirport);
      ctx.addLeg(legToDraft(leg, ctx.api.getAirport));
      setChildren(msg, `Added ${fl.flightNumber} ${fl.from} → ${fl.to} to your flights. Press Calculate when ready.`);
    } catch (e) {
      setChildren(msg, `Could not add ${fl.flightNumber}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }

  function renderLibrary(): void {
    const needle = q.value.trim().toLowerCase();
    const rows = FLIGHT_LIBRARY.filter((f) => {
      if (fRegion.value && f.region !== fRegion.value) return false;
      if (fCoast.value && f.usCoast !== fCoast.value) return false;
      if (fDir.value && f.direction !== fDir.value) return false;
      if (!needle) return true;
      const a = ctx.api.getAirport(f.from);
      const b = ctx.api.getAirport(f.to);
      const hay = `${f.flightNumber} ${f.airline} ${f.from} ${f.to} ${a?.city ?? ''} ${b?.city ?? ''} ${a?.name ?? ''} ${b?.name ?? ''}`.toLowerCase();
      return needle.split(/\s+/).every((w) => hay.includes(w));
    });
    setChildren(count, `${rows.length} of ${FLIGHT_LIBRARY.length} flights`);
    clear(results);
    const groups = new Map<RouteRegion, LibraryFlight[]>();
    for (const f of rows) {
      const g = groups.get(f.region) ?? [];
      g.push(f);
      groups.set(f.region, g);
    }
    const open = !!needle || !!fRegion.value || !!fCoast.value || !!fDir.value;
    for (const [region, fl] of groups) {
      results.appendChild(
        h(
          'details',
          { class: 'lib-group', open },
          h('summary', null, `${REGION_LABEL[region]} (${fl.length})`),
          h(
            'ul',
            { class: 'lib-list' },
            fl.map((f) =>
              h(
                'li',
                null,
                h('span', { class: 'lib-main' }, h('strong', null, f.flightNumber), ` ${f.from} → ${f.to}`),
                h('span', { class: 'muted' }, ` ${f.airline} · ${f.depLocal} → ${f.arrLocal}${f.arrDayOffset ? ` (+${f.arrDayOffset})` : ''} · ${f.direction}`),
                h('button', { type: 'button', class: 'btn small', 'aria-label': `Add ${f.flightNumber} ${f.from} to ${f.to} as a leg`, onClick: () => addFlight(f) }, 'Add as leg'),
              ),
            ),
          ),
        ),
      );
    }
  }
  for (const c of [q, fRegion, fCoast, fDir]) c.addEventListener(c === q ? 'input' : 'change', renderLibrary);
  let libraryRendered = false;
  const libDetails = h(
    'details',
    { class: 'lib' },
    h('summary', null, 'Browse the flight library'),
    h('p', { class: 'hint' }, 'Real city pairs with representative schedules; flight numbers and times change, so always check your ticket.'),
    h('div', { class: 'lib-filters' }, h('div', { class: 'field' }, h('label', { for: qId }, 'Search'), q), fRegion, fCoast, fDir),
    count,
    results,
  );
  libDetails.addEventListener('toggle', () => {
    if (libDetails.open && !libraryRendered) {
      libraryRendered = true;
      renderLibrary();
    }
  });

  return h(
    'div',
    { class: 'samples-panel' },
    h('div', { class: 'field' }, h('label', { for: dateId }, 'Departure date'), date),
    h('div', { class: 'field' }, h('label', { for: selId }, 'Sample itinerary'), sel),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'load-sample-btn', onClick: loadSample }, 'Load and calculate')),
    msg,
    libDetails,
  );
}

// ───────────────────────────── assembly ─────────────────────────────

export function createInputTabs(ctx: InputContext): InputTabs {
  const photo = createPhotoPanel(ctx);
  const paste = createPastePanel(ctx);
  const samples = createSamplesPanel(ctx);
  const tabs = createTabs([
    { id: 'photo', label: 'Photo / PDF', panel: h('div', null, photo.el) },
    { id: 'paste', label: 'Paste text', panel: h('div', null, paste.el) },
    { id: 'samples', label: 'Sample routes', panel: h('div', null, samples) },
  ]);
  const el = h('section', { class: 'card input-card', 'aria-labelledby': 'input-h' }, h('h2', { id: 'input-h' }, '1. Get your itinerary in'), tabs.el);
  return {
    el,
    tabs,
    setBackend(health) {
      photo.setBackend(health);
      paste.setBackend(health);
    },
    dispose() {
      photo.dispose();
    },
  };
}
