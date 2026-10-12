/** Calculation-method presets, madhab info, defaults and settings validation. */
import type {
  CalculationMethod,
  HighLatitudeRule,
  MethodId,
  Madhab,
  MidnightMode,
  PrayerOffsets,
  PrayerSettings,
} from '../types';

/** Build a preset. Isha is by angle unless `isha` is a `{ interval }`. */
function preset(
  id: MethodId,
  name: string,
  fajrAngle: number,
  isha: number | { interval: number },
  extra: { maghribAngle?: number; midnight?: MidnightMode } = {},
): CalculationMethod {
  const byInterval = typeof isha !== 'number';
  return {
    id,
    name,
    fajrAngle,
    ishaAngle: byInterval ? null : isha,
    ishaIntervalMin: byInterval ? isha.interval : null,
    maghribAngle: extra.maghribAngle ?? null,
    midnight: extra.midnight ?? 'standard',
  };
}

/** Widely published parameter sets (angles in degrees below the horizon). */
export const METHODS: Record<MethodId, CalculationMethod> = {
  karachi: preset('karachi', 'University of Islamic Sciences, Karachi', 18, 18),
  mwl: preset('mwl', 'Muslim World League', 18, 17),
  isna: preset('isna', 'Islamic Society of North America (ISNA)', 15, 15),
  egypt: preset('egypt', 'Egyptian General Authority of Survey', 19.5, 17.5),
  ummAlQura: preset('ummAlQura', 'Umm al-Qura University, Makkah', 18.5, { interval: 90 }),
  gulf: preset('gulf', 'Gulf Region', 19.5, { interval: 90 }),
  kuwait: preset('kuwait', 'Kuwait', 18, 17.5),
  qatar: preset('qatar', 'Qatar', 18, { interval: 90 }),
  singapore: preset('singapore', 'Singapore (MUIS)', 20, 18),
  jakim: preset('jakim', 'Malaysia (JAKIM)', 20, 18),
  diyanet: preset('diyanet', 'Diyanet, Turkey', 18, 17),
  tehran: preset('tehran', 'Institute of Geophysics, Univ. of Tehran', 17.7, 14, {
    maghribAngle: 4.5,
    midnight: 'jafari',
  }),
  jafari: preset('jafari', "Shia Ithna-Ashari (Ja'fari, Leva Institute, Qum)", 16, 14, {
    maghribAngle: 4,
    midnight: 'jafari',
  }),
  france: preset('france', 'France (UOIF)', 12, 12),
  russia: preset('russia', 'Russia (Spiritual Administration of Muslims)', 16, 15),
  dubai: preset('dubai', 'Dubai (UAE)', 18.2, 18.2),
  custom: preset('custom', 'Custom', 18, 18),
};

/** Default settings: Hanafi Asr, Karachi 18°/18°, angle-based high-latitude rule, dip on for sunrise/sunset. */
export const DEFAULT_SETTINGS: PrayerSettings = {
  madhab: 'hanafi',
  method: { ...METHODS.karachi },
  highLatitudeRule: 'angleBased',
  dipForSunriseSunset: true,
  dipForTwilight: false,
  offsets: { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
};

/** Asr shadow multiple: Hanafi = 2 (shadow = twice the object + noon shadow), all others = 1. */
export function asrShadowFactor(m: Madhab): 1 | 2 {
  return m === 'hanafi' ? 2 : 1;
}

export const MADHAB_INFO: Record<
  Madhab,
  { label: string; asrFactor: 1 | 2; allowsTravelCombining: boolean; qasrNote: string; notes: string }
> = {
  hanafi: {
    label: 'Hanafi',
    asrFactor: 2,
    allowsTravelCombining: false,
    qasrNote: 'Shortening (qasr) the four-rak‘ah prayers to two is obligatory (wajib) for a traveller (musafir).',
    notes:
      'Asr begins when an object’s shadow is twice its length (plus the noon shadow). Prayers are not combined while travelling, except Dhuhr+Asr at ‘Arafah and Maghrib+Isha at Muzdalifah on Hajj.',
  },
  shafii: {
    label: "Shafi'i",
    asrFactor: 1,
    allowsTravelCombining: true,
    qasrNote: 'Qasr is permitted for a traveller and recommended (sunnah/afdal) when the journey meets the distance requirement.',
    notes:
      'Asr begins when an object’s shadow equals its length (plus the noon shadow). Combining (jam‘) Dhuhr+Asr and Maghrib+Isha is permitted while travelling.',
  },
  maliki: {
    label: 'Maliki',
    asrFactor: 1,
    allowsTravelCombining: true,
    qasrNote: 'Qasr is permitted for a traveller (a confirmed sunnah in the school) when the journey meets the distance requirement.',
    notes:
      'Asr begins when an object’s shadow equals its length (plus the noon shadow). Combining (jam‘) is permitted while travelling.',
  },
  hanbali: {
    label: 'Hanbali',
    asrFactor: 1,
    allowsTravelCombining: true,
    qasrNote: 'Qasr is permitted for a traveller and recommended (afdal) when the journey meets the distance requirement.',
    notes:
      'Asr begins when an object’s shadow equals its length (plus the noon shadow). Combining (jam‘) is permitted while travelling.',
  },
  jafari: {
    label: "Ja'fari (Twelver Shia)",
    asrFactor: 1,
    allowsTravelCombining: true,
    qasrNote: 'Qasr is obligatory for a traveller who meets the distance and intention conditions.',
    notes:
      'Asr is computed with shadow factor 1. Combining Dhuhr+Asr and Maghrib+Isha is permitted; Ja’fari tables normally use a sun angle for Maghrib and Fajr/Isha (set the Ja’fari or Tehran preset).',
  },
};

/** Convenience builder for a custom method (id 'custom'); `opts` may override any field. */
export function customMethod(
  fajrAngle: number,
  ishaAngle: number | null,
  opts: Partial<CalculationMethod> = {},
): CalculationMethod {
  return {
    id: 'custom',
    name: 'Custom',
    fajrAngle,
    ishaAngle,
    ishaIntervalMin: null,
    maghribAngle: null,
    midnight: 'standard',
    ...opts,
  };
}

const MADHABS: readonly Madhab[] = ['hanafi', 'shafii', 'maliki', 'hanbali', 'jafari'];
const RULES: readonly HighLatitudeRule[] = [
  'angleBased',
  'oneSeventh',
  'middleOfNight',
  'nearestLatitude',
  'none',
];
const OFFSET_KEYS: readonly (keyof PrayerOffsets)[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

function inRange(x: unknown, lo: number, hi: number): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
}

/** Human-readable validation errors; an empty array means the settings are usable. */
export function validateSettings(s: PrayerSettings): string[] {
  const errors: string[] = [];
  if (!s || typeof s !== 'object') return ['Settings are missing.'];

  if (!MADHABS.includes(s.madhab)) errors.push(`Unknown madhab "${String(s.madhab)}".`);
  if (!RULES.includes(s.highLatitudeRule)) {
    errors.push(`Unknown high-latitude rule "${String(s.highLatitudeRule)}".`);
  }

  const m = s.method;
  if (!m || typeof m !== 'object') {
    errors.push('Calculation method is missing.');
  } else {
    if (!inRange(m.fajrAngle, 0, 30)) errors.push('Fajr angle must be a number between 0° and 30°.');
    if (m.ishaAngle !== null && !inRange(m.ishaAngle, 0, 30)) {
      errors.push('Isha angle must be a number between 0° and 30°.');
    }
    if (m.ishaIntervalMin !== null && !inRange(m.ishaIntervalMin, 0, 240)) {
      errors.push('Isha interval must be between 0 and 240 minutes after Maghrib.');
    }
    if (m.maghribAngle !== null && !inRange(m.maghribAngle, 0, 30)) {
      errors.push('Maghrib angle must be a number between 0° and 30°.');
    }
    if (m.ishaAngle === null && m.ishaIntervalMin === null) {
      errors.push('Set either an Isha angle or an Isha interval (minutes after Maghrib).');
    }
    if (m.midnight !== 'standard' && m.midnight !== 'jafari') {
      errors.push(`Unknown midnight mode "${String(m.midnight)}".`);
    }
  }

  const o = s.offsets;
  if (!o || typeof o !== 'object') {
    errors.push('Prayer offsets are missing.');
  } else {
    for (const k of OFFSET_KEYS) {
      if (!inRange(o[k], -120, 120)) errors.push(`The ${k} offset must be between -120 and +120 minutes.`);
    }
  }
  return errors;
}

/** Deep-merge a partial settings object onto DEFAULT_SETTINGS (undefined values are ignored). */
export function mergeSettings(partial: Partial<PrayerSettings>): PrayerSettings {
  const p = partial ?? {};
  const defined = <T extends object>(o: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

  return {
    ...DEFAULT_SETTINGS,
    ...defined(p),
    method: { ...DEFAULT_SETTINGS.method, ...defined<Partial<CalculationMethod>>(p.method) },
    offsets: { ...DEFAULT_SETTINGS.offsets, ...defined<Partial<PrayerOffsets>>(p.offsets) },
  } as PrayerSettings;
}
