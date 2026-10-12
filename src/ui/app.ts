/** Application shell: wires the input tabs, legs editor, settings, compute client and results. */
import type { Airport } from '../types';
import { getApiBase } from '../api/config';
import { getHealth } from '../api/client';
import { SAMPLE_ITINERARIES, itineraryToLegs } from '../data/flights';
import { ComputeClient } from './compute';
import { clear, debounce, h, setChildren, todayIso } from './dom';
import { createInputTabs, type InputTabs } from './inputTabs';
import { createLegsEditor, type LegsEditor } from './legsEditor';
import { defaultAppSettings, legToDraft, type AppSettings } from './model';
import { decodeShareHash, encodeShareHash, loadItinerary, loadSettings, saveItinerary, saveSettings, shareUrl } from './persist';
import { createSettingsPanel, type SettingsPanel } from './settingsPanel';
import { renderResults, type RenderedResults } from './results';
import { buildTrip } from './results/model';
import type { AirportApi } from './airportInput';
import { renderAbout } from './about';

export interface MountOptions {
  /** Skip the Web Worker (tests). */
  forceMainThread?: boolean;
  /** Restore state from the URL hash / localStorage (default true). */
  restore?: boolean;
}

export interface AppHandle {
  root: HTMLElement;
  legs: LegsEditor;
  settings: SettingsPanel;
  inputs: InputTabs;
  calculate(): Promise<void>;
  loadSample(id?: string): Promise<void>;
  /** Resolves when no computation is pending. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

export async function mountApp(root: HTMLElement, opts: MountOptions = {}): Promise<AppHandle> {
  const airportsMod = await import('../data/airports');
  const api: AirportApi = { getAirport: airportsMod.getAirport, searchAirports: airportsMod.searchAirports };
  const resolve = (c: string): Airport | undefined => api.getAirport(c);

  const client = new ComputeClient({ forceMainThread: opts.forceMainThread });
  let settings: AppSettings = opts.restore === false ? defaultAppSettings() : loadSettings();
  let rendered: RenderedResults | null = null;
  let lastLegs: ReturnType<LegsEditor['validate']>['legs'] | null = null;
  let pending: Promise<void> = Promise.resolve();

  // ── live regions ──
  const live = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', id: 'live-status' });
  const announce = (t: string): void => {
    live.textContent = '';
    window.setTimeout(() => {
      live.textContent = t;
    }, 20);
  };

  // ── results region ──
  const resultsEl = h('section', { class: 'results', id: 'results', 'aria-label': 'Results', tabindex: -1 });
  const stale = h('div', { class: 'banner stale no-print', role: 'status', hidden: true }, 'You changed the itinerary. The results below are for the previous one; press “Calculate prayer times” to update them.');
  const resultsBody = h('div', { class: 'results-body' });
  resultsEl.append(stale, resultsBody);

  function showEmpty(): void {
    setChildren(
      resultsBody,
      h(
        'div',
        { class: 'empty card' },
        h('h2', null, '3. Results'),
        h('p', null, 'Enter your itinerary, or:'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'empty-sample-btn', onClick: () => void loadSample('khi-dxb-sfo') }, 'Load a sample route to see how it works')),
        h('p', { class: 'hint' }, 'You will see when each prayer window opens and closes, where the aircraft is at that moment, and which way the Qibla points, minute by minute.'),
      ),
    );
  }

  function showError(msg: string, details?: string[]): void {
    rendered?.dispose();
    rendered = null;
    setChildren(
      resultsBody,
      h(
        'div',
        { class: 'card error-card', role: 'alert' },
        h('h2', null, 'Something needs fixing'),
        h('p', null, msg),
        details && details.length ? h('ul', { class: 'msg-list error' }, details.map((d) => h('li', null, d))) : null,
      ),
    );
  }

  function showBusy(): void {
    resultsEl.setAttribute('aria-busy', 'true');
    setChildren(resultsBody, h('div', { class: 'card busy', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, 'Calculating prayer windows along your flight…')));
  }

  // ── share ──
  async function copyShare(): Promise<void> {
    const url = shareUrl(legs.getDrafts(), settings);
    try {
      history.replaceState(null, '', encodeShareHash(legs.getDrafts(), settings));
    } catch {
      /* ignore */
    }
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px' });
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    announce(ok ? 'Share link copied to the clipboard.' : 'The share link is now in the address bar; copy it from there.');
    shareNote.textContent = ok ? 'Share link copied.' : 'The link is in your address bar: copy it from there.';
  }
  const shareNote = h('div', { class: 'visually-hidden', role: 'status' });

  // ── compute ──
  async function compute(): Promise<void> {
    const v = legs.validate();
    const sErr = panel.errors();
    if (v.errors.length > 0 || sErr.length > 0) {
      showError('Please fix the problems below before calculating.', [...v.errors, ...sErr]);
      announce('There are problems with the itinerary or settings.');
      return;
    }
    await runWith(v.legs, true);
  }

  async function runWith(inputLegs: NonNullable<typeof lastLegs>, persist: boolean): Promise<void> {
    legs.setBusy(true);
    showBusy();
    const used = new Map<string, Airport>();
    for (const l of inputLegs) {
      for (const c of [l.from, l.to]) {
        const a = resolve(c);
        if (a) used.set(a.iata, a);
      }
    }
    const res = await client.run({
      legs: inputLegs,
      airports: Array.from(used.values()),
      settings: JSON.parse(JSON.stringify(settings.prayer)),
      stepMinutes: settings.stepMinutes,
    });
    if (!res.ok && res.error === 'superseded') return;
    legs.setBusy(false);
    resultsEl.setAttribute('aria-busy', 'false');
    if (!res.ok) {
      showError(`The calculation failed: ${res.error}`);
      announce('The calculation failed.');
      return;
    }
    // Dates in `inputLegs` are Date objects in this thread; the worker received clones.
    rendered?.dispose();
    lastLegs = inputLegs;
    const trip = buildTrip(inputLegs, used);
    rendered = renderResults(trip, JSON.parse(JSON.stringify(settings)) as AppSettings, res, { onShare: () => void copyShare() });
    clear(resultsBody);
    resultsBody.appendChild(rendered.el);
    stale.hidden = true;
    if (persist) {
      saveItinerary(legs.getDrafts());
      legs.clearReview();
      try {
        history.replaceState(null, '', encodeShareHash(legs.getDrafts(), settings));
      } catch {
        /* ignore */
      }
    }
    const air = res.tasks.filter((t) => t.inAir).length;
    announce(`Results ready: ${res.tasks.length} prayer windows, ${air} opening in the air, ${res.result.anomalies.length} anomalies.`);
  }

  async function loadSample(id = 'khi-dxb-sfo'): Promise<void> {
    const it = SAMPLE_ITINERARIES.find((s) => s.id === id) ?? SAMPLE_ITINERARIES[0];
    const legsData = itineraryToLegs(it, todayIso(), resolve);
    legs.setLegs(legsData.map((l) => legToDraft(l, resolve)));
    inputs.tabs.select('samples');
    await trackedCompute();
  }

  function trackedCompute(): Promise<void> {
    pending = compute();
    return pending;
  }

  // ── components ──
  const legs: LegsEditor = createLegsEditor({
    api,
    onChange: () => {
      if (rendered) stale.hidden = false;
    },
    onCalculate: () => void trackedCompute(),
  });

  const inputs = createInputTabs({
    api,
    setLegs: (l, o) => {
      legs.setLegs(l, { review: o?.review, message: o?.message });
      if (o?.calculate) void trackedCompute();
      else if (o?.review) legs.el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    },
    addLeg: (l) => legs.addLeg(l),
    announce,
  });

  const recompute = debounce(() => {
    if (!lastLegs) return;
    const sErr = panel.errors();
    if (sErr.length > 0) return;
    pending = runWith(lastLegs, false);
  }, 150);

  const panel: SettingsPanel = createSettingsPanel(settings, (s, errs) => {
    settings = s;
    saveSettings(s);
    if (errs.length === 0 && lastLegs) recompute();
  });
  settings = panel.get();

  // ── page ──
  const header = h(
    'header',
    { class: 'site-header' },
    h('div', { class: 'wrap' },
      h('h1', null, 'In-Flight Prayer Times'),
      h('p', { class: 'tagline' }, 'See exactly when and where each prayer window opens and closes during your journey, minute by minute, for every madhab. Everything is calculated on your device.'),
    ),
  );
  const main = h(
    'main',
    { id: 'main', class: 'wrap layout' },
    h('div', { class: 'col-input' }, inputs.el, legs.el, panel.el),
    h('div', { class: 'col-results' }, resultsEl),
  );
  const skip = h('a', { class: 'skip', href: '#results' }, 'Skip to results');
  clear(root);
  root.append(skip, header, main, renderAbout(), live, shareNote);
  showEmpty();

  // ── restore ──
  if (opts.restore !== false) {
    const shared = decodeShareHash(typeof location !== 'undefined' ? location.hash : '');
    if (shared) {
      settings = shared.settings;
      panel.set(settings);
      saveSettings(settings);
      legs.setLegs(shared.legs);
      pending = compute();
    } else {
      const saved = loadItinerary();
      if (saved.length > 0 && saved.every((d) => d.from && d.to && d.depLocal && d.arrLocal)) {
        legs.setLegs(saved);
        pending = compute();
      }
    }
  }

  // ── optional backend ──
  if (getApiBase()) {
    getHealth()
      .then((hres) => {
        if (hres?.ok) {
          inputs.setBackend(hres);
          legs.setBackendAvailable(true);
        }
      })
      .catch(() => {
        /* backend unreachable: stays hidden */
      });
  }

  return {
    root,
    legs,
    settings: panel,
    inputs,
    calculate: trackedCompute,
    loadSample,
    whenIdle: async () => {
      await pending;
      await new Promise((r) => setTimeout(r, 200));
      await pending;
    },
    dispose() {
      rendered?.dispose();
      client.dispose();
    },
  };
}
