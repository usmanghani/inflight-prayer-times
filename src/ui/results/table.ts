/** Paginated minute-by-minute table with an "only transitions" filter. */
import { h, setChildren, uid } from '../dom';
import { PHASE_LABEL, WINDOW_LABEL, fmtFt, qiblaShort } from '../format';
import { primaryCol, stateTz, timeIn, type ResultsModel } from './model';

const PAGE = 60;

export function renderTable(model: ResultsModel): HTMLElement {
  const samples = model.data.result.samples;
  const col = primaryCol(model);
  const aircraftCol = { key: 'aircraft' as const, label: 'Under the aircraft' };

  // Rows are indices into samples.
  const transitions: number[] = [];
  samples.forEach((s, i) => {
    if (i === 0 || i === samples.length - 1) return transitions.push(i), undefined;
    const p = samples[i - 1];
    if (p.window !== s.window || p.state.phase !== s.state.phase || p.state.onGround !== s.state.onGround) transitions.push(i);
    return undefined;
  });

  let onlyTransitions = false;
  let page = 0;
  const body = h('tbody');
  const info = h('span', { class: 'page-info', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'btn small', onClick: () => go(page - 1) }, '← Previous');
  const next = h('button', { type: 'button', class: 'btn small', onClick: () => go(page + 1) }, 'Next →');
  const chkId = uid('trans');
  const chk = h('input', { type: 'checkbox', id: chkId });
  chk.addEventListener('change', () => {
    onlyTransitions = chk.checked;
    page = 0;
    render();
  });

  const rowsList = (): number[] => (onlyTransitions ? transitions : samples.map((_, i) => i));

  function go(p: number): void {
    const pages = Math.max(1, Math.ceil(rowsList().length / PAGE));
    page = Math.max(0, Math.min(pages - 1, p));
    render();
  }

  function render(): void {
    const rows = rowsList();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    page = Math.min(page, pages - 1);
    const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
    setChildren(
      body,
      slice.map((i) => {
        const s = samples[i];
        const pos = stateTz(s.state);
        const tr = h(
          'tr',
          { dataset: { i }, tabindex: 0, class: i === model.scrub.index ? 'active' : '' },
          h('td', null, timeIn(col, s.state.time, pos, { date: true })),
          h('td', null, timeIn(aircraftCol, s.state.time, pos, { date: false })),
          h('td', { class: 'num' }, s.state.lat.toFixed(2)),
          h('td', { class: 'num' }, s.state.lon.toFixed(2)),
          h('td', { class: 'num' }, fmtFt(s.state.altitudeM)),
          h('td', null, PHASE_LABEL[s.state.phase]),
          h('td', { class: 'num' }, s.sunAltitudeDeg.toFixed(1)),
          h('td', null, h('span', { class: 'dot', style: `background:var(--c-${s.window})` }), WINDOW_LABEL[s.window]),
          h('td', null, qiblaShort(s.qiblaRelativeDeg)),
        );
        const pick = (): void => model.scrub.set(i);
        tr.addEventListener('click', pick);
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        return tr;
      }),
    );
    setChildren(info, `Rows ${rows.length === 0 ? 0 : page * PAGE + 1}–${Math.min(rows.length, page * PAGE + PAGE)} of ${rows.length.toLocaleString('en-US')} · page ${page + 1} of ${pages}`);
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
  }
  model.scrub.subscribe((i) => {
    body.querySelectorAll('tr.active').forEach((r) => r.classList.remove('active'));
    body.querySelector(`tr[data-i="${i}"]`)?.classList.add('active');
  });
  render();

  return h(
    'section',
    { class: 'results-sec table-sec', 'aria-labelledby': 'tbl-h' },
    h('h2', { id: 'tbl-h' }, 'Minute by minute'),
    h('div', { class: 'row wrap between' }, h('div', { class: 'check' }, chk, h('label', { for: chkId }, 'Only transitions (window or phase changes)')), h('div', { class: 'pager' }, prev, info, next)),
    h(
      'div',
      { class: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': 'Minute-by-minute table (scrollable)' },
      h(
        'table',
        { class: 'samples' },
        h('caption', { class: 'visually-hidden' }, 'Aircraft state at each sampled minute'),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, col.tz === 'UTC' ? 'UTC' : col.label),
          h('th', { scope: 'col' }, 'Local (under aircraft)'),
          h('th', { scope: 'col' }, 'Lat'),
          h('th', { scope: 'col' }, 'Lon'),
          h('th', { scope: 'col' }, 'Alt (ft)'),
          h('th', { scope: 'col' }, 'Phase'),
          h('th', { scope: 'col' }, 'Sun alt (°)'),
          h('th', { scope: 'col' }, 'Window'),
          h('th', { scope: 'col' }, 'Qibla (rel.)'),
        )),
        body,
      ),
    ),
  );
}
