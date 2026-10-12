/** Summary cards (one per prayer task), anomaly panel, traveller notes. */
import type { AircraftState } from '../../types';
import type { PrayerTask } from '../../prayer/summary';
import { MADHAB_INFO } from '../../prayer/methods';
import { qiblaBearing, relativeBearing } from '../../geo/qibla';
import { pathLengthKm } from '../../geo/geodesy';
import { legRoute } from '../../flight/journey';
import { h } from '../dom';
import {
  PRAYER_AR, PRAYER_LABEL, capitalise, fmtAlt, fmtDuration, fmtInTz, formatLatLon, offsetLabel, qiblaPhrase, whereText,
} from '../format';
import { timeIn, offsetIn, primaryCol, zoneFor, type ResultsModel } from './model';

function qiblaAt(s: AircraftState): string {
  const abs = qiblaBearing(s.lat, s.lon);
  return qiblaPhrase(abs, relativeBearing(abs, s.headingDeg), s.onGround);
}

function timesTable(model: ResultsModel, task: PrayerTask): HTMLElement {
  const first = model.data.result.samples[0]?.state;
  const last = model.data.result.samples[model.data.result.samples.length - 1]?.state;
  const openDate = task.windowStart?.time ?? first?.time ?? null;
  const openState = task.startState;
  const closeDate = task.windowEnd;
  const closeState = task.endState ?? last ?? task.startState;
  const rows = model.cols.map((col) => {
    const label = col.key === 'aircraft' ? 'Under the aircraft' : col.label;
    const sub = openDate ? offsetIn(col, openDate, openState) : '';
    const tzNote = col.key === 'aircraft' && openDate ? zoneFor(col, openState) : sub;
    return h(
      'tr',
      null,
      h('th', { scope: 'row' }, label, h('span', { class: 'sub' }, tzNote)),
      h('td', { title: openDate ? timeIn(col, openDate, openState, { seconds: true }) : undefined }, openDate ? timeIn(col, openDate, openState) : '—'),
      h(
        'td',
        { title: closeDate ? timeIn(col, closeDate, closeState, { seconds: true }) : undefined },
        closeDate ? timeIn(col, closeDate, closeState) : 'Still open at arrival',
      ),
    );
  });
  return h(
    'table',
    { class: 'times' },
    h('caption', { class: 'visually-hidden' }, `${PRAYER_LABEL[task.prayer]} window start and end times`),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Time zone'), h('th', { scope: 'col' }, task.windowStart ? 'Opens' : 'Open since'), h('th', { scope: 'col' }, 'Closes'))),
    h('tbody', null, rows),
  );
}

function badges(task: PrayerTask): HTMLElement {
  const b: HTMLElement[] = [];
  if (task.inAir) b.push(h('span', { class: 'badge air' }, 'In the air'));
  else {
    const a = task.startState.airport;
    b.push(h('span', { class: 'badge ground' }, a ? `On the ground at ${a}` : 'On the ground'));
  }
  const ev = task.windowStart;
  if (ev && (ev.note === 'highLatitudeRule' || ev.note === 'nearestLatitude')) {
    b.push(
      ev.note === 'nearestLatitude'
        ? h('span', { class: 'badge warn', title: 'The Sun does not rise and set normally here, so the time is taken from the nearest place that has a normal day.' }, 'Times borrowed from the nearest location with a normal day')
        : h('span', { class: 'badge warn', title: 'The start time comes from your high-latitude rule, not directly from the Sun.' }, 'High-latitude rule'),
    );
  }
  if (ev?.anomaly === 'windowRepeated') b.push(h('span', { class: 'badge alert' }, 'Window repeated'));
  if (ev?.anomaly === 'windowSkipped') b.push(h('span', { class: 'badge alert' }, 'Window skipped'));
  if (ev?.anomaly === 'polarDay' || ev?.anomaly === 'polarNight') b.push(h('span', { class: 'badge alert' }, ev.anomaly === 'polarDay' ? 'Polar day' : 'Polar night'));
  if (task.durationMin !== null && task.durationMin < 10) b.push(h('span', { class: 'badge warn' }, 'Very short'));
  if (!task.windowStart) b.push(h('span', { class: 'badge' }, 'Open at departure'));
  return h('div', { class: 'badges' }, b);
}

export function renderPrayerCard(model: ResultsModel, task: PrayerTask, index: number): HTMLElement {
  const placeOpen = whereText(task.startState, model.trip.airports);
  const placeClose = task.endState ? whereText(task.endState, model.trip.airports) : null;
  const facts: HTMLElement[] = [
    h('div', null, h('dt', null, 'Duration'), h('dd', null, task.durationMin === null ? 'Open until arrival' : fmtDuration(task.durationMin))),
    h('div', null, h('dt', null, task.windowStart ? 'Opens' : 'At departure'), h('dd', null, placeOpen)),
  ];
  if (placeClose) facts.push(h('div', null, h('dt', null, 'Closes'), h('dd', null, placeClose)));
  facts.push(h('div', null, h('dt', null, 'Qibla'), h('dd', null, qiblaAt(task.startState))));

  return h(
    'article',
    { class: 'prayer-card', dataset: { prayer: task.prayer, index }, style: `--pc: var(--c-${task.prayer})` },
    h(
      'header',
      null,
      h('h3', null, h('span', { class: 'en' }, PRAYER_LABEL[task.prayer]), ' ', h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, PRAYER_AR[task.prayer])),
      badges(task),
    ),
    timesTable(model, task),
    h('dl', { class: 'facts' }, facts),
    task.notes.length ? h('ul', { class: 'card-notes' }, task.notes.map((n) => h('li', null, capitalise(n) + '.'))) : null,
  );
}

export function renderSummary(model: ResultsModel): HTMLElement {
  const tasks = model.data.tasks;
  return h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'sum-h' },
    h('h2', { id: 'sum-h' }, 'Prayer windows on your journey'),
    tasks.length === 0
      ? h('p', { class: 'hint' }, 'No prayer window could be determined for this journey.')
      : h('div', { class: 'cards' }, tasks.map((t, i) => renderPrayerCard(model, t, i))),
  );
}

export function renderAnomalies(model: ResultsModel): HTMLElement {
  const list = model.data.result.anomalies;
  const col = primaryCol(model);
  const body =
    list.length === 0
      ? h('p', { class: 'ok-note' }, 'No anomalies: every prayer window opened once, in the usual order.')
      : h('div', null, ...splitList(list).map((part, pi) => {
          const ul = h(
          'ul',
          { class: 'anomalies' },
          part.map((a) => {
            const idx = model.data.result.samples.findIndex((s) => s.state.time.getTime() >= a.time.getTime());
            const st = model.data.result.samples[Math.max(0, idx)]?.state;
            return h(
              'li',
              { class: `anomaly ${a.kind}` },
              h('div', { class: 'anomaly-head' }, h('span', { class: 'badge alert' }, kindLabel(a.kind)), ' ', h('time', { datetime: a.time.toISOString() }, `${fmtInTz(a.time, col.tz ?? 'UTC')} ${col.tz === 'UTC' ? 'UTC' : offsetLabel(a.time, col.tz ?? 'UTC')}`), st ? h('span', { class: 'muted' }, ` · ${formatLatLon(st.lat, st.lon)}`) : null),
              h('p', null, a.message),
            );
          }),
        );
          return pi === 0 ? ul : h('details', { class: 'more' }, h('summary', null, `Show ${part.length} more`), ul);
        }));
  return h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'anom-h' },
    h('h2', { id: 'anom-h' }, 'Anomalies'),
    body,
  );
}

function splitList<T>(list: T[], first = 4): T[][] {
  return list.length <= first + 1 ? [list] : [list.slice(0, first), list.slice(first)];
}

function kindLabel(k: string): string {
  switch (k) {
    case 'windowRepeated': return 'Window repeated';
    case 'windowSkipped': return 'Window skipped';
    case 'polarDay': return 'Polar day';
    case 'polarNight': return 'Polar night';
    case 'highLatitudeRuleUsed': return 'High-latitude rule';
    default: return k;
  }
}

export function renderTravellerNotes(model: ResultsModel): HTMLElement {
  const info = MADHAB_INFO[model.settings.prayer.madhab];
  let km = 0;
  try {
    for (const l of model.trip.legs) km += pathLengthKm(legRoute(l, (c) => model.trip.airports.get(c)));
  } catch {
    km = 0;
  }
  const jam = info.allowsTravelCombining
    ? `Combining (jam‘) Dhuhr+Asr and Maghrib+Isha is permitted for a traveller in the ${info.label} school. If you combine, you may pray the second prayer in the first one’s time (or the first in the second’s); the windows above show both.`
    : `The ${info.label} school does not allow combining prayers while travelling (except Dhuhr+Asr at ‘Arafah and Maghrib+Isha at Muzdalifah on Hajj). Pray each prayer within its own window; the cards above show where each opens and closes during the flight.`;

  const ground = model.data.ground.map((g) => {
    const t = (p: { time: Date | null }): string => (p.time ? fmtInTz(p.time, g.tz, { date: false }) : '—');
    const role = g.role === 'origin' ? 'Departure' : g.role === 'destination' ? 'Arrival' : 'Layover departure';
    return h(
      'details',
      { class: 'ground' },
      h('summary', null, `${role} airport ${g.iata} on ${g.solarDate} (local times)`),
      h(
        'table',
        { class: 'mini' },
        h('tbody', null,
          h('tr', null, h('th', { scope: 'row' }, 'Fajr'), h('td', null, t(g.times.fajr)), h('th', { scope: 'row' }, 'Sunrise'), h('td', null, t(g.times.sunrise))),
          h('tr', null, h('th', { scope: 'row' }, 'Dhuhr'), h('td', null, t(g.times.dhuhr)), h('th', { scope: 'row' }, 'Asr'), h('td', null, t(g.times.asr))),
          h('tr', null, h('th', { scope: 'row' }, 'Maghrib'), h('td', null, t(g.times.maghrib)), h('th', { scope: 'row' }, 'Isha'), h('td', null, t(g.times.isha))),
        ),
      ),
      g.makrooh.length
        ? h('p', { class: 'hint' }, 'Makrooh (disliked) times for prayer: ', g.makrooh.map((m) => `${m.label.toLowerCase()} ${fmtInTz(m.start, g.tz, { date: false })}–${fmtInTz(m.end, g.tz, { date: false })}`).join('; '), '.')
        : null,
    );
  });

  return h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'notes-h' },
    h('h2', { id: 'notes-h' }, 'Notes for the traveller'),
    h('ul', { class: 'notes' },
      h('li', null, h('strong', null, 'Shortening (qasr). '), info.qasrNote, km > 0 ? ` This trip covers about ${Math.round(km).toLocaleString('en-US')} km.` : ''),
      h('li', null, h('strong', null, 'Combining (jam‘). '), jam),
      h('li', null, h('strong', null, 'Asr. '), info.notes),
      h('li', null, h('strong', null, 'Times to avoid praying (makrooh). '), 'Right after sunrise (about 15 minutes), when the Sun is at its zenith (about 5 minutes before Dhuhr) and just before sunset (about 15 minutes). In the air, use the sunrise/sunset times for the aircraft’s position and altitude shown on the cards; at cruise the horizon is lower, so these moments come a little later than on the ground.'),
      h('li', null, h('strong', null, 'In flight. '), 'If you cannot stand, pray seated; face the Qibla as best you can and do not worry about turning during the prayer if the aircraft turns. The Qibla arrow on each card is relative to the nose of the aircraft.'),
    ),
    ground.length ? h('div', { class: 'ground-list' }, h('h3', null, 'Ground reference times'), ground) : null,
    h('p', { class: 'hint' }, `Aircraft altitude assumed in cruise: ${fmtAlt(11000)} unless you set a cruise altitude on a leg (imported tracks use their own altitudes).`),
  );
}
