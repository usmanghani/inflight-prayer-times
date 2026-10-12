/** Leaflet map (lazy, guarded): routes, airports, prayer event markers, aircraft marker driven by the scrubber. */
import type { Map as LMap, Marker, Polygon } from 'leaflet';
import { densifyPath, normalizeLon, splitAtAntimeridian } from '../../geo/geodesy';
import { qiblaBearing, relativeBearing } from '../../geo/qibla';
import { legRoute } from '../../flight/journey';
import { h, setChildren, uid } from '../dom';
import { PHASE_LABEL, PRAYER_LABEL, fmtAlt, formatLatLon, qiblaPhrase } from '../format';
import { nightPolygon } from '../terminator';
import { WINDOW_HEX, stateTz, timeIn, type ResultsModel } from './model';
import { renderScrubber } from './scrubber';

const LEG_COLORS = ['#2563eb', '#0f766e', '#9333ea', '#b45309', '#be123c', '#4d7c0f'];

const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 2c.8 0 1.4.9 1.4 2v5.2l8.1 4.8v2.2l-8.1-2.3v4.3l2.2 1.7V22L12 20.8 8.4 22v-1.8l2.2-1.7v-4.3l-8.1 2.3v-2.2l8.1-4.8V4c0-1.1.6-2 1.4-2z" fill="currentColor" stroke="#fff" stroke-width="1"/></svg>';

export interface MapSection {
  el: HTMLElement;
  dispose(): void;
}

function isJsdom(): boolean {
  try {
    return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

export function renderMapSection(model: ResultsModel): MapSection {
  const boxId = uid('map');
  const box = h('div', { class: 'map-box', id: boxId, role: 'region', 'aria-label': 'Map of the flight route with prayer event markers' }, h('p', { class: 'map-msg' }, 'The map loads when it scrolls into view.'));
  const shadeId = uid('shade');
  const shadeBox = h('input', { type: 'checkbox', id: shadeId, checked: true });
  const el = h(
    'section',
    { class: 'results-sec', 'aria-labelledby': 'map-h' },
    h('h2', { id: 'map-h' }, 'Map'),
    h(
      'p',
      { class: 'hint' },
      'Dashed lines are great-circle routes; solid lines are real tracks you imported or fetched. Coloured dots mark where each window opens.',
    ),
    box,
    h('div', { class: 'map-tools' }, h('div', { class: 'check' }, shadeBox, h('label', { for: shadeId }, 'Shade the night side at the scrubbed time'))),
    renderScrubber(model),
  );

  let map: LMap | null = null;
  let disposed = false;
  let unsub: (() => void) | null = null;
  let io: IntersectionObserver | null = null;

  async function init(): Promise<void> {
    if (map || disposed) return;
    try {
      const Lmod = await import('leaflet');
      if (disposed) return;
      const L = (Lmod as unknown as { default?: typeof import('leaflet') }).default ?? (Lmod as unknown as typeof import('leaflet'));
      setChildren(box);
      map = L.map(box, { worldCopyJump: true, minZoom: 1, zoomSnap: 0.25 });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(map);

      const bounds: [number, number][] = [];
      const { trip, data } = model;

      // routes
      trip.legs.forEach((leg, i) => {
        const color = LEG_COLORS[i % LEG_COLORS.length];
        const from = trip.airports.get(leg.from);
        const to = trip.airports.get(leg.to);
        if (!from || !to) return;
        const gc = [
          { lat: from.lat, lon: from.lon },
          ...(leg.waypoints ?? []).map((p) => ({ lat: p.lat, lon: p.lon })),
          { lat: to.lat, lon: to.lon },
        ];
        for (const seg of splitAtAntimeridian(densifyPath(gc, 60))) {
          const ll = seg.map((p) => [p.lat, p.lon] as [number, number]);
          L.polyline(ll, { color, weight: leg.track ? 2 : 3, opacity: leg.track ? 0.5 : 0.9, dashArray: '7 7' }).addTo(map!);
          ll.forEach((p) => bounds.push(p));
        }
        if (leg.track && leg.track.length >= 2) {
          const route = legRoute(leg, (c) => trip.airports.get(c));
          for (const seg of splitAtAntimeridian(densifyPath(route, 30))) {
            L.polyline(seg.map((p) => [p.lat, p.lon] as [number, number]), { color, weight: 3.5, opacity: 0.95 }).addTo(map!);
          }
        }
      });

      // airports
      const seen = new Set<string>();
      for (const leg of trip.legs) {
        for (const code of [leg.from, leg.to]) {
          if (seen.has(code)) continue;
          seen.add(code);
          const a = trip.airports.get(code);
          if (!a) continue;
          const m = L.circleMarker([a.lat, a.lon], { radius: 5, color: '#111827', weight: 2, fillColor: '#ffffff', fillOpacity: 1 }).addTo(map);
          m.bindTooltip(a.iata, { permanent: true, direction: 'top', offset: [0, -4], className: 'apt-tip' });
          m.bindPopup(h('div', { class: 'pop' }, h('strong', null, `${a.iata} — ${a.name}`), h('div', null, `${a.city}, ${a.country}`), h('div', { class: 'muted' }, `${a.tz}, elevation ${Math.round(a.elevationM)} m`)));
        }
      }

      // prayer events
      for (const ev of data.result.events) {
        const s = ev.state;
        const pos = stateTz(s);
        const abs = qiblaBearing(s.lat, s.lon);
        const m = L.circleMarker([s.lat, normalizeLon(s.lon)], {
          radius: 7, color: '#ffffff', weight: 2, fillColor: WINDOW_HEX[ev.prayer], fillOpacity: 1,
        }).addTo(map);
        const body = h(
          'div',
          { class: 'pop' },
          h('strong', null, `${PRAYER_LABEL[ev.prayer]} begins`),
          ...model.cols.map((c) => h('div', null, `${c.key === 'aircraft' ? 'Under aircraft' : c.label}: ${timeIn(c, ev.time, pos, { seconds: true })}`)),
          h('div', null, s.onGround ? `On the ground${s.airport ? ` at ${s.airport}` : ''}` : `${formatLatLon(s.lat, s.lon)}, ${fmtAlt(s.altitudeM)}, ${PHASE_LABEL[s.phase].toLowerCase()}`),
          h('div', { class: 'muted' }, qiblaPhrase(abs, relativeBearing(abs, s.headingDeg), s.onGround)),
          ev.anomaly ? h('div', { class: 'badge alert' }, ev.anomaly) : null,
          ev.note === 'nearestLatitude' ? h('div', { class: 'badge warn' }, 'Times borrowed from the nearest location with a normal day') : null,
          ev.note === 'highLatitudeRule' ? h('div', { class: 'badge warn' }, 'High-latitude rule') : null,
        );
        m.bindPopup(body);
      }

      // aircraft
      const samples = data.result.samples;
      const first = samples[0].state;
      const icon = L.divIcon({ className: 'plane-icon', html: `<div class="plane">${PLANE_SVG}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      const plane: Marker = L.marker([first.lat, normalizeLon(first.lon)], { icon, keyboard: false, zIndexOffset: 1000, interactive: false }).addTo(map);
      let night: Polygon | null = null;
      let raf = 0;
      const apply = (i: number): void => {
        const s = samples[i];
        if (!s || !map) return;
        plane.setLatLng([s.state.lat, normalizeLon(s.state.lon)]);
        const inner = plane.getElement()?.firstElementChild as HTMLElement | null;
        if (inner) {
          inner.style.transform = `rotate(${s.state.onGround ? 0 : s.state.headingDeg}deg)`;
          inner.classList.toggle('grounded', s.state.onGround);
        }
        if (shadeBox.checked) {
          const poly = nightPolygon(s.state.time);
          if (night) night.setLatLngs(poly);
          else night = L.polygon(poly, { stroke: false, fillColor: '#0b1020', fillOpacity: 0.28, interactive: false }).addTo(map);
        } else if (night) {
          night.remove();
          night = null;
        }
      };
      const schedule = (i: number): void => {
        if (typeof requestAnimationFrame !== 'function') return apply(i);
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => apply(i));
      };
      unsub = model.scrub.subscribe(schedule);
      shadeBox.addEventListener('change', () => apply(model.scrub.index));
      apply(model.scrub.index);

      if (bounds.length > 0) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 6 });
      else map.setView([20, 40], 2);
      requestAnimationFrame(() => map?.invalidateSize());
    } catch (e) {
      map = null;
      setChildren(box, h('p', { class: 'map-msg' }, `The map could not be shown (${e instanceof Error ? e.message : 'unknown error'}). The times and tables above still work.`));
    }
  }

  if (!isJsdom() && typeof document !== 'undefined') {
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io?.disconnect();
            void init();
          }
        },
        { rootMargin: '200px' },
      );
      io.observe(box);
    } else {
      void init();
    }
  } else {
    setChildren(box, h('p', { class: 'map-msg' }, 'Map unavailable in this environment.'));
  }

  return {
    el,
    dispose() {
      disposed = true;
      io?.disconnect();
      unsub?.();
      try {
        map?.remove();
      } catch {
        /* ignore */
      }
      map = null;
    },
  };
}
