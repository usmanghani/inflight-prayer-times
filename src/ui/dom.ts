/**
 * Tiny DOM building helpers. Everything goes through createElement / textContent, so
 * untrusted strings (OCR text, file names, API data) can never become markup.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = {
  [key: string]: unknown;
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string | number | boolean | undefined>;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else Object.assign((el as HTMLElement).style, value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined && v !== null) (el as HTMLElement).dataset[k] = String(v);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === 'checked' && 'checked' in el) {
      (el as HTMLInputElement).checked = Boolean(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function appendChildren(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(parent, c);
    else if (typeof c === 'string' || typeof c === 'number') parent.appendChild(document.createTextNode(String(c)));
    else parent.appendChild(c);
  }
}

/** h('div', { class: 'x', onClick: fn }, 'text', childEl, [more, children]) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

/** SVG element builder (createElementNS). */
export function svg(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el as SVGElement;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace the content of `el`. */
export function setChildren(el: Element, ...children: Child[]): void {
  clear(el);
  appendChildren(el, children);
}

let uidCounter = 0;
export function uid(prefix = 'id'): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/** Debounce helper. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...a: A): void => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...a);
    }, ms);
  };
  wrapped.cancel = () => {
    if (t !== undefined) clearTimeout(t);
    t = undefined;
  };
  return wrapped;
}

/** Parse a user-typed number. Rejects empty strings, NaN and +-Infinity (returns null). */
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/,/g, '.');
  if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
