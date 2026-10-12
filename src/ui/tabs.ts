/** Minimal accessible tabs (WAI-ARIA tabs pattern, automatic activation, arrow-key navigation). */
import { h, uid } from './dom';

export interface TabDef {
  id: string;
  label: string;
  panel: HTMLElement;
}

export interface TabsHandle {
  el: HTMLElement;
  select(id: string): void;
  current(): string;
}

export function createTabs(defs: TabDef[], initial?: string, ariaLabel = 'Ways to enter your itinerary'): TabsHandle {
  const base = uid('tabs');
  const list = h('div', { role: 'tablist', class: 'tablist', 'aria-label': ariaLabel });
  const buttons = new Map<string, HTMLButtonElement>();
  let current = initial ?? defs[0].id;

  const root = h('div', { class: 'tabs' }, list);
  for (const d of defs) {
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `${base}-tab-${d.id}`,
        class: 'tab',
        'aria-controls': `${base}-panel-${d.id}`,
        onClick: () => select(d.id),
      },
      d.label,
    );
    btn.addEventListener('keydown', (e) => {
      const i = defs.findIndex((x) => x.id === d.id);
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % defs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + defs.length) % defs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = defs.length - 1;
      if (n >= 0) {
        e.preventDefault();
        select(defs[n].id);
        buttons.get(defs[n].id)?.focus();
      }
    });
    buttons.set(d.id, btn);
    list.appendChild(btn);
    d.panel.setAttribute('role', 'tabpanel');
    d.panel.id = `${base}-panel-${d.id}`;
    d.panel.setAttribute('aria-labelledby', `${base}-tab-${d.id}`);
    d.panel.classList.add('tabpanel');
    root.appendChild(d.panel);
  }

  function select(id: string): void {
    current = id;
    for (const d of defs) {
      const on = d.id === id;
      const b = buttons.get(d.id)!;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      d.panel.hidden = !on;
    }
  }
  select(current);
  return { el: root, select, current: () => current };
}
