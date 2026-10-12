/** Collapsible settings: madhab, calculation method, angles, high-latitude rule, dip, offsets, display zones, sampling. */
import type { HighLatitudeRule, Madhab, MethodId, PrayerOffsets, ProfileId } from '../types';
import { METHODS, MADHAB_INFO, PROFILES, applyProfile, validateSettings } from '../prayer/methods';
import { h, parseNumber, setChildren, uid } from './dom';
import { STEP_CHOICES, defaultAppSettings, type AppSettings, type TzChoice } from './model';

type PolarFallback = NonNullable<AppSettings['prayer']['polarFallback']>;
type FajrFallback = NonNullable<AppSettings['prayer']['fajrFallback']>;

export interface SettingsPanel {
  el: HTMLElement;
  get(): AppSettings;
  set(s: AppSettings): void;
  /** Current validation messages (empty when usable). */
  errors(): string[];
}

const HL_RULES: { id: HighLatitudeRule; label: string; help: string }[] = [
  { id: 'angleBased', label: 'Angle-based', help: 'Night portion = angle ÷ 60: when twilight never ends, Fajr/Isha take a share of the night proportional to their angle.' },
  { id: 'oneSeventh', label: 'One-seventh of the night', help: 'Fajr starts 1/7 of the night before sunrise; Isha ends 1/7 of the night after sunset.' },
  { id: 'middleOfNight', label: 'Middle of the night', help: 'Fajr/Isha are placed at half of the night.' },
  { id: 'nearestLatitude', label: 'Nearest location (aqrab al-bilad) — Deobandi', help: 'Fajr and Isha are borrowed from the nearest place on the same meridian where the twilight angle is reached (or from 48.5° if you choose a fixed latitude below).' },
  { id: 'redTwilight', label: 'Red twilight (Sahibayn) for Isha — Barelvi', help: 'Where the white twilight (18°) never ends, Isha is prayed when the red twilight has gone (≈12°), following Abu Yusuf and Muhammad out of necessity; Imam Abu Hanifa’s 18° applies whenever it occurs.' },
  { id: 'none', label: 'None', help: 'Leave Fajr/Isha empty when the Sun never reaches the twilight angle. Windows may then be missing.' },
];

const METHOD_ORDER: MethodId[] = [
  'karachi', 'mwl', 'isna', 'egypt', 'ummAlQura', 'gulf', 'kuwait', 'qatar', 'singapore', 'jakim', 'diyanet', 'tehran', 'jafari', 'france', 'russia', 'dubai', 'custom',
];

const OFFSET_ROWS: { key: keyof PrayerOffsets; label: string }[] = [
  { key: 'fajr', label: 'Fajr' },
  { key: 'sunrise', label: 'Sunrise' },
  { key: 'dhuhr', label: 'Dhuhr' },
  { key: 'asr', label: 'Asr' },
  { key: 'maghrib', label: 'Maghrib' },
  { key: 'isha', label: 'Isha' },
];

export function createSettingsPanel(initial: AppSettings, onChange: (s: AppSettings, errors: string[]) => void): SettingsPanel {
  let s: AppSettings = structuredCloneSafe(initial);
  /** Field-level text problems ("enter a number") that never reach the settings object. */
  const fieldErrors = new Map<string, string>();

  const errBox = h('div', { class: 'msg-list error settings-errors', role: 'alert', 'aria-live': 'assertive' });
  const refs: Record<string, HTMLElement> = {};

  function allErrors(): string[] {
    return [...fieldErrors.values(), ...validateSettings(s.prayer)];
  }
  /**
   * 'edit' (default): a prayer-setting change, so the profile becomes 'custom' (values are kept).
   * 'profile': a profile was chosen. 'display': display-only (zones, step). 'none': nothing changed.
   */
  function emit(kind: 'edit' | 'profile' | 'display' | 'none' = 'edit'): void {
    if (kind === 'edit' && s.prayer.profile !== 'custom') {
      s.prayer.profile = 'custom';
      refreshProfile();
    }
    const errs = allErrors();
    setChildren(errBox, errs.map((e) => h('div', null, e)));
    errBox.hidden = errs.length === 0;
    onChange(s, errs);
  }

  // ───── field builders ─────
  function numberInput(key: string, getter: () => number | null, setter: (n: number) => void, opts: { label: string; unit?: string; step?: number; placeholder?: string; help?: string }): HTMLElement {
    const id = uid(`set-${key}`);
    const input = h('input', {
      id, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: opts.placeholder ?? '',
      'aria-describedby': `${id}-err`, class: 'num',
    });
    const err = h('div', { id: `${id}-err`, class: 'field-error', 'aria-live': 'polite' });
    refs[key] = input;
    const v = getter();
    input.value = v === null ? '' : String(v);
    input.addEventListener('input', () => {
      const n = parseNumber(input.value);
      let kind: 'edit' | 'none' = 'edit';
      if (n === null) {
        kind = 'none';
        fieldErrors.set(key, `${opts.label}: enter a number${opts.unit ? ` of ${opts.unit}` : ''}.`);
        input.setAttribute('aria-invalid', 'true');
        setChildren(err, 'Enter a number.');
      } else {
        fieldErrors.delete(key);
        input.removeAttribute('aria-invalid');
        setChildren(err);
        setter(n);
      }
      emit(kind);
    });
    return h('div', { class: 'field' }, h('label', { for: id }, opts.label), input, err, opts.help ? h('div', { class: 'ac-caption' }, opts.help) : null);
  }

  function select<T extends string>(label: string, id: string, options: { value: T; label: string }[], value: T, on: (v: T) => void, help?: HTMLElement): HTMLElement {
    const el = h('select', { id }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
    el.value = value;
    el.addEventListener('change', () => on(el.value as T));
    refs[id] = el;
    return h('div', { class: 'field' }, h('label', { for: id }, label), el, help ?? null);
  }

  function checkbox(id: string, label: string, checked: boolean, on: (v: boolean) => void, help?: string): HTMLElement {
    const el = h('input', { type: 'checkbox', id, checked });
    el.addEventListener('change', () => on(el.checked));
    refs[id] = el;
    return h('div', { class: 'check' }, el, h('label', { for: id }, label), help ? h('div', { class: 'ac-caption indent' }, help) : null);
  }

  const markCustom = (): void => {
    s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom' };
    const sel = refs['set-method'] as HTMLSelectElement | undefined;
    if (sel) sel.value = 'custom';
  };

  // ───── profile ─────
  const PROFILE_OPTIONS: { value: ProfileId; label: string }[] = [
    { value: 'barelvi', label: `${PROFILES.barelvi.label} — default` },
    { value: 'deobandi', label: PROFILES.deobandi.label },
    { value: 'custom', label: 'Custom' },
  ];
  let profileInfo: HTMLElement | null = null;

  function renderProfileInfo(): void {
    if (!profileInfo) return;
    const id = s.prayer.profile ?? 'custom';
    const info = id === 'custom' ? null : PROFILES[id];
    setChildren(
      profileInfo,
      h('p', { class: 'profile-desc' }, info ? info.description : 'Your own combination of settings. Choose Barelvi or Deobandi to return to a published profile.'),
      info
        ? h('div', { class: 'profile-sources' }, h('strong', null, 'Sources: '),
            h('ul', null, info.sources.map((src) => h('li', null, h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.title)))))
        : null,
      h('p', { class: 'hint profile-disclaimer' }, 'Follow your own mufti; this app is not a fatwa.'),
    );
  }

  function refreshProfile(): void {
    const sel = refs['set-profile'] as HTMLSelectElement | undefined;
    if (sel) sel.value = s.prayer.profile ?? 'custom';
    renderProfileInfo();
  }

  function profileBlock(): HTMLElement {
    profileInfo = h('div', { class: 'profile-info', id: 'profile-info', 'aria-live': 'polite' });
    const sel = select<ProfileId>('Profile', 'set-profile', PROFILE_OPTIONS, s.prayer.profile ?? 'custom', (v) => {
      if (v === 'custom') {
        s.prayer.profile = 'custom';
      } else {
        s.prayer = applyProfile(v);
      }
      fieldErrors.clear();
      build();
      emit('profile');
      refs['set-profile']?.focus();
    });
    renderProfileInfo();
    return h('div', { class: 'profile-block' }, sel, profileInfo);
  }

  // ───── sections (re-rendered on set()) ─────
  const body = h('div', { class: 'settings-body' });

  function build(): void {
    const m = s.prayer.method;
    const hlHelp = h('div', { class: 'ac-caption', id: 'hl-help', 'aria-live': 'polite' }, HL_RULES.find((r) => r.id === s.prayer.highLatitudeRule)?.help ?? '');

    const madhab = select<Madhab>(
      'Asr method (madhab)', 'set-madhab',
      (Object.keys(MADHAB_INFO) as Madhab[]).map((k) => ({ value: k, label: `${MADHAB_INFO[k].label}${MADHAB_INFO[k].asrFactor === 2 ? ' (Asr shadow ×2)' : ' (Asr shadow ×1)'}` })),
      s.prayer.madhab,
      (v) => {
        s.prayer.madhab = v;
        emit();
      },
    );

    const methodSel = select<MethodId>(
      'Calculation method', 'set-method',
      METHOD_ORDER.map((id) => ({ value: id, label: `${METHODS[id].name}${id === 'custom' ? '' : ` — ${METHODS[id].fajrAngle}°/${METHODS[id].ishaAngle ?? `${METHODS[id].ishaIntervalMin} min`}`}` })),
      m.id,
      (id) => {
        if (id === 'custom') {
          s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom' };
        } else {
          s.prayer.method = { ...METHODS[id] };
        }
        fieldErrors.clear();
        build();
        emit();
      },
    );

    const fajr = numberInput('fajr', () => s.prayer.method.fajrAngle, (n) => {
      s.prayer.method.fajrAngle = n;
      markCustom();
    }, { label: 'Fajr angle (°)', unit: 'degrees', placeholder: '18', help: 'Sun depression below the horizon, 0–30°.' });

    const ishaByInterval = m.ishaAngle === null && m.ishaIntervalMin !== null;
    const ishaMode = select<'angle' | 'interval'>(
      'Isha is determined by', 'set-isha-mode',
      [{ value: 'angle', label: 'Sun angle' }, { value: 'interval', label: 'Minutes after Maghrib' }],
      ishaByInterval ? 'interval' : 'angle',
      (v) => {
        if (v === 'interval') {
          s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom', ishaAngle: null, ishaIntervalMin: s.prayer.method.ishaIntervalMin ?? 90 };
        } else {
          s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom', ishaAngle: s.prayer.method.ishaAngle ?? 18, ishaIntervalMin: null };
        }
        fieldErrors.clear();
        build();
        emit();
      },
    );
    const isha = ishaByInterval
      ? numberInput('isha-int', () => s.prayer.method.ishaIntervalMin, (n) => {
          s.prayer.method.ishaIntervalMin = n;
          markCustom();
        }, { label: 'Isha interval (minutes after Maghrib)', unit: 'minutes', placeholder: '90', help: 'For example 90 for Umm al-Qura.' })
      : numberInput('isha', () => s.prayer.method.ishaAngle, (n) => {
          s.prayer.method.ishaAngle = n;
          markCustom();
        }, { label: 'Isha angle (°)', unit: 'degrees', placeholder: '18', help: 'Sun depression below the horizon, 0–30°.' });

    const mgId = 'set-maghrib-mode';
    const maghribMode = select<'sunset' | 'angle'>(
      'Maghrib begins at', mgId,
      [{ value: 'sunset', label: 'Sunset' }, { value: 'angle', label: 'A sun angle (Ja’fari: 4°)' }],
      m.maghribAngle === null ? 'sunset' : 'angle',
      (v) => {
        s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom', maghribAngle: v === 'sunset' ? null : (s.prayer.method.maghribAngle ?? 4) };
        fieldErrors.clear();
        build();
        emit();
      },
    );
    const maghribAngle =
      m.maghribAngle === null
        ? null
        : numberInput('maghrib', () => s.prayer.method.maghribAngle, (n) => {
            s.prayer.method.maghribAngle = n;
            markCustom();
          }, { label: 'Maghrib angle (°)', unit: 'degrees', placeholder: '4' });

    const midnight = select<'standard' | 'jafari'>(
      'Islamic midnight', 'set-midnight',
      [{ value: 'standard', label: 'Sunset → sunrise (standard)' }, { value: 'jafari', label: 'Sunset → Fajr (Ja’fari)' }],
      m.midnight,
      (v) => {
        s.prayer.method = { ...s.prayer.method, id: 'custom', name: 'Custom', midnight: v };
        const sel = refs['set-method'] as HTMLSelectElement | undefined;
        if (sel) sel.value = 'custom';
        emit();
      },
    );

    const hl = select<HighLatitudeRule>(
      'High-latitude rule', 'set-hl',
      HL_RULES.map((r) => ({ value: r.id, label: r.label })),
      s.prayer.highLatitudeRule,
      (v) => {
        s.prayer.highLatitudeRule = v;
        emit();
        build(); // shows/hides the red-twilight controls
        refs['set-hl']?.focus();
      },
      hlHelp,
    );

    const redOn = s.prayer.highLatitudeRule === 'redTwilight';
    const redAngle = redOn
      ? numberInput('red', () => s.prayer.redTwilightAngle ?? 12, (n) => {
          s.prayer.redTwilightAngle = n;
        }, { label: 'Red-twilight angle (°)', unit: 'degrees', placeholder: '12', help: 'Sun depression at which the red twilight (shafaq ahmar) ends; used for Isha when 18° does not occur. Default 12°, must not exceed the Isha angle.' })
      : null;
    const fajrFb = redOn
      ? select<FajrFallback>(
          'Fajr when 18° never occurs', 'set-fajr-fb',
          [
            { value: 'nearestLocation', label: 'Nearest location — default' },
            { value: 'redTwilight', label: 'Red twilight angle' },
          ],
          s.prayer.fajrFallback ?? 'nearestLocation',
          (v) => {
            s.prayer.fajrFallback = v;
            emit();
          },
          h('div', { class: 'ac-caption' }, 'Barelvi practice borrows Fajr from the nearest place where it occurs; the alternative uses the red-twilight angle at the aircraft’s own position.'),
        )
      : null;

    const polarHelp: Record<PolarFallback, string> = {
      nearestLocation: 'When the Sun never rises or sets (or twilight never ends) the times are borrowed from the nearest place along the same meridian with a normal day.',
      fixedLatitude: 'When the Sun never rises or sets (or twilight never ends) the times of latitude 48.5° at the same longitude are used.',
    };
    const polarNow: PolarFallback = s.prayer.polarFallback ?? 'nearestLocation';
    const polarNote = h('div', { class: 'ac-caption', id: 'polar-help', 'aria-live': 'polite' }, polarHelp[polarNow]);
    const polar = select<PolarFallback>(
      'Polar day / night', 'set-polar',
      [
        { value: 'nearestLocation', label: 'Nearest location where the sun rises and sets (aqrab al-bilad) — default' },
        { value: 'fixedLatitude', label: 'Fixed latitude 48.5°' },
      ],
      polarNow,
      (v) => {
        s.prayer.polarFallback = v;
        setChildren(polarNote, polarHelp[v]);
        emit();
      },
      polarNote,
    );

    const dip = h(
      'fieldset',
      { class: 'sub' },
      h('legend', null, 'Horizon dip at altitude'),
      checkbox('set-dip-ss', 'Apply horizon dip to sunrise and Maghrib', s.prayer.dipForSunriseSunset, (v) => {
        s.prayer.dipForSunriseSunset = v;
        emit();
      }, 'At 11 km the horizon is ≈3.6° lower, so sunset comes later and sunrise earlier.'),
      checkbox('set-dip-tw', 'Also apply it to Fajr and Isha twilight angles', s.prayer.dipForTwilight, (v) => {
        s.prayer.dipForTwilight = v;
        emit();
      }, 'Off by default: most scholars take the twilight angles from the geometric horizon.'),
    );

    const offsets = h(
      'details',
      { class: 'sub' },
      h('summary', null, 'Per-prayer offsets (ihtiyat), minutes'),
      h(
        'div',
        { class: 'grid-2' },
        OFFSET_ROWS.map((r) =>
          numberInput(`off-${r.key}`, () => s.prayer.offsets[r.key], (n) => {
            s.prayer.offsets[r.key] = n;
          }, { label: `${r.label} (min)`, unit: 'minutes', placeholder: '0', help: undefined }),
        ),
      ),
    );

    const tzSet = h(
      'fieldset',
      { class: 'sub' },
      h('legend', null, 'Show times in'),
      ([['utc', 'UTC'], ['origin', 'Origin airport zone'], ['dest', 'Destination airport zone'], ['aircraft', 'Zone under the aircraft']] as [TzChoice, string][]).map(([k, label]) =>
        checkbox(`set-tz-${k}`, label, s.tzChoices.includes(k), (v) => {
          const set = new Set(s.tzChoices);
          if (v) set.add(k);
          else set.delete(k);
          if (set.size === 0) set.add('utc');
          s.tzChoices = Array.from(set) as TzChoice[];
          const utcBox = refs['set-tz-utc'] as HTMLInputElement | undefined;
          if (utcBox && s.tzChoices.length === 1 && s.tzChoices[0] === 'utc') utcBox.checked = true;
          emit('display');
        }),
      ),
    );

    const step = select<string>(
      'Sampling step', 'set-step',
      STEP_CHOICES.map((n) => ({ value: String(n), label: n === 1 ? '1 minute (default)' : `${n} minutes` })),
      String(s.stepMinutes),
      (v) => {
        s.stepMinutes = Number(v);
        emit('display');
      },
      h('div', { class: 'ac-caption' }, 'Window changes are always refined to about one second, whatever the step.'),
    );

    setChildren(
      body,
      profileBlock(),
      h('div', { class: 'grid-2' }, madhab, methodSel),
      h('div', { class: 'grid-2' }, fajr, ishaMode),
      h('div', { class: 'grid-2' }, isha, maghribMode),
      maghribAngle ? h('div', { class: 'grid-2' }, maghribAngle) : null,
      h('div', { class: 'grid-2' }, midnight, hl),
      redAngle || fajrFb ? h('div', { class: 'grid-2' }, redAngle, fajrFb) : null,
      h('div', { class: 'grid-2' }, polar),
      dip,
      offsets,
      tzSet,
      h('div', { class: 'grid-2' }, step),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn subtle small', onClick: () => {
          s = defaultAppSettings();
          fieldErrors.clear();
          build();
          emit('profile');
        } }, 'Reset to defaults'),
      ),
    );
  }

  const el = h(
    'details',
    { class: 'card settings-card', id: 'settings' },
    h('summary', null, h('h2', { class: 'inline' }, '2. Settings'), h('span', { class: 'muted summary-note', id: 'settings-summary' })),
    body,
    errBox,
  );
  errBox.hidden = true;

  function summaryText(): string {
    const m = s.prayer.method;
    const prof = s.prayer.profile === 'barelvi' || s.prayer.profile === 'deobandi' ? `${PROFILES[s.prayer.profile].label.split(' (')[0]} profile · ` : '';
    return `${prof}${MADHAB_INFO[s.prayer.madhab].label} · ${m.id === 'custom' ? 'Custom' : m.name.split(',')[0].split('(')[0].trim()} ${m.fajrAngle}°/${m.ishaAngle ?? `${m.ishaIntervalMin} min`}`;
  }
  const updateSummary = (): void => {
    const n = el.querySelector('#settings-summary');
    if (n) n.textContent = summaryText();
  };

  build();
  updateSummary();
  body.addEventListener('change', updateSummary);
  body.addEventListener('input', updateSummary);

  return {
    el,
    get: () => s,
    set(next) {
      s = structuredCloneSafe(next);
      fieldErrors.clear();
      build();
      updateSummary();
      setChildren(errBox, allErrors().map((e) => h('div', null, e)));
      errBox.hidden = allErrors().length === 0;
    },
    errors: allErrors,
  };
}

function structuredCloneSafe<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
