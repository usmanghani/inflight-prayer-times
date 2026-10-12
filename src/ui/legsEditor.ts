/** The legs editor: the single source of truth for the itinerary. */
import type { FlightLeg } from '../types';
import { validateLegs } from '../flight/journey';
import { parseTrackFile } from '../flight/trackImport';
import { formatOffset, localToUtc, utcOffsetMinutes } from '../time/tz';
import { findLibraryFlight, libraryFlightToLeg } from '../data/flights';
import { fetchTrackDetailed, lookupFlight } from '../api/client';
import { createAirportInput, type AirportApi, type AirportInputHandle } from './airportInput';
import { clear, h, setChildren, todayIso, uid } from './dom';
import {
  DEFAULT_CRUISE_FT,
  MAX_CRUISE_FT,
  blankLeg,
  draftsToLegs,
  legToDraft,
  utcToLocalInput,
  type LegDraft,
} from './model';

export const MAX_LEGS = 10;

export interface LegsEditorOptions {
  api: AirportApi;
  onChange: (kind: 'edit' | 'structure') => void;
  onCalculate: () => void;
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export interface LegsEditor {
  el: HTMLElement;
  getDrafts(): LegDraft[];
  setLegs(legs: LegDraft[], opts?: { review?: boolean; message?: string }): void;
  addLeg(leg?: LegDraft): void;
  /** Validate the current drafts (and render the messages). */
  validate(): Validation & { legs: FlightLeg[] };
  setBackendAvailable(v: boolean): void;
  setBusy(busy: boolean, label?: string): void;
  clearReview(): void;
}

function fileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsText(file);
  });
}

export function createLegsEditor(opts: LegsEditorOptions): LegsEditor {
  const { api } = opts;
  let drafts: LegDraft[] = [];
  let backend = false;
  let views: LegView[] = [];
  /** Inline validation is shown only once the user has tried to calculate or loaded something. */
  let touched = false;

  const list = h('div', { class: 'legs-list' });
  const reviewBanner = h('div', { class: 'banner review', role: 'status', hidden: true });
  const validation = h('div', { class: 'validation', 'aria-live': 'polite' });
  const calcBtn = h('button', { type: 'button', class: 'btn primary calc', id: 'calc-btn', onClick: () => opts.onCalculate() }, 'Calculate prayer times');
  const addBtn = h('button', { type: 'button', class: 'btn', onClick: () => editor.addLeg() }, '+ Add leg');
  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn subtle',
      onClick: () => {
        drafts = [blankLeg()];
        renderAll();
        opts.onChange('structure');
      },
    },
    'Clear all',
  );

  const el = h(
    'section',
    { class: 'card legs-card', 'aria-labelledby': 'legs-h' },
    h('h2', { id: 'legs-h' }, 'Your flights'),
    h('p', { class: 'hint' }, 'This list is what gets calculated. Times are local to each airport. Check everything that was read from a photo or text.'),
    reviewBanner,
    list,
    h('div', { class: 'row' }, addBtn, clearBtn),
    validation,
    h('div', { class: 'row end' }, calcBtn),
  );

  function resolve(iata: string) {
    return api.getAirport(iata);
  }

  function renderValidation(v: Validation): void {
    setChildren(
      validation,
      v.errors.length
        ? h('ul', { class: 'msg-list error', role: 'alert' }, v.errors.map((e) => h('li', null, e)))
        : null,
      v.warnings.length ? h('ul', { class: 'msg-list warn' }, v.warnings.map((e) => h('li', null, e))) : null,
    );
  }

  function runValidate(render: boolean): Validation & { legs: FlightLeg[] } {
    const conv = draftsToLegs(drafts, resolve);
    const errors = [...conv.errors];
    const warnings: string[] = [];
    if (drafts.length === 0) errors.push('Add at least one flight.');
    if (conv.legs.length === drafts.length && drafts.length > 0) {
      const v = validateLegs(conv.legs, resolve);
      errors.push(...v.errors);
      warnings.push(...v.warnings);
    }
    if (render) renderValidation({ errors, warnings });
    return { errors, warnings, legs: conv.legs };
  }

  // ─────────────── single leg view ───────────────

  class LegView {
    el: HTMLElement;
    private fromIn: AirportInputHandle;
    private toIn: AirportInputHandle;
    private fn: HTMLInputElement;
    private dep: HTMLInputElement;
    private arr: HTMLInputElement;
    private depLabel: HTMLElement;
    private arrLabel: HTMLElement;
    private cruise: HTMLInputElement;
    private msg: HTMLElement;
    private trackInfo: HTMLElement;
    private trackRemove: HTMLButtonElement;
    private lookupBtn: HTMLButtonElement;
    private fetchBtn: HTMLButtonElement;
    private lastFn = '';

    constructor(
      private d: LegDraft,
      index: number,
      count: number,
    ) {
      const idp = uid('leg');
      this.fn = h('input', {
        id: `${idp}-fn`, type: 'text', autocapitalize: 'characters', spellcheck: 'false', maxlength: 10,
        placeholder: 'e.g. EK601', value: d.flightNumber,
      });
      this.fn.addEventListener('focus', () => {
        this.lastFn = this.d.flightNumber;
      });
      this.fn.addEventListener('input', () => {
        this.d.flightNumber = this.fn.value;
        changed('edit');
      });
      this.fn.addEventListener('blur', () => this.onFlightBlur());

      this.fromIn = createAirportInput({
        label: 'From (departure airport)',
        value: d.from,
        api,
        onChange: (v) => {
          this.d.from = v;
          this.refreshLabels();
          changed('edit');
        },
        offsetAt: () => this.refDate(this.d.depLocal),
      });
      this.toIn = createAirportInput({
        label: 'To (arrival airport)',
        value: d.to,
        api,
        onChange: (v) => {
          this.d.to = v;
          this.refreshLabels();
          changed('edit');
        },
        offsetAt: () => this.refDate(this.d.arrLocal),
      });

      this.depLabel = h('label', { for: `${idp}-dep` });
      this.arrLabel = h('label', { for: `${idp}-arr` });
      this.dep = h('input', { id: `${idp}-dep`, type: 'datetime-local', value: d.depLocal, step: 60 });
      this.arr = h('input', { id: `${idp}-arr`, type: 'datetime-local', value: d.arrLocal, step: 60 });
      this.dep.addEventListener('input', () => {
        this.d.depLocal = this.dep.value;
        this.refreshLabels();
        changed('edit');
      });
      this.arr.addEventListener('input', () => {
        this.d.arrLocal = this.arr.value;
        this.refreshLabels();
        changed('edit');
      });

      this.cruise = h('input', {
        id: `${idp}-alt`, type: 'number', inputmode: 'numeric', min: 0, max: MAX_CRUISE_FT, step: 500,
        placeholder: String(DEFAULT_CRUISE_FT), value: d.cruiseFt,
      });
      this.cruise.addEventListener('input', () => {
        this.d.cruiseFt = this.cruise.value;
        changed('edit');
      });

      this.msg = h('div', { class: 'leg-msg', role: 'status', 'aria-live': 'polite' });
      this.trackInfo = h('span', { class: 'track-info' });
      const trackFile = h('input', { id: `${idp}-track`, type: 'file', accept: '.kml,.gpx,.csv,.txt,application/gpx+xml,application/vnd.google-earth.kml+xml,text/csv', class: 'visually-hidden' });
      trackFile.addEventListener('change', () => {
        const f = trackFile.files?.[0];
        if (f) void this.importTrack(f);
        trackFile.value = '';
      });
      this.trackRemove = h('button', { type: 'button', class: 'btn subtle small', onClick: () => this.removeTrack() }, 'Remove track');
      this.lookupBtn = h('button', { type: 'button', class: 'btn small', onClick: () => void this.apiLookup() }, 'Look up flight (online)');
      this.fetchBtn = h('button', { type: 'button', class: 'btn small', onClick: () => void this.apiTrack() }, 'Fetch real track (online)');

      const moveBtns = h(
        'div',
        { class: 'leg-tools' },
        h('button', { type: 'button', class: 'btn icon', 'aria-label': `Move leg ${index + 1} up`, disabled: index === 0, onClick: () => move(this.d.id, -1) }, '↑'),
        h('button', { type: 'button', class: 'btn icon', 'aria-label': `Move leg ${index + 1} down`, disabled: index === count - 1, onClick: () => move(this.d.id, 1) }, '↓'),
        h('button', { type: 'button', class: 'btn icon danger', 'aria-label': `Remove leg ${index + 1}`, onClick: () => remove(this.d.id) }, '✕'),
      );

      this.el = h(
        'fieldset',
        { class: `leg${d.needsReview ? ' needs-review' : ''}`, dataset: { legId: d.id } },
        h('legend', null, `Leg ${index + 1}`, d.needsReview ? h('span', { class: 'badge warn' }, d.confidence !== undefined && d.confidence < 0.6 ? 'check carefully' : 'please confirm') : null),
        moveBtns,
        h(
          'div',
          { class: 'leg-grid' },
          h('div', { class: 'field' }, h('label', { for: `${idp}-fn` }, 'Flight number'), this.fn),
          this.fromIn.el,
          this.toIn.el,
          h('div', { class: 'field' }, this.depLabel, this.dep),
          h('div', { class: 'field' }, this.arrLabel, this.arr),
          h('div', { class: 'field' }, h('label', { for: `${idp}-alt` }, 'Cruise altitude (ft)'), this.cruise, h('div', { class: 'ac-caption' }, `Default ${DEFAULT_CRUISE_FT.toLocaleString('en-US')} ft; used when there is no track`)),
        ),
        h(
          'div',
          { class: 'leg-extra row wrap' },
          h('label', { class: 'btn small file-btn', for: `${idp}-track` }, 'Import track (KML / GPX / CSV)'),
          trackFile,
          this.trackRemove,
          this.trackInfo,
          this.lookupBtn,
          this.fetchBtn,
        ),
        this.msg,
      );
      this.refresh();
    }

    private refDate(local: string): Date {
      const dt = local ? new Date(local + ':00Z') : new Date();
      return Number.isFinite(dt.getTime()) ? dt : new Date();
    }

    private tzLabel(iata: string, local: string): string {
      const a = api.getAirport(iata.trim().toUpperCase());
      if (!a) return '';
      try {
        let off: number;
        if (local) {
          const utc = localToUtc(local, a.tz);
          off = utcOffsetMinutes(utc, a.tz);
        } else off = utcOffsetMinutes(new Date(), a.tz);
        return ` — ${a.iata} local, UTC${formatOffset(off)}`;
      } catch {
        return ` — ${a.iata} local`;
      }
    }

    refreshLabels(): void {
      setChildren(this.depLabel, 'Departure', h('span', { class: 'tzl' }, this.tzLabel(this.d.from, this.d.depLocal) || ' (local time)'));
      setChildren(this.arrLabel, 'Arrival', h('span', { class: 'tzl' }, this.tzLabel(this.d.to, this.d.arrLocal) || ' (local time)'));
      this.fromIn.refreshCaption();
      this.toIn.refreshCaption();
    }

    /** Sync every field from the draft (used after programmatic changes). */
    refresh(): void {
      this.fn.value = this.d.flightNumber;
      this.fromIn.setValue(this.d.from);
      this.toIn.setValue(this.d.to);
      this.dep.value = this.d.depLocal;
      this.arr.value = this.d.arrLocal;
      this.cruise.value = this.d.cruiseFt;
      this.refreshLabels();
      const hasTrack = !!this.d.track && this.d.track.length >= 2;
      this.trackRemove.hidden = !hasTrack;
      setChildren(this.trackInfo, hasTrack ? `Track: ${this.d.trackLabel ?? 'imported'} (${this.d.track!.length} points, drawn solid on the map)` : '');
      this.lookupBtn.hidden = !backend;
      this.fetchBtn.hidden = !backend;
      setChildren(this.msg, this.d.note ?? '');
    }

    setMessage(text: string, kind: 'info' | 'error' = 'info'): void {
      this.d.note = kind === 'info' ? text : undefined;
      this.msg.className = `leg-msg ${kind === 'error' ? 'error' : ''}`;
      setChildren(this.msg, text);
    }

    private onFlightBlur(): void {
      const value = this.fn.value.trim();
      this.d.flightNumber = value;
      if (value === this.lastFn.trim() || !value) return;
      const fl = findLibraryFlight(value);
      if (!fl) return;
      const date = this.d.depLocal.slice(0, 10) || todayIso();
      try {
        const leg = libraryFlightToLeg(fl, date, resolve);
        const fd = legToDraft(leg, resolve);
        this.d.flightNumber = fl.flightNumber;
        this.d.from = fd.from;
        this.d.to = fd.to;
        this.d.depLocal = fd.depLocal;
        this.d.arrLocal = fd.arrLocal;
        this.refresh();
        this.setMessage(`Filled from the built-in schedule library (${fl.airline}). Times are representative and schedules change, so check your ticket.`);
        changed('edit');
      } catch {
        /* unknown airport in the library: leave the fields alone */
      }
    }

    private async importTrack(file: File): Promise<void> {
      try {
        const text = await fileText(file);
        const pts = parseTrackFile(text, file.name);
        if (pts.length < 2) throw new Error('The file has fewer than two usable track points.');
        this.d.track = pts;
        this.d.trackLabel = file.name.slice(0, 60);
        this.refresh();
        this.setMessage(`Imported ${pts.length} track points from "${file.name.slice(0, 60)}". The route and altitude profile now follow the real track.`);
        changed('edit');
      } catch (e) {
        this.setMessage(`Could not read the track: ${e instanceof Error ? e.message : 'unknown error'}`, 'error');
      }
    }

    private removeTrack(): void {
      this.d.track = undefined;
      this.d.trackLabel = undefined;
      this.refresh();
      this.setMessage('Track removed; the great-circle route is used.');
      changed('edit');
    }

    private async apiLookup(): Promise<void> {
      const fnum = this.fn.value.trim();
      const date = this.d.depLocal.slice(0, 10) || todayIso();
      if (!fnum) return this.setMessage('Enter a flight number first.', 'error');
      this.setMessage('Looking up the flight…');
      try {
        const res = await lookupFlight(fnum, date);
        const l = res.legs[0];
        if (!l) throw new Error('No flight found for that number and date.');
        const from = api.getAirport(l.from);
        const to = api.getAirport(l.to);
        if (!from || !to) throw new Error(`The service returned airports we do not know (${l.from} → ${l.to}).`);
        const dep = new Date(l.actualDepartureUtc ?? l.scheduledDepartureUtc ?? '');
        const arr = new Date(l.actualArrivalUtc ?? l.scheduledArrivalUtc ?? '');
        this.d.from = from.iata;
        this.d.to = to.iata;
        if (Number.isFinite(dep.getTime())) this.d.depLocal = utcToLocalInput(dep, from.tz);
        if (Number.isFinite(arr.getTime())) this.d.arrLocal = utcToLocalInput(arr, to.tz);
        this.refresh();
        this.setMessage(`Found via ${res.source}${l.aircraftType ? ` (${l.aircraftType})` : ''}. Check the times before calculating.`);
        changed('edit');
      } catch (e) {
        this.setMessage(e instanceof Error ? e.message : 'Lookup failed.', 'error');
      }
    }

    private async apiTrack(): Promise<void> {
      const fnum = this.fn.value.trim();
      const date = this.d.depLocal.slice(0, 10) || todayIso();
      if (!fnum) return this.setMessage('Enter a flight number first.', 'error');
      this.setMessage('Fetching the track…');
      try {
        const res = await fetchTrackDetailed(fnum, date);
        if (res.points.length < 2) throw new Error('No track available for that flight and date.');
        this.d.track = res.points;
        this.d.trackLabel = res.source;
        this.refresh();
        this.setMessage(`Real track from ${res.source}: ${res.points.length} points. ${res.attribution}`);
        changed('edit');
      } catch (e) {
        this.setMessage(e instanceof Error ? e.message : 'Track fetch failed.', 'error');
      }
    }
  }

  // ─────────────── structure ───────────────

  function changed(kind: 'edit' | 'structure'): void {
    runValidate(touched);
    opts.onChange(kind);
  }

  function renderAll(): void {
    clear(list);
    views = drafts.map((d, i) => new LegView(d, i, drafts.length));
    views.forEach((v) => list.appendChild(v.el));
    addBtn.disabled = drafts.length >= MAX_LEGS;
    runValidate(false);
    setChildren(validation);
  }

  function move(id: string, dir: -1 | 1): void {
    const i = drafts.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= drafts.length) return;
    [drafts[i], drafts[j]] = [drafts[j], drafts[i]];
    renderAll();
    opts.onChange('structure');
  }

  function remove(id: string): void {
    drafts = drafts.filter((d) => d.id !== id);
    if (drafts.length === 0) drafts = [blankLeg()];
    renderAll();
    opts.onChange('structure');
  }

  const editor: LegsEditor = {
    el,
    getDrafts: () => drafts,
    setLegs(legs, o = {}) {
      drafts = legs.length > 0 ? legs.slice(0, MAX_LEGS) : [blankLeg()];
      touched = legs.length > 0;
      renderAll();
      if (touched) runValidate(true);
      if (o.review) {
        reviewBanner.hidden = false;
        setChildren(
          reviewBanner,
          h('strong', null, 'Please review before calculating. '),
          o.message ?? 'These legs were read automatically and may contain mistakes. Check airports, dates and times, then press Calculate.',
        );
      } else {
        reviewBanner.hidden = true;
        clear(reviewBanner);
      }
      opts.onChange('structure');
    },
    addLeg(leg) {
      if (drafts.length >= MAX_LEGS) return;
      // Replace a lone blank leg instead of appending after it.
      if (leg && drafts.length === 1 && !drafts[0].from && !drafts[0].to && !drafts[0].flightNumber) drafts = [leg];
      else drafts.push(leg ?? blankLeg(drafts.length > 0 ? prefillNext(drafts[drafts.length - 1]) : {}));
      renderAll();
      opts.onChange('structure');
    },
    validate: () => {
      touched = true;
      return runValidate(true);
    },
    setBackendAvailable(v) {
      backend = v;
      views.forEach((view) => view.refresh());
    },
    setBusy(busy, label) {
      calcBtn.disabled = busy;
      calcBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
      setChildren(calcBtn, busy ? (label ?? 'Calculating…') : 'Calculate prayer times');
    },
    clearReview() {
      reviewBanner.hidden = true;
      clear(reviewBanner);
      views.forEach((v) => v.el.classList.remove('needs-review'));
    },
  };

  /** A new leg continues from where the previous one ended. */
  function prefillNext(prev: LegDraft): Partial<LegDraft> {
    const to = api.getAirport(prev.to.trim().toUpperCase());
    return {
      from: to ? to.iata : '',
      depLocal: prev.arrLocal ? addHours(prev.arrLocal, 3) : '',
    };
  }

  function addHours(local: string, hours: number): string {
    const t = new Date(local + ':00Z');
    if (!Number.isFinite(t.getTime())) return '';
    return new Date(t.getTime() + hours * 3600000).toISOString().slice(0, 16);
  }

  drafts = [blankLeg()];
  renderAll();
  return editor;
}
