// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OCR_TEXT = [
  'Booking confirmation <img src=x onerror="window.__xss=1">',
  'EK 601  Karachi (KHI)  Mon 12 Oct 2026  02:55',
  'Arrives Dubai (DXB)  04:20',
  'EK 225  Dubai (DXB)  Mon 12 Oct 2026  09:55',
  'Arrives San Francisco (SFO)  15:05',
].join('\n');

vi.mock('../src/ocr/ocr', () => ({
  recognizeImage: vi.fn(async (_img: unknown, onProgress?: (p: { status: string; progress: number }) => void) => {
    onProgress?.({ status: 'recognizing text', progress: 0.5 });
    onProgress?.({ status: 'recognizing text', progress: 1 });
    return OCR_TEXT;
  }),
}));

import { mountApp, type AppHandle } from '../src/ui/app';
import { recognizeImage } from '../src/ocr/ocr';
import { h, parseNumber } from '../src/ui/dom';
import { decodeShareHash, encodeShareHash } from '../src/ui/persist';
import { defaultAppSettings, blankLeg } from '../src/ui/model';
import { nightPolygon, subsolarPoint } from '../src/ui/terminator';
import { qiblaPhrase } from '../src/ui/format';

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
    expect(localStorage.getItem('ipt.ui.settings.v1')).toContain('maliki');
  });
});

describe('photo / OCR path', () => {
  it('reads an image on-device, fills the legs editor and does NOT calculate by itself', async () => {
    const a = await mount();
    const input = document.querySelector('.photo-panel input[type=file]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'itinerary.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => a.legs.getDrafts().some((d) => d.flightNumber));
    expect(recognizeImage).toHaveBeenCalledTimes(1);

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

  it('explains that PDFs cannot be read on-device', async () => {
    await mount();
    const input = document.querySelector('.photo-panel input[type=file]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'ticket.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => (document.querySelector('.progress-label')?.textContent ?? '').includes('PDF'));
    expect(recognizeImage).not.toHaveBeenCalled();
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
