// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OCR_TEXT = [
  'Booking confirmation <img src=x onerror="window.__xss=1">',
  'EK 601  Karachi (KHI)  Mon 12 Oct 2026  02:55',
  'Arrives Dubai (DXB)  04:20',
  'EK 225  Dubai (DXB)  Mon 12 Oct 2026  09:55',
  'Arrives San Francisco (SFO)  15:05',
].join('\n');

const ocrMock = vi.hoisted(() => ({
  /** Text to return per file name (default: OCR_TEXT). */
  byName: {} as Record<string, string>,
  /** File names whose recognition fails. */
  failing: new Set<string>(),
  /** When true the batch waits until it is aborted. */
  hang: false,
}));

vi.mock('../src/ocr/ocr', () => ({
  recognizeImage: vi.fn(async (_img: unknown, onProgress?: (p: { status: string; progress: number }) => void) => {
    onProgress?.({ status: 'recognizing text', progress: 0.5 });
    onProgress?.({ status: 'recognizing text', progress: 1 });
    return OCR_TEXT;
  }),
  recognizeImages: vi.fn(
    async (
      images: File[],
      onProgress?: (p: { index: number; total: number; status: string; progress: number }) => void,
      signal?: AbortSignal,
    ) => {
      const out: { index: number; text: string; error?: string }[] = [];
      for (let i = 0; i < images.length; i++) {
        onProgress?.({ index: i, total: images.length, status: 'recognizing text', progress: 0.63 });
        await new Promise((r) => setTimeout(r, 0)); // let the UI paint each step
        if (ocrMock.hang) {
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
          });
        }
        const name = images[i]!.name;
        if (ocrMock.failing.has(name)) out.push({ index: i, text: '', error: 'Could not decode image' });
        else out.push({ index: i, text: ocrMock.byName[name] ?? OCR_TEXT });
      }
      return out;
    },
  ),
}));

const apiMock = vi.hoisted(() => ({ extract: undefined as undefined | ((...a: unknown[]) => Promise<unknown>) }));
vi.mock('../src/api/client', async (orig) => {
  const real = await orig<typeof import('../src/api/client')>();
  return { ...real, extractItinerary: vi.fn((...a: unknown[]) => apiMock.extract!(...a)) };
});

import { mountApp, type AppHandle } from '../src/ui/app';
import { recognizeImages } from '../src/ocr/ocr';
import { extractItinerary } from '../src/api/client';
import { h, parseNumber } from '../src/ui/dom';
import { decodeShareHash, encodeShareHash } from '../src/ui/persist';
import { defaultAppSettings, blankLeg } from '../src/ui/model';
import { nightPolygon, subsolarPoint } from '../src/ui/terminator';
import { qiblaPhrase } from '../src/ui/format';
import { PROFILES } from '../src/prayer/methods';
import { loadSettings } from '../src/ui/persist';
import { findLibraryFlight, libraryFlightToLeg } from '../src/data/flights';
import { getAirport } from '../src/data/airports';
import { legToDraft } from '../src/ui/model';

let app: AppHandle | null = null;
let root: HTMLElement;

async function mount(): Promise<AppHandle> {
  root = document.createElement('div');
  document.body.appendChild(root);
  app = await mountApp(root, { forceMainThread: true });
  return app;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function setSelect(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const prayers = (): string[] => Array.from(document.querySelectorAll<HTMLElement>('.prayer-card')).map((c) => c.dataset.prayer ?? '');

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', location.pathname);
  document.body.innerHTML = '';
});

afterEach(() => {
  app?.dispose();
  app = null;
  vi.clearAllMocks();
});

describe('app shell', () => {
  it('shows the empty state with a sample button', async () => {
    await mount();
    expect(document.querySelector('h1')?.textContent).toBe('In-Flight Prayer Times');
    expect(document.getElementById('empty-sample-btn')?.textContent).toContain('Load a sample route');
    expect(prayers()).toHaveLength(0);
  });

  it('loads the sample itinerary and renders summary cards without NaN / Invalid Date', async () => {
    const a = await mount();
    (document.getElementById('empty-sample-btn') as HTMLButtonElement).click();
    await a.whenIdle();
    await waitFor(() => prayers().length > 0);

    const found = new Set(prayers());
    for (const p of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']) expect(found.has(p)).toBe(true);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/Invalid Date/);
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/Infinity/);

    // sections
    expect(document.getElementById('tl-h')).toBeTruthy();
    expect(document.querySelector('svg.chart')).toBeTruthy();
    expect(document.querySelector('table.samples tbody tr')).toBeTruthy();
    expect(document.querySelectorAll('.leg').length).toBe(2);
    // Hanafi notes by default
    expect(document.getElementById('notes-h')?.parentElement?.textContent).toContain('does not allow combining');
    // Arabic names
    expect(document.querySelector('.prayer-card .ar')?.textContent).toMatch(/[؀-ۿ]/);
  });

  it('scrubber updates the readout', async () => {
    const a = await mount();
    await a.loadSample('khi-dxb-sfo');
    const slider = document.getElementById('scrub') as HTMLInputElement;
    const before = document.getElementById('scrub-readout')!.textContent;
    slider.value = '600';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.getElementById('scrub-readout')!.textContent;
    expect(after).not.toBe(before);
    expect(after).not.toMatch(/NaN/);
  });

  it('only-transitions filter reduces the number of table rows', async () => {
    const a = await mount();
    await a.loadSample('khi-dxb-sfo');
    const all = document.querySelectorAll('table.samples tbody tr').length;
    const chk = document.querySelector('.table-sec input[type=checkbox]') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change', { bubbles: true }));
    const some = document.querySelectorAll('table.samples tbody tr').length;
    expect(some).toBeGreaterThan(2);
    expect(some).toBeLessThan(all);
  });
});

describe('settings', () => {
  it("re-renders when switching to Shafi'i (earlier Asr, combining allowed)", async () => {
    const a = await mount();
    await a.loadSample('khi-dxb-sfo');
    const asrBefore = document.querySelector('.prayer-card[data-prayer="asr"]')!.textContent;

    setSelect('set-madhab', 'shafii');
    await a.whenIdle();
    await waitFor(() => !!document.querySelector('.prayer-card[data-prayer="asr"]') && document.querySelector('.prayer-card[data-prayer="asr"]')!.textContent !== asrBefore);

    expect(a.settings.get().prayer.madhab).toBe('shafii');
    expect(document.getElementById('notes-h')!.parentElement!.textContent).toContain('permitted for a traveller');
    expect(document.body.textContent).not.toMatch(/NaN|Invalid Date/);
  });

  it('shows a validation error for an out-of-range angle and blocks calculation', async () => {
    const a = await mount();
    await a.loadSample('khi-dxb-sfo');
    const fajrId = (document.querySelector('label[for^="set-fajr"]') as HTMLLabelElement).htmlFor;
    setText(fajrId, '45');
    const box = document.querySelector('.settings-errors') as HTMLElement;
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('Fajr angle must be a number between 0° and 30°');
    expect((document.getElementById('set-method') as HTMLSelectElement).value).toBe('custom');
    expect(a.settings.errors().length).toBeGreaterThan(0);

    await a.calculate();
    expect(document.querySelector('.error-card')?.textContent).toContain('Fajr angle must be');

    // fix it
    setText(fajrId, '15');
    expect(box.hidden).toBe(true);
    await a.calculate();
    await waitFor(() => prayers().length > 0);
  });

  it('rejects empty / non-numeric angle input without touching the settings', async () => {
    const a = await mount();
    const fajrId = (document.querySelector('label[for^="set-fajr"]') as HTMLLabelElement).htmlFor;
    setText(fajrId, '');
    expect(document.querySelector('.settings-errors')!.textContent).toContain('enter a number');
    expect(a.settings.get().prayer.method.fajrAngle).toBe(18);
    setText(fajrId, 'abc');
    expect(document.querySelector('.settings-errors')!.textContent).toContain('Fajr angle (°): enter a number');
    setText(fajrId, '17,5'); // decimal comma accepted
    expect(a.settings.get().prayer.method.fajrAngle).toBe(17.5);
  });

  it('persists settings to localStorage', async () => {
    await mount();
    setSelect('set-madhab', 'maliki');
    expect(localStorage.getItem('ipt.ui.settings.v2')).toContain('maliki');
  });
});

describe('profiles', () => {
  it('defaults to Barelvi with description, sources and disclaimer', async () => {
    const a = await mount();
    expect((document.getElementById('set-profile') as HTMLSelectElement).value).toBe('barelvi');
    expect(a.settings.get().prayer.profile).toBe('barelvi');
    expect(a.settings.get().prayer.highLatitudeRule).toBe('redTwilight');
    expect(a.settings.get().prayer.offsets.maghrib).toBe(3);
    const info = document.getElementById('profile-info')!;
    expect(info.textContent).toContain('Sahibayn');
    expect(info.textContent).toContain('Follow your own mufti; this app is not a fatwa.');
    const links = Array.from(info.querySelectorAll('a'));
    expect(links.length).toBe(PROFILES.barelvi.sources.length);
    for (const l of links) {
      expect(l.getAttribute('target')).toBe('_blank');
      expect(l.getAttribute('rel')).toBe('noopener noreferrer');
      expect(l.getAttribute('href')).toMatch(/^https:\/\//);
    }
    expect((document.getElementById('set-hl') as HTMLSelectElement).value).toBe('redTwilight');
    expect(document.querySelector('label[for^="set-red"]')?.textContent).toContain('Red-twilight angle');
    expect(document.getElementById('set-fajr-fb')).toBeTruthy();
  });

  it('switching to Deobandi applies its settings and hides red-twilight controls', async () => {
    const a = await mount();
    setSelect('set-profile', 'deobandi');
    const p = a.settings.get().prayer;
    expect(p.profile).toBe('deobandi');
    expect(p.highLatitudeRule).toBe('nearestLatitude');
    expect(p.offsets.maghrib).toBe(0);
    expect(document.getElementById('profile-info')!.textContent).toContain('Wifaq');
    expect(document.getElementById('set-fajr-fb')).toBeNull();
    expect(localStorage.getItem('ipt.ui.settings.v2')).toContain('"profile":"deobandi"');
  });

  it('editing any setting flips the profile to Custom and keeps the values', async () => {
    const a = await mount();
    const fajrId = (document.querySelector('label[for^="set-fajr"]') as HTMLLabelElement).htmlFor;
    setText(fajrId, '17');
    expect(a.settings.get().prayer.profile).toBe('custom');
    expect((document.getElementById('set-profile') as HTMLSelectElement).value).toBe('custom');
    expect(a.settings.get().prayer.method.fajrAngle).toBe(17);
    expect(a.settings.get().prayer.highLatitudeRule).toBe('redTwilight'); // kept
    // display-only changes do not flip the profile
    setSelect('set-profile', 'barelvi');
    setSelect('set-step', '5');
    expect(a.settings.get().prayer.profile).toBe('barelvi');
    setSelect('set-hl', 'angleBased');
    expect(a.settings.get().prayer.profile).toBe('custom');
    expect(document.getElementById('set-fajr-fb')).toBeNull();
  });

  it('validates the red-twilight angle', async () => {
    const a = await mount();
    const redId = (document.querySelector('label[for^="set-red"]') as HTMLLabelElement).htmlFor;
    setText(redId, '25');
    expect(document.querySelector('.settings-errors')!.textContent).toContain('red-twilight angle must not exceed');
    setText(redId, '40');
    expect(document.querySelector('.settings-errors')!.textContent).toContain('between 0° and 30°');
    setText(redId, '12');
    expect((document.querySelector('.settings-errors') as HTMLElement).hidden).toBe(true);
    expect(a.settings.get().prayer.redTwilightAngle).toBe(12);
  });

  it('renders the red-twilight badge for a summer high-latitude itinerary', async () => {
    const a = await mount();
    const leg = libraryFlightToLeg(findLibraryFlight('BA112')!, '2026-06-21', getAirport); // JFK -> LHR, midsummer
    a.legs.setLegs([legToDraft(leg, getAirport)]);
    await a.calculate();
    await waitFor(() => prayers().length > 0);
    const text = document.querySelector('.cards')!.textContent!;
    expect(text).toContain('Isha at red twilight (12°) — Sahibayn');
    expect(text).toMatch(/Borrowed from nearest location/);
    // Deobandi profile: no red-twilight badge
    setSelect('set-profile', 'deobandi');
    await a.whenIdle();
    await waitFor(() => !document.querySelector('.cards')!.textContent!.includes('red twilight'));
    expect(document.body.textContent).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it('loads old persisted settings: legacy defaults upgrade to Barelvi, customised ones are kept as Custom', () => {
    const legacyDefault = {
      prayer: {
        madhab: 'hanafi',
        method: { id: 'karachi', name: 'University of Islamic Sciences, Karachi', fajrAngle: 18, ishaAngle: 18, ishaIntervalMin: null, maghribAngle: null, midnight: 'standard' },
        highLatitudeRule: 'angleBased', dipForSunriseSunset: true, dipForTwilight: false,
        offsets: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
      },
      tzChoices: ['utc', 'aircraft'], stepMinutes: 5,
    };
    localStorage.setItem('ipt.ui.settings.v1', JSON.stringify(legacyDefault));
    let s = loadSettings();
    expect(s.prayer.profile).toBe('barelvi');
    expect(s.prayer.highLatitudeRule).toBe('redTwilight');
    expect(s.prayer.offsets.maghrib).toBe(3);
    expect(s.tzChoices).toEqual(['utc', 'aircraft']);
    expect(s.stepMinutes).toBe(5);

    const custom = { ...legacyDefault, prayer: { ...legacyDefault.prayer, madhab: 'shafii', highLatitudeRule: 'oneSeventh' } };
    localStorage.setItem('ipt.ui.settings.v1', JSON.stringify(custom));
    s = loadSettings();
    expect(s.prayer.profile).toBe('custom');
    expect(s.prayer.madhab).toBe('shafii');
    expect(s.prayer.highLatitudeRule).toBe('oneSeventh');
    expect(s.prayer.redTwilightAngle).toBe(12); // new fields filled with defaults

    // v2 with an explicit profile and the new rule round-trips
    localStorage.setItem('ipt.ui.settings.v2', JSON.stringify({ prayer: { highLatitudeRule: 'redTwilight', profile: 'barelvi', redTwilightAngle: 11 } }));
    s = loadSettings();
    expect(s.prayer.highLatitudeRule).toBe('redTwilight');
    expect(s.prayer.redTwilightAngle).toBe(11);
    expect(s.prayer.profile).toBe('barelvi');
    // garbage does not break loading
    localStorage.removeItem('ipt.ui.settings.v1');
    localStorage.setItem('ipt.ui.settings.v2', '{not json');
    expect(loadSettings().prayer.profile).toBe('barelvi');
  });

  it('share links keep the new fields; links without a profile load as Custom', () => {
    const s = defaultAppSettings();
    s.prayer.redTwilightAngle = 11;
    const legs = [blankLeg({ from: 'KHI', to: 'DXB', depLocal: '2026-10-12T02:55', arrLocal: '2026-10-12T04:20' })];
    const back = decodeShareHash(encodeShareHash(legs, s))!;
    expect(back.settings.prayer.redTwilightAngle).toBe(11);
    expect(back.settings.prayer.profile).toBe('barelvi');
    expect(back.settings.prayer.highLatitudeRule).toBe('redTwilight');
    const old = { v: 1, legs: [{ from: 'KHI', to: 'DXB', depLocal: '2026-10-12T02:55', arrLocal: '2026-10-12T04:20' }], settings: { prayer: { madhab: 'hanafi', highLatitudeRule: 'angleBased' } } };
    const hash = '#s=' + btoa(JSON.stringify(old)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const o = decodeShareHash(hash)!;
    expect(o.settings.prayer.profile).toBe('custom');
    expect(o.settings.prayer.highLatitudeRule).toBe('angleBased');
  });
});

describe('photo / OCR path', () => {
  const LEG1 = 'EK 601  Karachi (KHI)  Mon 12 Oct 2026  02:55\nArrives Dubai (DXB)  04:20';
  const LEG2 = 'EK 225  Dubai (DXB)  Mon 12 Oct 2026  09:55\nArrives San Francisco (SFO)  15:05';
  const png = (name: string, size = 1000, lastModified = 1_700_000_000_000): File => {
    const f = new File([new Uint8Array(4)], name, { type: 'image/png', lastModified });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };
  const pdf = (name: string, lastModified = 1): File => new File(['%PDF-1.4'], name, { type: 'application/pdf', lastModified });

  const fileInput = (): HTMLInputElement => document.querySelector('.photo-panel input[type=file]') as HTMLInputElement;
  const camInput = (): HTMLInputElement => document.querySelector('.photo-panel input[capture]') as HTMLInputElement;
  const readBtn = (): HTMLButtonElement => document.querySelector('.photo-panel .read-btn') as HTMLButtonElement;
  const names = (): string[] => Array.from(document.querySelectorAll('.attach-name')).map((e) => e.textContent ?? '');
  const msgs = (): string => document.querySelector('.attach-msgs')?.textContent ?? '';
  const label = (): string => document.querySelector('.progress-label')?.textContent ?? '';
  const btn = (sel: string): HTMLButtonElement => document.querySelector(sel) as HTMLButtonElement;

  function attach(files: File[], input: HTMLInputElement = fileInput()): void {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let created: string[] = [];
  let revoked: string[] = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  beforeEach(() => {
    created = [];
    revoked = [];
    ocrMock.byName = {};
    ocrMock.failing.clear();
    ocrMock.hang = false;
    apiMock.extract = undefined;
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:test/${created.length + 1}`;
      created.push(u);
      return u;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u)) as typeof URL.revokeObjectURL;
  });
  afterEach(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  it('reads an image on-device, fills the legs editor and does NOT calculate by itself', async () => {
    const a = await mount();
    attach([new File([new Uint8Array([1, 2, 3])], 'itinerary.png', { type: 'image/png' })]);
    expect(names()).toEqual(['itinerary.png']);
    expect(recognizeImages).not.toHaveBeenCalled(); // attaching alone reads nothing
    readBtn().click();

    await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
    expect(recognizeImages).toHaveBeenCalledTimes(1);

    const drafts = a.legs.getDrafts();
    expect(drafts.map((d) => d.flightNumber)).toEqual(['EK601', 'EK225']);
    expect(drafts[0].from).toBe('KHI');
    expect(drafts[0].to).toBe('DXB');
    expect(drafts.every((d) => d.needsReview)).toBe(true);
    expect(document.querySelector('.banner.review')!.hasAttribute('hidden')).toBe(false);
    // nothing computed until the user confirms
    expect(prayers()).toHaveLength(0);
    // untrusted OCR text is shown as text, never as markup
    expect(document.querySelector('.ocr-box img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect((document.querySelector('.ocr-box textarea') as HTMLTextAreaElement).value).toContain('<img src=x');

    // after review, Calculate works
    await a.calculate();
    await waitFor(() => prayers().length > 0);
    expect(document.body.textContent).not.toMatch(/NaN|Invalid Date/);
  });

  it('explains that PDFs cannot be read on-device and skips them', async () => {
    await mount();
    attach([pdf('ticket.pdf')]);
    readBtn().click();
    await waitFor(() => label().includes('PDF'));
    expect(recognizeImages).not.toHaveBeenCalled();
    expect(document.querySelector('.read-notes')!.textContent).toContain('ticket.pdf');
  });

  it('the file input accepts several images and PDFs at once', async () => {
    await mount();
    expect(fileInput().multiple).toBe(true);
    expect(fileInput().accept).toBe('image/*,application/pdf');
    expect(camInput().getAttribute('capture')).toBe('environment');
    expect(camInput().multiple).toBe(false);
  });

  it('attaches several files, lists them with count and total size, and keeps order', async () => {
    await mount();
    attach([png('a.png', 2048), pdf('b.pdf'), png('c.png', 1024)]);
    expect(names()).toEqual(['a.png', 'b.pdf', 'c.png']);
    expect(document.querySelector('.tray-title')!.textContent).toBe('3 files · 3 kB total');
    expect(document.querySelectorAll('.attach-thumb.pdf-icon')).toHaveLength(1);
    expect(document.querySelectorAll('img.attach-thumb')).toHaveLength(2);
    expect(readBtn().disabled).toBe(false);
    expect(document.querySelector('.cam-btn')!.textContent).toBe('Add another photo');
    // the camera input ADDS a photo each time
    attach([png('shot1.png', 10, 5)], camInput());
    attach([png('shot2.png', 10, 6)], camInput());
    expect(names()).toEqual(['a.png', 'b.pdf', 'c.png', 'shot1.png', 'shot2.png']);
  });

  it('moves files up/down, removes them, clears all, and revokes every object URL', async () => {
    await mount();
    attach([png('a.png'), png('b.png', 1000, 2), png('c.png', 1000, 3)]);
    expect(created).toHaveLength(3);
    btn('[aria-label^="Move c.png up"]').click();
    expect(names()).toEqual(['a.png', 'c.png', 'b.png']);
    // focus stays on the moved row's control (keyboard users can keep pressing it)
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toContain('Move c.png up');
    btn('[aria-label^="Move a.png down"]').click();
    expect(names()).toEqual(['c.png', 'a.png', 'b.png']);
    expect(btn('[aria-label^="Move c.png up"]').disabled).toBe(true);
    expect(btn('[aria-label^="Move b.png down"]').disabled).toBe(true);
    expect(created).toHaveLength(3); // re-rendering reuses the URLs
    expect(revoked).toHaveLength(0);

    btn('[aria-label="Remove a.png"]').click();
    expect(names()).toEqual(['c.png', 'b.png']);
    expect(revoked).toHaveLength(1);
    expect(document.querySelector('.tray-title')!.textContent).toMatch(/^2 files/);

    // Alt+ArrowDown on a row also reorders
    document.querySelector('.attach-item')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(names()).toEqual(['b.png', 'c.png']);

    btn('.attach-tray .tray-head .btn').click(); // Clear all
    expect(names()).toEqual([]);
    expect((document.querySelector('.attach-tray') as HTMLElement).hidden).toBe(true);
    expect(revoked).toHaveLength(3);
    expect(readBtn().disabled).toBe(true);
  });

  it('revokes object URLs when the app is unmounted', async () => {
    const a = await mount();
    attach([png('a.png'), png('b.png', 1000, 2)]);
    a.dispose();
    app = null;
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it('enforces the limits with friendly messages: type, duplicates, 10 MB each, 10 files, 25 MB total', async () => {
    await mount();
    attach([png('ok.png'), new File(['x'], 'notes.txt', { type: 'text/plain' }), new File(['x'], 'photo.heic', { type: 'image/heic' }), png('ok.png')]);
    expect(names()).toEqual(['ok.png']);
    expect(msgs()).toContain('notes.txt');
    expect(msgs()).toContain('not a supported file type');
    expect(msgs()).toContain('HEIC');
    expect(msgs()).toContain('already attached');

    attach([png('huge.png', 11 * 1024 * 1024)]);
    expect(names()).toEqual(['ok.png']);
    expect(msgs()).toContain('limit is 10 MB per file');

    attach([png('big1.png', 9 * 1024 * 1024, 11), png('big2.png', 9 * 1024 * 1024, 12), png('big3.png', 9 * 1024 * 1024, 13)]);
    expect(names()).toEqual(['ok.png', 'big1.png', 'big2.png']); // 1 kB + 18 MB; a third 9 MB file would pass 25 MB
    expect(msgs()).toContain('over 25 MB');

    attach(Array.from({ length: 12 }, (_, i) => png(`p${i}.png`, 100, 100 + i)));
    expect(names()).toHaveLength(10);
    expect(msgs()).toContain('up to 10 files');
    expect(msgs()).toContain('p7.png');
    expect(msgs()).toContain('and 4 more');
  });

  it('accepts files with an empty MIME type when the extension is known (drag-and-drop from some OSes)', async () => {
    await mount();
    attach([new File(['x'], 'shot.JPG', { type: '' }), new File(['x'], 'mystery', { type: '' })]);
    expect(names()).toEqual(['shot.JPG']);
    expect(msgs()).toContain('mystery');
  });

  it('drag-and-drop of several files', async () => {
    await mount();
    const drop = document.querySelector('.dropzone')!;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [png('d1.png'), png('d2.png', 1000, 2), pdf('d3.pdf')] } });
    drop.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(names()).toEqual(['d1.png', 'd2.png', 'd3.pdf']);
  });

  it('pastes images from the clipboard onto the tab (and ignores text / other tabs)', async () => {
    const a = await mount();
    const pasteEv = (files: File[]): Event => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { files, items: [] } });
      return ev;
    };
    const first = pasteEv([new File(['x'], 'image.png', { type: 'image/png' })]);
    document.querySelector('.photo-panel')!.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 2));
    document.dispatchEvent(pasteEv([new File(['y'], 'image.png', { type: 'image/png' })]));
    expect(names()).toEqual(['pasted-image-1.png', 'pasted-image-2.png']);
    const textOnly = pasteEv([]);
    document.dispatchEvent(textOnly);
    expect(textOnly.defaultPrevented).toBe(false);
    expect(names()).toHaveLength(2);
    // not while the Photo tab is hidden
    a.inputs.tabs.select('paste');
    document.dispatchEvent(pasteEv([new File(['z'], 'image.png', { type: 'image/png' })]));
    expect(names()).toHaveLength(2);
  });

  it('reads all photos in order, shows each under a separator, merges duplicates and orders the legs', async () => {
    const a = await mount();
    ocrMock.byName = { 'leg2.png': LEG2, 'leg1.png': LEG1, 'leg1-copy.png': `Booking\n${LEG1}\nSeat 41K` };
    attach([png('leg2.png'), png('leg1.png', 1000, 2), png('leg1-copy.png', 1000, 3)]);
    readBtn().click();
    await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));

    // ONE batch call with all images in tray order
    expect(recognizeImages).toHaveBeenCalledTimes(1);
    const batch = vi.mocked(recognizeImages).mock.calls[0]![0] as File[];
    expect(batch.map((f) => f.name)).toEqual(['leg2.png', 'leg1.png', 'leg1-copy.png']);

    const text = (document.querySelector('.ocr-box textarea') as HTMLTextAreaElement).value;
    expect(text).toContain('--- Photo 1: leg2.png ---');
    expect(text).toContain('--- Photo 2: leg1.png ---');
    expect(text).toContain('--- Photo 3: leg1-copy.png ---');
    expect(text.indexOf('--- Photo 1')).toBeLessThan(text.indexOf('EK 225'));
    expect(text.indexOf('EK 225')).toBeLessThan(text.indexOf('--- Photo 2'));

    const drafts = a.legs.getDrafts();
    expect(drafts.map((d) => d.flightNumber)).toEqual(['EK601', 'EK225']); // deduped, ordered by departure
    expect(drafts.every((d) => d.needsReview)).toBe(true);
    expect(document.querySelector('.banner.review')!.textContent).toContain('Found 2 legs across 3 photos — please review');
    expect(prayers()).toHaveLength(0); // never auto-calculates
    expect(label()).toContain('found 2 flights across 3 photos');
  });

  it('shows "Reading photo k of n — pct%" while reading', async () => {
    await mount();
    const seen: string[] = [];
    const obs = new MutationObserver(() => seen.push(label()));
    obs.observe(document.querySelector('.progress-label')!, { childList: true, characterData: true, subtree: true });
    attach([png('a.png'), png('b.png', 1000, 2), png('c.png', 1000, 3), png('d.png', 1000, 4)]);
    readBtn().click();
    await waitFor(() => label().includes('found'));
    await Promise.resolve();
    obs.disconnect();
    expect(seen).toContain('Reading photo 2 of 4 — 63%');
    expect(seen).toContain('Reading photo 4 of 4 — 63%');
  });

  it('a photo that fails does not stop the others; PDFs are skipped with a note; names cannot inject markup', async () => {
    const a = await mount();
    ocrMock.byName = { 'good.png': LEG1 };
    ocrMock.failing.add('bad.png');
    attach([png('good.png'), png('bad.png', 1000, 2), pdf('<img src=x onerror=window.__xss2=1>.pdf')]);
    readBtn().click();
    await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
    expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['EK601']);
    const notes = document.querySelector('.read-notes')!.textContent ?? '';
    expect(notes).toContain('bad.png');
    expect(notes).toContain('could not be read');
    expect(notes).toContain('PDF');
    // all three files get a separator; the unreadable ones stay empty so the user can type under them
    const text = (document.querySelector('.ocr-box textarea') as HTMLTextAreaElement).value;
    expect(text).toContain('--- Photo 2: bad.png ---');
    expect(text).toContain('--- Photo 3: <img src=x onerror=window.__xss2=1>.pdf ---');
    expect(document.querySelector('.photo-panel img[src=x]')).toBeNull();
    expect((window as unknown as { __xss2?: number }).__xss2).toBeUndefined();
    expect(document.querySelectorAll('.photo-panel .attach-name')[2]!.textContent).toBe('<img src=x onerror=window.__xss2=1>.pdf');
  });

  it('Cancel stops reading, keeps the files and changes nothing', async () => {
    const a = await mount();
    ocrMock.hang = true;
    attach([png('a.png'), png('b.png', 1000, 2)]);
    readBtn().click();
    await waitFor(() => label().includes('Reading photo 1 of 2'));
    expect(btn('.cancel-btn').hidden).toBe(false);
    expect(readBtn().disabled).toBe(true);
    expect(btn('[aria-label="Remove a.png"]').disabled).toBe(true); // no edits while reading
    btn('.cancel-btn').click();
    await waitFor(() => label().includes('Cancelled'));
    expect(names()).toEqual(['a.png', 'b.png']);
    expect(btn('.cancel-btn').hidden).toBe(true);
    expect(readBtn().disabled).toBe(false);
    expect(a.legs.getDrafts().some((d) => d.flightNumber)).toBe(false);
  });

  it('re-reading after adding a photo only runs OCR on the new one', async () => {
    const a = await mount();
    ocrMock.byName = { 'leg1.png': LEG1, 'leg2.png': LEG2 };
    attach([png('leg1.png')]);
    readBtn().click();
    await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
    attach([png('leg2.png', 1000, 2)]); // add another later
    readBtn().click();
    await waitFor(() => a.legs.getDrafts().length === 2);
    expect(recognizeImages).toHaveBeenCalledTimes(2);
    expect((vi.mocked(recognizeImages).mock.calls[1]![0] as File[]).map((f) => f.name)).toEqual(['leg2.png']);
    expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['EK601', 'EK225']);
  });

  describe('AI paths (backend healthy)', () => {
    const health = { ok: true, providers: { anthropic: false, openai: false, aerodatabox: false, flightaware: false, opensky: false, adsbdb: true, adsblol: true } };
    const aiLegs = [
      { flightNumber: 'EK225', from: 'DXB', to: 'SFO', depDate: '2026-10-12', depTime: '09:55', arrTime: '15:05', confidence: 0.9, raw: [] },
      { flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrTime: '04:20', confidence: 0.9, raw: [] },
      { flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', confidence: 0.5, raw: [] },
    ];
    const pick = (value: string): void => {
      const r = document.querySelector(`.ai-modes input[value="${value}"]`) as HTMLInputElement;
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    };

    it('the mode chooser is hidden until the backend is healthy', async () => {
      const a = await mount();
      expect((document.querySelector('.ai-modes') as HTMLElement).hidden).toBe(true);
      a.inputs.setBackend(health);
      expect((document.querySelector('.ai-modes') as HTMLElement).hidden).toBe(false);
    });

    it('"Read with AI" sends ALL attachments (PDFs too) in ONE request, in tray order', async () => {
      const a = await mount();
      a.inputs.setBackend(health);
      pick('ai-image');
      apiMock.extract = async () => ({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', legs: aiLegs, warnings: ['Page 2 was blurry.'] });
      attach([png('p1.png'), pdf('p2.pdf'), png('p3.png', 1000, 3)]);
      btn('[aria-label="Move p3.png up (to number 2)"]').click(); // tray order is now p1, p3, p2
      readBtn().click();
      await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
      expect(extractItinerary).toHaveBeenCalledTimes(1);
      const [input, opts] = vi.mocked(extractItinerary).mock.calls[0]! as unknown as [File[], { referenceDate: string; signal: AbortSignal }];
      expect(input.map((f) => f.name)).toEqual(['p1.png', 'p3.png', 'p2.pdf']);
      expect(opts.referenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(recognizeImages).not.toHaveBeenCalled(); // no OCR on this path
      expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['EK601', 'EK225']); // merged + ordered
      expect(label()).toContain('Page 2 was blurry.');
      expect(document.querySelector('.banner.review')!.textContent).toContain('Found 2 legs across 3 photos — please review');
      expect(prayers()).toHaveLength(0);
    });

    it('a single attachment keeps the original single-file request', async () => {
      const a = await mount();
      a.inputs.setBackend(health);
      pick('ai-image');
      apiMock.extract = async () => ({ provider: 'openrouter', model: 'm', legs: aiLegs.slice(0, 1), warnings: [] });
      const only = png('only.png');
      attach([only]);
      readBtn().click();
      await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
      expect(vi.mocked(extractItinerary).mock.calls[0]![0]).toBe(only);
    });

    it('"AI on extracted text only" sends the combined text, without file names', async () => {
      const a = await mount();
      a.inputs.setBackend(health);
      pick('ai-text');
      ocrMock.byName = { 'secret-name-1.png': LEG1, 'secret-name-2.png': LEG2 };
      apiMock.extract = async () => ({ provider: 'openrouter', model: 'm', legs: aiLegs, warnings: [] });
      attach([png('secret-name-1.png'), png('secret-name-2.png', 1000, 2)]);
      readBtn().click();
      await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
      const [input] = vi.mocked(extractItinerary).mock.calls[0]! as unknown as [{ text: string }];
      expect(input.text).toContain('--- Photo 1 ---');
      expect(input.text).toContain('--- Photo 2 ---');
      expect(input.text).toContain('EK 601');
      expect(input.text).not.toContain('secret-name');
      expect(vi.mocked(recognizeImages).mock.calls[0]![0]).toHaveLength(2);
      expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['EK601', 'EK225']);
    });

    it('falls back to the on-device parser when the AI call fails', async () => {
      const a = await mount();
      a.inputs.setBackend(health);
      pick('ai-text');
      ocrMock.byName = { 'x.png': LEG1 };
      apiMock.extract = async () => {
        throw new Error('boom');
      };
      attach([png('x.png')]);
      readBtn().click();
      await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
      expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['EK601']);
    });
  });
});

describe('legs editor', () => {
  it('autofills from the library on flight-number blur and shows tz-labelled fields', async () => {
    const a = await mount();
    const fn = document.querySelector('.leg input[placeholder="e.g. EK601"]') as HTMLInputElement;
    fn.dispatchEvent(new Event('focus'));
    fn.value = 'ek 601';
    fn.dispatchEvent(new Event('input', { bubbles: true }));
    fn.dispatchEvent(new Event('blur'));
    const d = a.legs.getDrafts()[0];
    expect(d.from).toBe('KHI');
    expect(d.to).toBe('DXB');
    expect(d.depLocal).toMatch(/T02:55$/);
    expect(document.querySelector('.leg')!.textContent).toContain('KHI local, UTC+05:00');
  });

  it('shows friendly errors for incomplete legs when calculating', async () => {
    const a = await mount();
    await a.calculate();
    expect(document.querySelector('.error-card')).toBeTruthy();
    expect(document.querySelector('.validation')!.textContent).toContain('choose a departure airport');
  });

  it('adds, reorders and removes legs', async () => {
    const a = await mount();
    a.legs.addLeg(blankLeg({ flightNumber: 'AA1' }));
    a.legs.addLeg(blankLeg({ flightNumber: 'BB2' }));
    expect(a.legs.getDrafts().length).toBe(2); // the lone blank leg was replaced by the first
    (document.querySelector('[aria-label="Move leg 2 up"]') as HTMLButtonElement).click();
    expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['BB2', 'AA1']);
    (document.querySelector('[aria-label="Remove leg 1"]') as HTMLButtonElement).click();
    expect(a.legs.getDrafts().map((d) => d.flightNumber)).toEqual(['AA1']);
  });
});

describe('helpers', () => {
  it('h() never turns strings into markup', () => {
    const el = h('div', null, '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('parseNumber rejects empty, NaN and Infinity', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('  ')).toBeNull();
    expect(parseNumber('NaN')).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
    expect(parseNumber('1e999')).toBeNull();
    expect(parseNumber('18')).toBe(18);
    expect(parseNumber(' -2.5 ')).toBe(-2.5);
    expect(parseNumber('12,5')).toBe(12.5);
  });

  it('share hash round-trips legs and settings and rejects garbage', () => {
    const s = defaultAppSettings();
    s.prayer.madhab = 'shafii';
    const legs = [blankLeg({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depLocal: '2026-10-12T02:55', arrLocal: '2026-10-12T04:20', cruiseFt: '37000' })];
    const hash = encodeShareHash(legs, s);
    const back = decodeShareHash(hash)!;
    expect(back.legs[0].from).toBe('KHI');
    expect(back.legs[0].cruiseFt).toBe('37000');
    expect(back.settings.prayer.madhab).toBe('shafii');
    expect(decodeShareHash('#s=@@@')).toBeNull();
    expect(decodeShareHash('#s=eyJ2IjoyfQ')).toBeNull();
    expect(decodeShareHash('')).toBeNull();
  });

  it('restores a shared itinerary from the URL hash on load', async () => {
    const legs = [blankLeg({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depLocal: '2026-10-12T02:55', arrLocal: '2026-10-12T04:20' })];
    history.replaceState(null, '', encodeShareHash(legs, defaultAppSettings()));
    const a = await mount();
    await a.whenIdle();
    await waitFor(() => prayers().length > 0);
    expect(a.legs.getDrafts()[0].flightNumber).toBe('EK601');
  });

  it('terminator polygon is finite and closed at a pole', () => {
    const d = new Date('2026-06-21T12:00:00Z');
    const sub = subsolarPoint(d);
    expect(sub.lat).toBeGreaterThan(23);
    expect(Math.abs(sub.lon)).toBeLessThan(10);
    const poly = nightPolygon(d);
    expect(poly.every(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo))).toBe(true);
    expect(poly[poly.length - 1][0]).toBe(-90);
  });

  it('Qibla phrases', () => {
    expect(qiblaPhrase(266, 42, false)).toContain("42° to the right of the aircraft's nose");
    expect(qiblaPhrase(266, -170, false)).toContain('behind you, 10° left of the tail');
    expect(qiblaPhrase(266, 0, false)).toContain('straight ahead');
    expect(qiblaPhrase(266, 10, true)).toContain('266° W');
  });
});
