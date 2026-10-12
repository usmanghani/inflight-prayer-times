/**
 * Photo / PDF tab: attach several itinerary photos (picker, drag-and-drop, paste, camera), order them in a
 * tray, then read them all together into one list of legs. Untrusted strings (file names, OCR text) only
 * ever reach the DOM through h() / textContent.
 */
import type { InputContext } from './inputTabs';
import { h, setChildren, uid, todayIso, clear } from './dom';
import { parsedToDrafts, type ParsedLike } from './parsed';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  addFiles,
  formatBytes,
  moveAttachment,
  totalBytes,
  type Attachment,
} from './attachments';
import { recognizeImages } from '../ocr/ocr';
import { extractItinerary, type HealthResponse } from '../api/client';

const AI_LABEL = 'Read with AI (DeepSeek V4.1 Flash via your backend — ALL your attachments are sent to the server together)';
const AI_TEXT_LABEL = 'AI on extracted text only (cheaper: the photos stay on this device; only the recognised text is sent)';

type ReadMode = 'ocr' | 'ai-text' | 'ai-image';

async function parseCombined(text: string, ctx: InputContext): Promise<ParsedLike[]> {
  const { parseItineraryPages } = await import('../ocr/parseItinerary');
  return parseItineraryPages([text], { isKnownIata: (c) => !!ctx.api.getAirport(c), referenceDate: new Date() });
}

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface PhotoPanel {
  el: HTMLElement;
  setBackend(health: HealthResponse | null): void;
  dispose(): void;
}

export function createPhotoPanel(ctx: InputContext): PhotoPanel {
  let items: Attachment[] = [];
  const urls = new Map<string, string>(); // object URLs for image thumbnails
  const ocrCache = new Map<string, string>(); // attachment id -> recognised text (successful reads only)
  let mode: ReadMode = 'ocr';
  let busy = false;
  let abort: AbortController | null = null;
  let pastedCount = 0;

  // ── controls ──
  const fileId = uid('photo');
  const fileInput = h('input', { id: fileId, type: 'file', multiple: true, accept: 'image/*,application/pdf', class: 'visually-hidden' });
  const camId = uid('cam');
  const camInput = h('input', { id: camId, type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });
  const camLabel = h('label', { class: 'btn cam-btn', for: camId }, 'Take a photo');
  const messages = h('ul', { class: 'attach-msgs', role: 'status', 'aria-live': 'polite', hidden: true });
  const trayTitle = h('strong', { class: 'tray-title' });
  const trayNote = h('span', { class: 'hint tray-note' });
  const clearBtn = h('button', { type: 'button', class: 'btn small', onClick: () => clearAll() }, 'Clear all');
  const list = h('ol', { class: 'attach-list', 'aria-label': 'Attached files, in reading order' });
  const tray = h(
    'section',
    { class: 'attach-tray', hidden: true, 'aria-label': 'Attached files' },
    h('div', { class: 'tray-head' }, h('div', { class: 'tray-sum' }, trayTitle, trayNote), clearBtn),
    list,
  );
  const readBtn = h('button', { type: 'button', class: 'btn primary read-btn', disabled: true, onClick: () => void readAll() }, 'Read itinerary');
  const cancelBtn = h('button', { type: 'button', class: 'btn cancel-btn', hidden: true, onClick: () => abort?.abort() }, 'Cancel');
  const progressLabel = h('div', { class: 'progress-label', role: 'status', 'aria-live': 'polite' });
  const progress = h('progress', { class: 'progress', max: 1, value: 0, hidden: true, 'aria-label': 'Reading progress' });
  const notes = h('ul', { class: 'read-notes', hidden: true });
  const ocrBox = h('div', { class: 'ocr-box', hidden: true });
  const aiBox = h('fieldset', { class: 'ai-modes', hidden: true });

  const drop = h(
    'div',
    { class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': 'Choose or drop itinerary photos or PDFs (several allowed)' },
    h('p', { class: 'drop-title' }, 'Drop screenshots, photos or PDFs of your itinerary here'),
    h(
      'p',
      { class: 'hint' },
      `One per leg, or the pages of a long e-ticket: add up to ${MAX_FILES} and they are read together. You can also paste an image (Ctrl/Cmd+V). They are read on this device with OCR; nothing is uploaded unless you choose AI reading.`,
    ),
    h('div', { class: 'row center wrap' }, h('label', { class: 'btn primary', for: fileId }, 'Choose files'), camLabel),
  );
  drop.addEventListener('keydown', (e) => {
    if (e.target !== drop) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    attach(Array.from((e as DragEvent).dataTransfer?.files ?? []));
  });
  for (const inp of [fileInput, camInput]) {
    inp.addEventListener('change', () => {
      attach(Array.from(inp.files ?? []));
      inp.value = '';
    });
  }

  // Ctrl/Cmd+V with an image (or PDF) on the clipboard while this tab is showing.
  const onPaste = (e: Event): void => {
    const cd = (e as ClipboardEvent).clipboardData;
    if (!cd || el.closest('[hidden]') || !el.isConnected) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target && !el.contains(target) && (/^(?:input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)) return;
    let files = Array.from(cd.files ?? []);
    if (files.length === 0) {
      files = Array.from(cd.items ?? [])
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
    }
    files = files.filter((f) => /^image\/|^application\/pdf$/i.test(f.type));
    if (files.length === 0) return;
    e.preventDefault();
    attach(
      files.map((f) => {
        // Clipboard images are all called "image.png": give them distinct, readable names.
        if (!/^image\.[a-z]+$/i.test(f.name) && f.name) return f;
        pastedCount += 1;
        const ext = /pdf/i.test(f.type) ? 'pdf' : (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        return new File([f], `pasted-image-${pastedCount}.${ext}`, { type: f.type, lastModified: Date.now() });
      }),
    );
  };
  document.addEventListener('paste', onPaste);

  // ── tray ──
  function setProgress(status: string, value: number | null): void {
    progress.hidden = value === null;
    if (value !== null) progress.value = Math.max(0, Math.min(1, value));
    setChildren(progressLabel, status);
  }

  function showMessages(msgs: string[]): void {
    messages.hidden = msgs.length === 0;
    setChildren(messages, msgs.map((m) => h('li', null, m)));
  }

  function revoke(id: string): void {
    const u = urls.get(id);
    if (u && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(u);
    urls.delete(id);
  }

  function urlFor(a: Attachment): string | null {
    if (a.kind !== 'image' || typeof URL.createObjectURL !== 'function') return null;
    let u = urls.get(a.id);
    if (!u) {
      u = URL.createObjectURL(a.file);
      urls.set(a.id, u);
    }
    return u;
  }

  function attach(files: File[]): void {
    if (files.length === 0) return;
    if (busy) {
      showMessages(['Please wait until reading has finished, or press Cancel, before adding files.']);
      return;
    }
    const res = addFiles(items, files);
    items = res.next;
    showMessages(res.messages);
    renderTray();
    if (res.added.length) ctx.announce(`${plural(res.added.length, 'file')} added. ${plural(items.length, 'file')} attached.`);
    else if (res.messages.length) ctx.announce(res.messages[0]!);
  }

  function removeAt(i: number): void {
    const gone = items[i];
    if (!gone || busy) return;
    revoke(gone.id);
    ocrCache.delete(gone.id);
    items = items.filter((_, k) => k !== i);
    showMessages([]);
    renderTray();
    ctx.announce(`Removed ${gone.file.name.slice(0, 60)}. ${plural(items.length, 'file')} attached.`);
    // keep keyboard focus inside the tray
    const nextBtn = list.querySelectorAll<HTMLButtonElement>('button.remove-btn')[Math.min(i, items.length - 1)];
    (nextBtn ?? drop).focus();
  }

  function move(i: number, delta: number): void {
    if (busy) return;
    const next = moveAttachment(items, i, delta);
    if (next === items) return;
    items = next;
    renderTray();
    const to = i + delta;
    const rows = list.querySelectorAll<HTMLElement>('.attach-item');
    const row = rows[to];
    // focus the same control on the moved row (or its sibling when it is now disabled)
    const wanted = row?.querySelector<HTMLButtonElement>(delta < 0 ? 'button.up-btn' : 'button.down-btn');
    const fallback = row?.querySelector<HTMLButtonElement>(delta < 0 ? 'button.down-btn' : 'button.up-btn');
    (wanted && !wanted.disabled ? wanted : fallback)?.focus();
    ctx.announce(`${items[to]!.file.name.slice(0, 60)} is now number ${to + 1} of ${items.length}.`);
  }

  function clearAll(): void {
    if (busy) return;
    for (const a of items) revoke(a.id);
    ocrCache.clear();
    items = [];
    showMessages([]);
    renderTray();
    ctx.announce('All files removed.');
    drop.focus();
  }

  function renderTray(): void {
    tray.hidden = items.length === 0;
    readBtn.disabled = items.length === 0 || busy;
    clearBtn.disabled = busy;
    camLabel.textContent = items.length ? 'Add another photo' : 'Take a photo';
    setChildren(trayTitle, `${plural(items.length, 'file')} · ${formatBytes(totalBytes(items))} total`);
    setChildren(trayNote, `Limits: ${MAX_FILES} files, ${formatBytes(MAX_FILE_BYTES)} each, ${formatBytes(MAX_TOTAL_BYTES)} in total. Order = reading order.`);
    clear(list);
    items.forEach((a, i) => {
      const name = a.file.name || 'file';
      const src = urlFor(a);
      const thumb = src
        ? h('img', { class: 'attach-thumb', src, alt: '', width: 56, height: 56 })
        : h('span', { class: 'attach-thumb pdf-icon', 'aria-hidden': 'true' }, a.kind === 'pdf' ? 'PDF' : 'IMG');
      const row = h(
        'li',
        { class: 'attach-item', dataset: { attId: a.id } },
        thumb,
        h(
          'div',
          { class: 'attach-info' },
          h('span', { class: 'attach-name', title: name }, name),
          h('span', { class: 'muted attach-meta' }, `${a.kind === 'pdf' ? 'PDF' : 'Photo'} ${i + 1} of ${items.length} · ${formatBytes(a.file.size)}`),
        ),
        h(
          'div',
          { class: 'attach-actions' },
          h('button', { type: 'button', class: 'btn small icon up-btn', disabled: busy || i === 0, 'aria-label': `Move ${name} up (to number ${i})`, title: 'Move up', onClick: () => move(i, -1) }, '↑'),
          h('button', { type: 'button', class: 'btn small icon down-btn', disabled: busy || i === items.length - 1, 'aria-label': `Move ${name} down (to number ${i + 2})`, title: 'Move down', onClick: () => move(i, 1) }, '↓'),
          h('button', { type: 'button', class: 'btn small icon danger remove-btn', disabled: busy, 'aria-label': `Remove ${name}`, title: 'Remove', onClick: () => removeAt(i) }, '✕'),
        ),
      );
      row.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        move(i, e.key === 'ArrowUp' ? -1 : 1);
      });
      list.appendChild(row);
    });
  }

  function setBusy(on: boolean): void {
    busy = on;
    cancelBtn.hidden = !on;
    drop.setAttribute('aria-disabled', String(on));
    renderTray();
  }

  // ── reading ──
  function showNotes(lines: string[]): void {
    notes.hidden = lines.length === 0;
    setChildren(notes, lines.map((l) => h('li', null, l)));
  }

  function showOcrText(text: string): void {
    ocrBox.hidden = false;
    const ta = h('textarea', { rows: 10, class: 'mono', 'aria-label': 'Recognised text (editable)', spellcheck: 'false' });
    ta.value = text;
    setChildren(
      ocrBox,
      h('label', null, 'Recognised text (you can fix it and read it again)'),
      h('p', { class: 'hint' }, 'Each file’s text sits under its own separator line, ', h('code', { class: 'nowrap' }, '--- Photo 2: name ---'), '. Those lines are ignored when reading.'),
      ta,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onClick: () =>
              void (async () => {
                const pages = (ta.value.match(/^[ \t]*---[ \t]*Photo[ \t]+\d+/gm) ?? []).length;
                deliver(await parseCombined(ta.value, ctx), 'Recognised text', pages || 1);
              })(),
          },
          'Read this text again',
        ),
      ),
    );
  }

  function deliver(parsed: ParsedLike[], source: string, sources: number): void {
    if (parsed.length === 0) {
      setProgress(`${source}: no flights were recognised. You can edit the text below and read it again, or enter the legs by hand.`, null);
      ctx.announce('No flights recognised.');
      return;
    }
    const drafts = parsedToDrafts(parsed, ctx.api.getAirport);
    const across = sources > 1 ? ` across ${sources} photos` : '';
    setProgress(`${source}: found ${plural(drafts.length, 'flight')}${across}. Review them in “Your flights” and press Calculate.`, null);
    ctx.setLegs(drafts, {
      review: true,
      message: `Found ${plural(drafts.length, 'leg')}${across} — please review (${source}). Check every airport, date and time.`,
    });
    ctx.announce(`Found ${plural(drafts.length, 'flight')}${across}. Please review them.`);
  }

  async function readAll(): Promise<void> {
    if (busy || items.length === 0) return;
    const snapshot = items.slice();
    const ac = new AbortController();
    abort = ac;
    setBusy(true);
    ocrBox.hidden = true;
    showNotes([]);
    try {
      if (mode === 'ai-image') {
        setProgress(`Sending ${plural(snapshot.length, 'file')} to your backend for AI reading…`, null);
        progress.hidden = false;
        progress.removeAttribute('value'); // indeterminate
        // One attachment keeps the original single-file request shape (works with older backends too).
        const res = await extractItinerary(snapshot.length === 1 ? snapshot[0]!.file : snapshot.map((a) => a.file), {
          referenceDate: todayIso(),
          signal: ac.signal,
        });
        const { mergeParsedLegs } = await import('../ocr/parseItinerary');
        deliver(mergeParsedLegs([res.legs]), `AI (${res.model})`, snapshot.length);
        if (res.warnings.length) setChildren(progressLabel, progressLabel.textContent ?? '', ` Warnings: ${res.warnings.join(' ')}`);
        return;
      }

      // ── on-device OCR (also the first step of "AI on extracted text only") ──
      const { pageSeparator } = await import('../ocr/parseItinerary');
      const lines: string[] = [];
      const todo = snapshot.filter((a) => a.kind === 'image' && !ocrCache.has(a.id));
      const imageCount = snapshot.filter((a) => a.kind === 'image').length;
      const errors = new Map<string, string>();
      snapshot.forEach((a, i) => {
        if (a.kind === 'pdf') lines.push(`Photo ${i + 1} (${a.file.name.slice(0, 60)}) is a PDF. PDFs cannot be read on this device, so it was skipped. Take a screenshot of the page, paste its text under its line below, or use AI reading.`);
      });
      if (imageCount === 0) {
        setProgress('On-device reading of PDFs is not available. Take a screenshot of the page (or paste its text), or enable AI reading if your backend offers it.', null);
        showNotes(lines);
        return;
      }
      if (todo.length > 0) {
        setProgress('Starting the on-device OCR engine (the first run downloads its language data)…', 0);
        const results = await recognizeImages(
          todo.map((a) => a.file),
          (p) => {
            const pct = Math.round(Math.max(0, Math.min(1, p.progress)) * 100);
            const reading = p.status === 'recognizing text' || p.status === 'starting' || p.status === 'done';
            setProgress(
              reading
                ? `Reading photo ${p.index + 1} of ${p.total} — ${pct}%`
                : `Preparing the OCR engine (${p.status || 'loading'}) — ${pct}%`,
              (p.index + (reading ? p.progress : 0)) / p.total,
            );
          },
          ac.signal,
        );
        results.forEach((r) => {
          const a = todo[r.index]!;
          if (r.error) errors.set(a.id, r.error);
          else ocrCache.set(a.id, r.text);
        });
      }
      snapshot.forEach((a, i) => {
        const err = errors.get(a.id);
        if (err) lines.push(`Photo ${i + 1} (${a.file.name.slice(0, 60)}) could not be read: ${err}. The other photos were still read.`);
      });
      showNotes(lines);

      const combine = (withNames: boolean): string =>
        snapshot
          .map((a, i) => `${pageSeparator(i + 1, withNames ? a.file.name : undefined)}\n${(ocrCache.get(a.id) ?? '').trim()}`)
          .join('\n\n');
      const text = combine(true);
      showOcrText(text);

      if (mode === 'ai-text') {
        setProgress('Sending the recognised text (not the photos) to your backend…', null);
        progress.hidden = false;
        progress.removeAttribute('value');
        try {
          // The names are not needed by the model: send generic "--- Photo k ---" separators only.
          const res = await extractItinerary({ text: combine(false) }, { referenceDate: todayIso(), signal: ac.signal });
          const { mergeParsedLegs } = await import('../ocr/parseItinerary');
          deliver(mergeParsedLegs([res.legs]), `AI on text (${res.model})`, imageCount);
          return;
        } catch (e) {
          if (isAbort(e)) throw e;
          setProgress(`AI reading failed (${e instanceof Error ? e.message : 'error'}); using the on-device parser instead.`, null);
        }
      }
      deliver(await parseCombined(text, ctx), 'On-device OCR', imageCount);
    } catch (e) {
      if (isAbort(e)) {
        setProgress('Cancelled. Your files are still attached; nothing was changed.', null);
        ctx.announce('Reading cancelled.');
      } else {
        const msg = e instanceof Error ? e.message : 'unknown error';
        setProgress(
          `Could not read the files: ${msg}. If you are offline, the OCR engine could not download its language data. You can paste the text or enter the legs by hand.`,
          null,
        );
        ctx.announce('Reading the files failed.');
      }
    } finally {
      abort = null;
      setBusy(false);
    }
  }

  // ── read mode ──
  const modeName = uid('mode');
  function radio(value: ReadMode, label: string, checked: boolean): HTMLElement {
    const id = uid('rm');
    const input = h('input', { type: 'radio', name: modeName, id, value, checked });
    input.addEventListener('change', () => {
      if (input.checked) mode = value;
    });
    return h('div', { class: 'check' }, input, h('label', { for: id }, label));
  }
  setChildren(
    aiBox,
    h('legend', null, 'How should it be read?'),
    radio('ocr', 'On this device only (private, default)', true),
    radio('ai-text', AI_TEXT_LABEL, false),
    radio('ai-image', AI_LABEL, false),
  );

  const el = h(
    'div',
    { class: 'photo-panel' },
    drop,
    fileInput,
    camInput,
    messages,
    tray,
    aiBox,
    h('div', { class: 'row read-row' }, readBtn, cancelBtn),
    progress,
    progressLabel,
    notes,
    ocrBox,
  );
  renderTray();

  return {
    el,
    setBackend(health) {
      aiBox.hidden = !health || !health.ok;
      if (aiBox.hidden) {
        mode = 'ocr';
        const first = aiBox.querySelector<HTMLInputElement>('input[type=radio]');
        if (first) first.checked = true;
      }
    },
    dispose() {
      abort?.abort();
      document.removeEventListener('paste', onPaste);
      for (const id of Array.from(urls.keys())) revoke(id);
      items = [];
      ocrCache.clear();
    },
  };
}
