/** Timeline bar: prayer windows across the whole journey, legs/layovers overlaid, tick labels, hover/tap details. */
import type { PrayerWindow } from '../../types';
import { h, setChildren } from '../dom';
import { WINDOW_LABEL, fmtDuration, fmtInTz, whereText } from '../format';
import { WINDOW_COLOR_VAR, axisTicks, primaryCol, sampleIndexAt, timeIn, type ResultsModel } from './model';

export function renderTimeline(model: ResultsModel): HTMLElement {
  const { trip, data } = model;
  const t0 = trip.start.getTime();
  const t1 = Math.max(trip.end.getTime(), t0 + 60_000);
  const span = t1 - t0;
  const pct = (ms: number): number => Math.max(0, Math.min(100, ((ms - t0) / span) * 100));
  const col = primaryCol(model);
  const zone = col.tz ?? 'UTC';
  const samples = data.result.samples;

  const detail = h('div', { class: 'tl-detail', 'aria-live': 'polite' }, 'Hover, tap or focus a segment for details.');
  const showDetail = (text: string): void => setChildren(detail, text);

  // ── windows ──
  const segs = data.timeline.map((w, i) => {
    const left = pct(w.start.getTime());
    const width = Math.max(0.3, pct(w.end.getTime()) - left);
    const minutes = (w.end.getTime() - w.start.getTime()) / 60000;
    const idx = sampleIndexAt(samples, w.start);
    const ev = data.result.events.find((e) => e.time.getTime() === w.start.getTime());
    const st = ev?.state ?? samples[idx]?.state;
    const text =
      `${WINDOW_LABEL[w.window]} window: ${timeIn(col, w.start, st ?? { lat: 0, lon: 0 }, { seconds: true })} → ${timeIn(col, w.end, samples[sampleIndexAt(samples, w.end)]?.state ?? { lat: 0, lon: 0 }, { seconds: true })}` +
      ` (${zone === 'UTC' ? 'UTC' : col.label}), ${fmtDuration(minutes)}.` +
      (st ? ` Opens: ${whereText(st, trip.airports)}.` : '');
    const seg = h('button', {
      type: 'button',
      class: 'tl-seg',
      role: 'listitem',
      style: `left:${left}%;width:${width}%;background:${WINDOW_COLOR_VAR[w.window as PrayerWindow]}`,
      'aria-label': text,
      dataset: { window: w.window, index: i },
    }, width > 10 ? h('span', { class: 'tl-seg-label' }, WINDOW_LABEL[w.window]) : null);
    const act = (): void => {
      showDetail(text);
      model.scrub.set(idx);
    };
    seg.addEventListener('mouseenter', () => showDetail(text));
    seg.addEventListener('focus', () => showDetail(text));
    seg.addEventListener('click', act);
    return seg;
  });

  // ── legs & layovers ──
  const legBars: HTMLElement[] = [];
  trip.legs.forEach((leg, i) => {
    const left = pct(leg.departureUtc.getTime());
    const width = Math.max(0.3, pct(leg.arrivalUtc.getTime()) - left);
    const label = `${leg.from} → ${leg.to}${leg.flightNumber ? ` ${leg.flightNumber}` : ''}`;
    const text = `${label}: departs ${fmtInTz(leg.departureUtc, trip.airports.get(leg.from)?.tz ?? 'UTC')} local, arrives ${fmtInTz(leg.arrivalUtc, trip.airports.get(leg.to)?.tz ?? 'UTC')} local (${fmtDuration((leg.arrivalUtc.getTime() - leg.departureUtc.getTime()) / 60000)}).`;
    legBars.push(
      h('div', { class: 'tl-leg', role: 'listitem', tabindex: 0, style: `left:${left}%;width:${width}%`, 'aria-label': text, title: text, onFocus: () => showDetail(text), onMouseenter: () => showDetail(text) },
        h('span', null, width > 9 ? label : width > 4 ? leg.from : '')),
    );
    const next = trip.legs[i + 1];
    if (next && next.departureUtc.getTime() > leg.arrivalUtc.getTime()) {
      const l2 = pct(leg.arrivalUtc.getTime());
      const w2 = pct(next.departureUtc.getTime()) - l2;
      const mins = (next.departureUtc.getTime() - leg.arrivalUtc.getTime()) / 60000;
      const lt = `Layover at ${leg.to}: ${fmtDuration(mins)}.`;
      legBars.push(
        h('div', { class: 'tl-layover', role: 'listitem', tabindex: 0, style: `left:${l2}%;width:${w2}%`, 'aria-label': lt, title: lt, onFocus: () => showDetail(lt), onMouseenter: () => showDetail(lt) },
          h('span', null, w2 > 8 ? `${leg.to} ${fmtDuration(mins)}` : '')),
      );
    }
  });

  // ── ticks ──
  const ticks = axisTicks(t0, t1, zone).map((tk) =>
    h('div', { class: 'tl-tick', style: `left:${pct(tk.ms)}%` }, h('span', { class: 'tl-tick-time' }, tk.label), tk.day ? h('span', { class: 'tl-tick-day' }, tk.day) : null),
  );

  const cursor = h('div', { class: 'tl-cursor', 'aria-hidden': 'true' });
  const moveCursor = (i: number): void => {
    const s = samples[i];
    if (!s) return;
    cursor.style.left = `${pct(s.state.time.getTime())}%`;
  };
  moveCursor(model.scrub.index);
  model.scrub.subscribe(moveCursor);

  const legend = h(
    'ul',
    { class: 'legend' },
    (['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'] as PrayerWindow[]).map((w) =>
      h('li', null, h('span', { class: 'swatch', style: `background:${WINDOW_COLOR_VAR[w]}` }), WINDOW_LABEL[w]),
    ),
  );

  return h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'tl-h' },
    h('h2', { id: 'tl-h' }, 'Timeline'),
    h('p', { class: 'hint' }, `Window active under the aircraft at each moment. Axis in ${zone === 'UTC' ? 'UTC' : col.label} time.`),
    h(
      'div',
      { class: 'tl-wrap' },
      h('div', { class: 'tl-windows', role: 'list', 'aria-label': 'Prayer windows along the journey' }, segs, cursor),
      h('div', { class: 'tl-legs', role: 'list', 'aria-label': 'Flights and layovers' }, legBars),
      h('div', { class: 'tl-axis', 'aria-hidden': 'true' }, ticks),
    ),
    detail,
    legend,
  );
}
