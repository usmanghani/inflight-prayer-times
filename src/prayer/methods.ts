/** Calculation-method presets, madhab info, defaults and settings validation. */
import type {
  CalculationMethod,
  HighLatitudeRule,
  MethodId,
  Madhab,
  MidnightMode,
  PrayerOffsets,
  PrayerSettings,
  ProfileId,
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

/** Red-twilight (shafaq ahmar) depression used by rule 'redTwilight': the Sahibayn's Isha, ≈12°. */
export const DEFAULT_RED_TWILIGHT_ANGLE = 12;

/** Offsets are all zero except where a profile says otherwise. */
const zeroOffsets = (): PrayerOffsets => ({ fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 });

export interface ProfileInfo {
  id: Exclude<ProfileId, 'custom'>;
  label: string;
  description: string;
  sources: { title: string; url: string }[];
  settings: PrayerSettings;
}

/**
 * Named bundles of settings that follow a published opinion. Both are Hanafi with Karachi 18°/18°;
 * they differ in what happens at latitudes where the 18° twilight does not occur.
 */
export const PROFILES: Record<'barelvi' | 'deobandi', ProfileInfo> = {
  barelvi: {
    id: 'barelvi',
    label: 'Barelvi (Ahl-e-Sunnat)',
    description:
      'Hanafi, Karachi 18°/18°, Maghrib 3 minutes after sunset (ihtiyat). Where the white twilight (18°) never ' +
      'disappears, Isha is not waived: out of necessity follow the Sahibayn (Abu Yusuf and Muhammad) and pray Isha ' +
      'after the red twilight (≈12°) as ada, returning to Imam Abu Hanifa\u2019s 18° whenever it occurs again. ' +
      'Fajr, if its angle is not reached, is taken from the nearest location where it is. Where the Sun does not ' +
      'rise/set, the times of the nearest location with a normal day are used.',
    sources: [
      { title: 'Fatawa Razaviyya / FatwaQA: Isha time on bright nights (Urdu)', url: 'https://www.fatwaqa.com/ur/fatawa/namaz/bright-night-mein-isha-ka-waqt' },
      { title: 'Al-Jamiatul Ashrafia: ruling on Isha when twilight does not disappear', url: 'https://www.aljamiatulashrafia.in/answer.php?qid=1401&cat=9484635342544&uit=1983642563487650970&lang=EN' },
      { title: 'Dawat-e-Islami prayer times (United Kingdom)', url: 'https://www.dawateislami.net/prayer-times/world/united-kingdom' },
    ],
    settings: {
      madhab: 'hanafi',
      method: { ...METHODS.karachi },
      highLatitudeRule: 'redTwilight',
      redTwilightAngle: DEFAULT_RED_TWILIGHT_ANGLE,
      fajrFallback: 'nearestLocation',
      polarFallback: 'nearestLocation',
      dipForSunriseSunset: true,
      dipForTwilight: false,
      offsets: { ...zeroOffsets(), maghrib: 3 },
      profile: 'barelvi',
    },
  },
  deobandi: {
    id: 'deobandi',
    label: 'Deobandi',
    description:
      'Hanafi, Karachi 18°/18°, no offsets. Where the 18° twilight does not occur, Fajr and Isha follow the nearest ' +
      'location (aqrab al-bilad) where it does, computed dynamically for the date and longitude; likewise when the ' +
      'Sun does not rise or set.',
    sources: [
      { title: 'Wifaq ul Ulama UK: high-latitude timetable guidance', url: 'https://www.wifaqululama.co.uk/highlat/' },
      { title: 'AskImam: Fajr and Isha times in extreme latitudes', url: 'https://www.askimam.org/public/question_detail/15287' },
    ],
    settings: {
      madhab: 'hanafi',
      method: { ...METHODS.karachi },
      highLatitudeRule: 'nearestLatitude',
      redTwilightAngle: DEFAULT_RED_TWILIGHT_ANGLE,
      fajrFallback: 'nearestLocation',
      polarFallback: 'nearestLocation',
      dipForSunriseSunset: true,
      dipForTwilight: false,
      offsets: zeroOffsets(),
      profile: 'deobandi',
    },
  },
};

/** A fresh (deep-copied) settings object for a named profile. */
export function applyProfile(id: 'barelvi' | 'deobandi'): PrayerSettings {
  const p = (PROFILES[id] ?? PROFILES.barelvi).settings;
  return { ...p, method: { ...p.method }, offsets: { ...p.offsets } };
}

/** Default settings = the Barelvi (Ahl-e-Sunnat) profile. */
export const DEFAULT_SETTINGS: PrayerSettings = applyProfile('barelvi');

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
  'redTwilight',
  'none',
];
const FAJR_FALLBACKS: readonly NonNullable<PrayerSettings['fajrFallback']>[] = ['nearestLocation', 'redTwilight'];
const PROFILE_IDS: readonly ProfileId[] = ['barelvi', 'deobandi', 'custom'];
const POLAR_FALLBACKS: readonly NonNullable<PrayerSettings['polarFallback']>[] = ['nearestLocation', 'fixedLatitude'];
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

  // Optional: a missing value means 'nearestLocation'.
  if (s.polarFallback !== undefined && !POLAR_FALLBACKS.includes(s.polarFallback)) {
    errors.push(`Unknown polar fallback "${String(s.polarFallback)}".`);
  }

  if (s.fajrFallback !== undefined && !FAJR_FALLBACKS.includes(s.fajrFallback)) {
    errors.push(`Unknown Fajr fallback "${String(s.fajrFallback)}".`);
  }
  if (s.profile !== undefined && !PROFILE_IDS.includes(s.profile)) {
    errors.push(`Unknown profile "${String(s.profile)}".`);
  }

  const m = s.method;
  if (s.redTwilightAngle !== undefined) {
    if (!inRange(s.redTwilightAngle, 0, 30)) {
      errors.push('The red-twilight angle must be a number between 0\u00b0 and 30\u00b0.');
    } else if (m && typeof m === 'object' && typeof m.ishaAngle === 'number' && s.redTwilightAngle > m.ishaAngle) {
      errors.push('The red-twilight angle must not exceed the Isha angle (it is the shallower fallback twilight).');
    }
  }
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
