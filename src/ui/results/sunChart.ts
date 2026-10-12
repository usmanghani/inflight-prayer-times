/** Sun altitude chart (hand-rolled inline SVG): altitude vs time with threshold lines and prayer markers. */
import type { MinuteSample } from '../../types';
import { horizonDipDeg, sunPosition } from '../../astro/solar';
import { asrShadowFactor } from '../../prayer/methods';
import { svg, h } from '../dom';
import { PRAYER_LABEL } from '../format';
import { WINDOW_HEX, axisTicks, decimate, primaryCol, sampleIndexAt, type ResultsModel } from './model';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Altitude of the Sun at which Asr begins for latitude `lat` and declination `dec` (degrees). */
export function asrAltitudeDeg(lat: number, dec: number, factor: 1 | 2): number {
  const z = Math.abs(lat - dec) * RAD;
  const t = Math.tan(Math.min(z, 89.9 * RAD));
  return Math.atan(1 / (factor + t)) * DEG;
}

interface Line {
  y: number;
  label: string;
  /** Label used when the chart is narrow ('' hides it). */
  shortLabel?: string;
  cls: string;
  /** Put the label under the line (to keep close lines legible). */
  below?: boolean;
}

export function renderSunChart(model: ResultsModel): HTMLElement {
  const { data, settings } = model;
  const samples = data.result.samples;
  const pr = settings.prayer;
  const wrap = h('div', { class: 'chart-wrap' });
  const section = h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'chart-h' },
    h('h2', { id: 'chart-h' }, 'Sun altitude'),
    h('p', { class: 'hint' }, 'The Sun’s height above the horizon as seen from the aircraft. Dashed lines show the angles at which each prayer window is defined.'),
    wrap,
  );
  if (samples.length < 2) {
    wrap.appendChild(h('p', { class: 'hint' }, 'Not enough data to draw the chart.'));
    return section;
  }

  const pts = decimate(samples, 480);
  const t0 = samples[0].state.time.getTime();
  const t1 = Math.max(samples[samples.length - 1].state.time.getTime(), t0 + 60_000);
  const cruiseAlt = samples.reduce((m, s) => Math.max(m, s.state.altitudeM), 0);
  const dipCruise = horizonDipDeg(cruiseAlt);
  const m = pr.method;
  const tw = pr.dipForTwilight ? dipCruise : 0;
  const lines: Line[] = [];
  const ishaByAngle = m.ishaAngle !== null && m.ishaIntervalMin === null;
  if (ishaByAngle && m.ishaAngle === m.fajrAngle) {
    lines.push({ y: -(m.fajrAngle + tw), label: `Fajr / Isha −${m.fajrAngle}°`, cls: 'fajr' });
  } else {
    lines.push({ y: -(m.fajrAngle + tw), label: `Fajr −${m.fajrAngle}°`, cls: 'fajr' });
    if (ishaByAngle) lines.push({ y: -(m.ishaAngle as number + tw), label: `Isha −${m.ishaAngle}°`, cls: 'isha' });
  }
  const cruiseHorizon = -(0.833 + (pr.dipForSunriseSunset ? dipCruise : 0));
  lines.push({ y: cruiseHorizon, label: `Sunrise/Maghrib at cruise ${cruiseHorizon.toFixed(1)}°`, shortLabel: `Cruise horizon ${cruiseHorizon.toFixed(1)}°`, cls: 'horizon', below: true });
  if (pr.dipForSunriseSunset && dipCruise > 0.1) lines.push({ y: -0.833, label: 'Sea-level horizon −0.8°', shortLabel: '', cls: 'sea' });

  const factor = asrShadowFactor(pr.madhab);
  const asrSeries = pts.map((s) => asrAltitudeDeg(s.state.lat, sunPosition(s.state.time).declinationDeg, factor));

  const alts = pts.map((s) => s.sunAltitudeDeg);
  let yMin = Math.min(...alts, ...lines.map((l) => l.y)) - 4;
  let yMax = Math.max(...alts, ...asrSeries, 10) + 4;
  yMin = Math.floor(yMin / 10) * 10;
  yMax = Math.ceil(yMax / 10) * 10;
  if (yMax - yMin < 40) yMax = yMin + 40;

  const col = primaryCol(model);
  const zone = col.tz ?? 'UTC';
  const events = data.result.events;

  const cursorLine = svg('line', { class: 'ch-cursor' });
  const cursorDot = svg('circle', { class: 'ch-cursor-dot', r: 4.5 });

  function draw(width: number): void {
    const W = Math.max(300, Math.round(width));
    const H = W < 520 ? 280 : 320;
    const mL = 40, mR = 12, mT = 12, mB = 40;
    const iw = W - mL - mR;
    const ih = H - mT - mB;
    const x = (ms: number): number => mL + ((ms - t0) / (t1 - t0)) * iw;
    const y = (a: number): number => mT + (1 - (a - yMin) / (yMax - yMin)) * ih;
    const clampY = (a: number): number => Math.max(mT, Math.min(mT + ih, y(a)));

    const root = svg('svg', {
      viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'img',
      'aria-label': `Sun altitude along the journey from ${Math.round(Math.min(...alts))}° to ${Math.round(Math.max(...alts))}° above the horizon, with ${events.length} prayer window changes marked.`,
    });
    root.appendChild(svg('title', null, 'Sun altitude along the journey'));
    const defs = svg('defs');
    const y0 = clampY(0);
    defs.appendChild(svg('clipPath', { id: 'clip-above' }, svg('rect', { x: mL, y: mT, width: iw, height: Math.max(0, y0 - mT) })));
    defs.appendChild(svg('clipPath', { id: 'clip-below' }, svg('rect', { x: mL, y: y0, width: iw, height: Math.max(0, mT + ih - y0) })));
    root.appendChild(defs);

    // horizontal grid
    const gStep = yMax - yMin > 90 ? 30 : 10;
    for (let a = Math.ceil(yMin / gStep) * gStep; a <= yMax; a += gStep) {
      root.appendChild(svg('line', { class: `ch-grid${a === 0 ? ' zero' : ''}`, x1: mL, x2: mL + iw, y1: y(a), y2: y(a) }));
      root.appendChild(svg('text', { class: 'ch-text', x: mL - 6, y: y(a) + 4, 'text-anchor': 'end' }, `${a}°`));
    }
    // x ticks
    for (const tk of axisTicks(t0, t1, zone, W < 520 ? 5 : 9)) {
      const xx = x(tk.ms);
      root.appendChild(svg('line', { class: 'ch-grid vert', x1: xx, x2: xx, y1: mT, y2: mT + ih }));
      root.appendChild(svg('text', { class: 'ch-text', x: xx, y: H - mB + 16, 'text-anchor': 'middle' }, tk.label));
      if (tk.day) root.appendChild(svg('text', { class: 'ch-text day', x: xx, y: H - mB + 30, 'text-anchor': 'middle' }, tk.day));
    }
    root.appendChild(svg('text', { class: 'ch-text day', x: mL + iw, y: H - 2, 'text-anchor': 'end' }, `time (${zone === 'UTC' ? 'UTC' : col.label})`));

    // area fills
    const curve = pts.map((s) => `${x(s.state.time.getTime()).toFixed(1)},${y(s.sunAltitudeDeg).toFixed(1)}`);
    const area = `M${x(pts[0].state.time.getTime()).toFixed(1)},${(mT + ih).toFixed(1)} L${curve.join(' L')} L${x(pts[pts.length - 1].state.time.getTime()).toFixed(1)},${(mT + ih).toFixed(1)} Z`;
    root.appendChild(svg('path', { class: 'ch-day-fill', d: area, 'clip-path': 'url(#clip-above)' }));
    root.appendChild(svg('path', { class: 'ch-night-fill', d: area, 'clip-path': 'url(#clip-below)' }));

    // threshold lines
    for (const l of lines) {
      const yy = clampY(l.y);
      root.appendChild(svg('line', { class: `ch-thr ${l.cls}`, x1: mL, x2: mL + iw, y1: yy, y2: yy }));
      root.appendChild(svg('text', { class: 'ch-label', x: mL + iw - 4, y: l.below ? yy + 13 : yy - 4, 'text-anchor': 'end' }, W < 520 && l.shortLabel !== undefined ? l.shortLabel : l.label));
    }
    // Asr curve
    const asrPath = pts.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.state.time.getTime()).toFixed(1)},${clampY(asrSeries[i]).toFixed(1)}`).join(' ');
    root.appendChild(svg('path', { class: 'ch-thr asr', d: asrPath, fill: 'none' }));
    const lastAsr = clampY(asrSeries[asrSeries.length - 1]);
    root.appendChild(svg('text', { class: 'ch-label', x: mL + iw - 4, y: lastAsr - 4, 'text-anchor': 'end' }, `Asr ${asrSeries[asrSeries.length - 1].toFixed(0)}° (${factor === 2 ? 'shadow ×2' : 'shadow ×1'})`));

    // sun curve
    root.appendChild(svg('path', { class: 'ch-sun', d: `M${curve.join(' L')}`, fill: 'none' }));

    // events
    for (const ev of events) {
      const i = sampleIndexAt(samples, ev.time);
      const alt = samples[i]?.sunAltitudeDeg ?? 0;
      const cx = x(ev.time.getTime());
      const c = svg('circle', { class: 'ch-event', cx, cy: y(alt), r: 5, fill: WINDOW_HEX[ev.prayer], tabindex: 0 }, svg('title', null, `${PRAYER_LABEL[ev.prayer]} opens, sun ${alt.toFixed(1)}° above the horizon`));
      c.addEventListener('click', () => model.scrub.set(i));
      root.appendChild(c);
    }

    root.appendChild(cursorLine);
    root.appendChild(cursorDot);
    wrapPlot.replaceChildren(root);

    const place = (i: number): void => {
      const s: MinuteSample | undefined = samples[i];
      if (!s) return;
      const cx = x(s.state.time.getTime());
      cursorLine.setAttribute('x1', String(cx));
      cursorLine.setAttribute('x2', String(cx));
      cursorLine.setAttribute('y1', String(mT));
      cursorLine.setAttribute('y2', String(mT + ih));
      cursorDot.setAttribute('cx', String(cx));
      cursorDot.setAttribute('cy', String(y(s.sunAltitudeDeg)));
    };
    place(model.scrub.index);
    unsub?.();
    unsub = model.scrub.subscribe(place);
  }

  const wrapPlot = h('div', { class: 'chart-plot' });
  let unsub: (() => void) | undefined;
  wrap.appendChild(wrapPlot);
  wrap.appendChild(
    h(
      'ul',
      { class: 'legend' },
      (['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).map((w) =>
        h('li', null, h('span', { class: 'swatch round', style: `background:${WINDOW_HEX[w]}` }), `${PRAYER_LABEL[w]} begins`),
      ),
    ),
  );

  let lastW = 0;
  const initial = (): void => {
    const w = wrap.clientWidth || 720;
    if (Math.abs(w - lastW) > 8) {
      lastW = w;
      draw(w);
    }
  };
  initial();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) {
        ro.disconnect();
        return;
      }
      initial();
    });
    ro.observe(wrap);
  }
  return section;
}
