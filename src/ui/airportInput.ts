/** Accessible airport autocomplete (ARIA combobox + listbox). */
import type { Airport } from '../types';
import { formatOffset, utcOffsetMinutes } from '../time/tz';
import { h, setChildren, uid } from './dom';

export interface AirportApi {
  getAirport(iata: string): Airport | undefined;
  searchAirports(query: string, limit?: number): Airport[];
}

export interface AirportInputOptions {
  label: string;
  value: string;
  api: AirportApi;
  onChange: (iata: string) => void;
  /** Reference instant used to show the UTC offset in the caption. */
  offsetAt?: () => Date;
}

export interface AirportInputHandle {
  el: HTMLElement;
  input: HTMLInputElement;
  setValue(iata: string): void;
  getValue(): string;
  refreshCaption(): void;
}

export function airportOptionText(a: Airport): string {
  return `${a.iata} — ${a.name}, ${a.city}`;
}

export function createAirportInput(opts: AirportInputOptions): AirportInputHandle {
  const inputId = uid('apt');
  const listId = uid('apt-list');
  const capId = uid('apt-cap');
  let active = -1;
  let results: Airport[] = [];

  const input = h('input', {
    id: inputId,
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-describedby': capId,
    placeholder: 'e.g. KHI or Karachi',
    value: opts.value,
    maxlength: 60,
  });
  const list = h('ul', { id: listId, role: 'listbox', class: 'ac-list', hidden: true, 'aria-label': `${opts.label} suggestions` });
  const caption = h('div', { id: capId, class: 'ac-caption' });

  const close = (): void => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const refreshCaption = (): void => {
    const a = opts.api.getAirport(input.value.trim().toUpperCase());
    if (!a) {
      setChildren(caption, input.value.trim() ? 'Not a known airport code — pick a suggestion.' : '');
      caption.classList.toggle('bad', !!input.value.trim());
      return;
    }
    caption.classList.remove('bad');
    let off = '';
    try {
      off = ` · ${a.tz} (UTC${formatOffset(utcOffsetMinutes(opts.offsetAt ? opts.offsetAt() : new Date(), a.tz))})`;
    } catch {
      off = ` · ${a.tz}`;
    }
    setChildren(caption, `${a.name}, ${a.city}${off}`);
  };

  const commit = (a: Airport): void => {
    input.value = a.iata;
    close();
    refreshCaption();
    opts.onChange(a.iata);
  };

  const renderList = (): void => {
    setChildren(list);
    results.forEach((a, i) => {
      const li = h(
        'li',
        {
          id: `${listId}-${i}`,
          role: 'option',
          class: 'ac-item',
          'aria-selected': i === active ? 'true' : 'false',
          onMousedown: (e: Event) => {
            e.preventDefault(); // keep focus; commit before blur
            commit(a);
          },
        },
        h('strong', null, a.iata),
        ` — ${a.name}, ${a.city}`,
        h('span', { class: 'muted' }, ` (${a.country})`),
      );
      list.appendChild(li);
    });
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', results.length === 0 ? 'false' : 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    results = q ? opts.api.searchAirports(q, 8) : [];
    active = -1;
    renderList();
    refreshCaption();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (results.length === 0) return;
      e.preventDefault();
      active = e.key === 'ArrowDown' ? (active + 1) % results.length : (active - 1 + results.length) % results.length;
      renderList();
    } else if (e.key === 'Enter') {
      if (!list.hidden && results.length > 0) {
        e.preventDefault();
        commit(results[active >= 0 ? active : 0]);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => {
    // Commit what was typed: a known code stays, an unambiguous search hit is adopted.
    const typed = input.value.trim();
    const exact = opts.api.getAirport(typed.toUpperCase());
    if (exact) {
      input.value = exact.iata;
      opts.onChange(exact.iata);
    } else if (typed) {
      opts.onChange(typed.toUpperCase());
    } else {
      opts.onChange('');
    }
    close();
    refreshCaption();
  });

  const el = h('div', { class: 'field ac' }, h('label', { for: inputId }, opts.label), input, list, caption);
  refreshCaption();

  return {
    el,
    input,
    setValue(iata: string) {
      input.value = iata;
      refreshCaption();
    },
    getValue() {
      return input.value.trim().toUpperCase();
    },
    refreshCaption,
  };
}
