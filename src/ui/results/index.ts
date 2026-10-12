/** Assemble the results area. */
import { eventsToIcs } from '../../export/ics';
import { samplesToCsv } from '../../export/csv';
import { downloadText } from '../../export/download';
import { h } from '../dom';
import { fmtDuration } from '../format';
import { buildResultsModel, type ResultsModel, type Trip } from './model';
import { renderMapSection } from './mapView';
import { renderSunChart } from './sunChart';
import { renderAnomalies, renderSummary, renderTravellerNotes } from './summary';
import { renderTable } from './table';
import { renderTimeline } from './timeline';
import type { AppSettings } from '../model';
import type { ComputeOk } from '../computeCore';

export interface RenderedResults {
  el: HTMLElement;
  model: ResultsModel;
  dispose(): void;
}

export interface ResultsHandlers {
  onShare(): void;
}

export function renderResults(trip: Trip, settings: AppSettings, data: ComputeOk, handlers: ResultsHandlers): RenderedResults {
  const model = buildResultsModel(trip, settings, data);
  const title = `In-flight prayer times ${trip.originIata}-${trip.destIata} ${trip.start.toISOString().slice(0, 10)}`;
  const slug = `prayer-times-${trip.originIata}-${trip.destIata}-${trip.start.toISOString().slice(0, 10)}`;

  const status = h('span', { class: 'export-status', role: 'status', 'aria-live': 'polite' });
  const say = (t: string): void => {
    status.textContent = t;
  };

  const toolbar = h(
    'div',
    { class: 'toolbar no-print' },
    h('button', { type: 'button', class: 'btn', onClick: () => say(downloadText(`${slug}.csv`, samplesToCsv(data.result), 'text/csv;charset=utf-8') ? 'CSV downloaded.' : 'Could not start the download.') }, 'Download CSV'),
    h('button', { type: 'button', class: 'btn', onClick: () => say(downloadText(`${slug}.ics`, eventsToIcs(data.result, data.tasks, title), 'text/calendar;charset=utf-8') ? 'Calendar file downloaded.' : 'Could not start the download.') }, 'Download calendar (.ics)'),
    h('button', { type: 'button', class: 'btn', onClick: () => handlers.onShare() }, 'Copy share link'),
    h('button', { type: 'button', class: 'btn', onClick: () => window.print() }, 'Print'),
    status,
  );

  const blockMin = (trip.end.getTime() - trip.start.getTime()) / 60000;
  const header = h(
    'div',
    { class: 'results-head' },
    h('h2', { id: 'results-h', tabindex: -1 }, '3. Results'),
    h(
      'p',
      { class: 'summary-line' },
      `${trip.legs.length} flight${trip.legs.length === 1 ? '' : 's'} · ${trip.originIata} → ${trip.destIata} · ${fmtDuration(blockMin)} door to door · ${data.result.samples.length.toLocaleString('en-US')} samples · ${data.result.events.length} window changes · computed in ${data.computeMs} ms`,
    ),
    toolbar,
  );

  const map = renderMapSection(model);
  const el = h(
    'div',
    { class: 'results-inner' },
    header,
    renderSummary(model),
    renderAnomalies(model),
    renderTravellerNotes(model),
    renderTimeline(model),
    renderSunChart(model),
    map.el,
    renderTable(model),
  );
  return { el, model, dispose: () => map.dispose() };
}
