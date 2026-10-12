import { h } from './dom';

const REPO = 'https://github.com/usmanghani/inflight-prayer-times';

function ext(href: string, text: string): HTMLElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

export function renderAbout(): HTMLElement {
  return h(
    'footer',
    { class: 'wrap about', id: 'about' },
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'about-h' },
      h('h2', { id: 'about-h' }, 'About and method'),
      h('p', null, 'For every minute of your journey the app works out where the aircraft is (position and altitude), computes the prayer times for that exact place and solar date, and finds the moment the active window changes, refined to about one second. It also tracks the Sun’s altitude and the Qibla direction relative to the nose of the aircraft, and flags oddities a static timetable never shows: windows that repeat when flying west faster than the Sun, windows that never open at high latitude, polar day and night.'),
      h('p', null, 'At cruise altitude the horizon is lower (about 3.6° at 11 km), so sunset comes later and sunrise earlier than on the ground; you can switch this off in Settings. The full method, formulas and edge cases are described in ', ext(`${REPO}/blob/main/docs/ALGORITHM.md`, 'docs/ALGORITHM.md'), '. The source code is on ', ext(REPO, 'GitHub'), ' (MIT licence).'),
      h('h3', null, 'Data and attributions'),
      h(
        'ul',
        null,
        h('li', null, 'Airports: ', ext('https://ourairports.com/data/', 'OurAirports'), ' (public domain); time zones resolved with tz-lookup (CC0).'),
        h('li', null, 'Map: © ', ext('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors'), ' (tiles from tile.openstreetmap.org, shown with Leaflet).'),
        h('li', null, 'Real flight tracks, when you fetch them through an optional backend: ', ext('https://adsb.lol', 'adsb.lol'), ' (ODbL) and other providers named next to the track.'),
        h('li', null, 'Flight schedules in the built-in library are representative and change often; always trust your own ticket.'),
      ),
      h('h3', null, 'Disclaimer'),
      h('p', null, 'These are calculated schedules for planning, not fatwas. Calculation methods, high-latitude rules and the treatment of prayer while flying differ between scholars and institutions. Please consult a qualified scholar for rulings about your journey.'),
      h('h3', null, 'Privacy'),
      h('p', null, 'Everything runs on your device: your itinerary, photos (read with on-device OCR) and settings never leave your browser, and are stored only in your browser’s local storage. Nothing is sent anywhere unless you explicitly enable the optional AI or online lookup features, which use a backend you configure; the interface says what is sent before you turn them on. The map fetches tiles from OpenStreetMap, and the OCR engine downloads its language data the first time you use it; neither request contains your itinerary.'),
    ),
  );
}
