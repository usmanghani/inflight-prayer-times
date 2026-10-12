/** Time scrubber + readout for the aircraft state at a chosen minute. */
import { h, setChildren } from '../dom';
import { PHASE_LABEL, WINDOW_LABEL, fmtAlt, formatLatLon, qiblaPhrase } from '../format';
import { stateTz, timeIn, type ResultsModel } from './model';

export function renderScrubber(model: ResultsModel): HTMLElement {
  const samples = model.data.result.samples;
  const slider = h('input', {
    type: 'range', id: 'scrub', min: 0, max: Math.max(0, samples.length - 1), step: 1, value: 0,
    'aria-label': 'Move the aircraft along the journey', 'aria-controls': 'scrub-readout',
  });
  const readout = h('dl', { class: 'readout', id: 'scrub-readout', 'aria-live': 'off' });
  const timeLabel = h('output', { for: 'scrub', class: 'scrub-time' });

  const update = (i: number): void => {
    const s = samples[i];
    if (!s) return;
    slider.value = String(i);
    const pos = stateTz(s.state);
    const rows: [string, string][] = [];
    for (const col of model.cols) rows.push([col.key === 'aircraft' ? `Under aircraft (${s.tz})` : col.label, timeIn(col, s.state.time, pos, { date: true })]);
    rows.push(
      ['Position', s.state.onGround ? `On the ground${s.state.airport ? ` at ${s.state.airport}` : ''} (${formatLatLon(s.state.lat, s.state.lon)})` : formatLatLon(s.state.lat, s.state.lon)],
      ['Altitude', `${fmtAlt(s.state.altitudeM)} · ${PHASE_LABEL[s.state.phase]}`],
      ['Sun altitude', `${s.sunAltitudeDeg.toFixed(1)}° (${s.sunAltitudeDeg >= 0 ? 'above' : 'below'} the horizon)`],
      ['Active window', WINDOW_LABEL[s.window]],
      ['Qibla', qiblaPhrase(s.qiblaDeg, s.qiblaRelativeDeg, s.state.onGround)],
    );
    setChildren(readout, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))));
    const first = timeIn(model.cols[0], s.state.time, pos, { date: true });
    setChildren(timeLabel, first);
    slider.setAttribute('aria-valuetext', `${first}, ${WINDOW_LABEL[s.window]} window, ${formatLatLon(s.state.lat, s.state.lon)}`);
  };
  slider.addEventListener('input', () => model.scrub.set(Number(slider.value)));
  model.scrub.subscribe(update);
  update(0);

  return h(
    'div',
    { class: 'scrubber' },
    h('div', { class: 'scrub-row' }, h('label', { for: 'scrub' }, 'Where is the aircraft at…'), timeLabel),
    slider,
    readout,
  );
}
