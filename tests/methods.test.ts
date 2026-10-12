import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS, MADHAB_INFO, METHODS, PROFILES, applyProfile, asrShadowFactor, customMethod, mergeSettings, validateSettings,
} from '../src/prayer/methods';
import type { Madhab, MethodId } from '../src/types';

describe('METHODS presets', () => {
  const expected: Record<string, [number, number | null, number | null]> = {
    karachi: [18, 18, null], mwl: [18, 17, null], isna: [15, 15, null], egypt: [19.5, 17.5, null],
    ummAlQura: [18.5, null, 90], gulf: [19.5, null, 90], kuwait: [18, 17.5, null], qatar: [18, null, 90],
    singapore: [20, 18, null], jakim: [20, 18, null], diyanet: [18, 17, null], tehran: [17.7, 14, null],
    jafari: [16, 14, null], france: [12, 12, null], russia: [16, 15, null], dubai: [18.2, 18.2, null], custom: [18, 18, null],
  };
  it.each(Object.entries(expected))('%s has the published angles/interval', (id, [fajr, isha, interval]) => {
    const m = METHODS[id as MethodId];
    expect(m.id).toBe(id);
    expect(m.fajrAngle).toBe(fajr);
    expect(m.ishaAngle).toBe(isha);
    expect(m.ishaIntervalMin).toBe(interval);
  });
  it('covers every MethodId and each preset validates', () => {
    expect(Object.keys(METHODS).sort()).toEqual(Object.keys(expected).sort());
    for (const m of Object.values(METHODS)) {
      expect(validateSettings({ ...DEFAULT_SETTINGS, method: m })).toEqual([]);
    }
  });
  it("Tehran and Ja'fari use a Maghrib angle and Ja'fari midnight", () => {
    expect(METHODS.tehran.maghribAngle).toBe(4.5);
    expect(METHODS.jafari.maghribAngle).toBe(4);
    expect(METHODS.tehran.midnight).toBe('jafari');
    expect(METHODS.jafari.midnight).toBe('jafari');
    expect(METHODS.karachi.maghribAngle).toBeNull();
    expect(METHODS.karachi.midnight).toBe('standard');
  });
});

describe('defaults = Barelvi (Ahl-e-Sunnat) profile', () => {
  it('Hanafi + Karachi 18/18, red-twilight rule 12 deg, Maghrib +3 min, dip for sunrise/sunset only', () => {
    expect(DEFAULT_SETTINGS.madhab).toBe('hanafi');
    expect(DEFAULT_SETTINGS.method.id).toBe('karachi');
    expect(DEFAULT_SETTINGS.method.fajrAngle).toBe(18);
    expect(DEFAULT_SETTINGS.method.ishaAngle).toBe(18);
    expect(DEFAULT_SETTINGS.highLatitudeRule).toBe('redTwilight');
    expect(DEFAULT_SETTINGS.redTwilightAngle).toBe(12);
    expect(DEFAULT_SETTINGS.fajrFallback).toBe('nearestLocation');
    expect(DEFAULT_SETTINGS.polarFallback).toBe('nearestLocation');
    expect(DEFAULT_SETTINGS.dipForSunriseSunset).toBe(true);
    expect(DEFAULT_SETTINGS.dipForTwilight).toBe(false);
    expect(DEFAULT_SETTINGS.offsets).toEqual({ fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 3, isha: 0 });
    expect(DEFAULT_SETTINGS.profile).toBe('barelvi');
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it('DEFAULT_SETTINGS equals the Barelvi profile, as a separate copy', () => {
    expect(DEFAULT_SETTINGS).toEqual(PROFILES.barelvi.settings);
    expect(DEFAULT_SETTINGS).toEqual(applyProfile('barelvi'));
    const a = applyProfile('barelvi');
    a.offsets.maghrib = 9;
    a.method.fajrAngle = 1;
    expect(PROFILES.barelvi.settings.offsets.maghrib).toBe(3);
    expect(PROFILES.barelvi.settings.method.fajrAngle).toBe(18);
    expect(DEFAULT_SETTINGS.offsets.maghrib).toBe(3);
  });
});

describe('PROFILES', () => {
  it('Deobandi: same Hanafi/Karachi 18/18, nearest-location rule, no offsets', () => {
    const d = PROFILES.deobandi.settings;
    expect(d.madhab).toBe('hanafi');
    expect(d.method).toEqual(METHODS.karachi);
    expect(d.highLatitudeRule).toBe('nearestLatitude');
    expect(d.polarFallback).toBe('nearestLocation');
    expect(Object.values(d.offsets).every((v) => v === 0)).toBe(true);
    expect(d.profile).toBe('deobandi');
    expect(validateSettings(d)).toEqual([]);
    expect(applyProfile('deobandi')).toEqual(d);
  });
  it('both profiles carry a label, a description and linked sources', () => {
    for (const id of ['barelvi', 'deobandi'] as const) {
      const p = PROFILES[id];
      expect(p.id).toBe(id);
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.description.length).toBeGreaterThan(40);
      expect(p.sources.length).toBeGreaterThanOrEqual(2);
      for (const src of p.sources) {
        expect(src.title.length).toBeGreaterThan(3);
        expect(src.url).toMatch(/^https:\/\//);
      }
    }
    expect(PROFILES.barelvi.sources.map((x) => x.url)).toContain('https://www.dawateislami.net/prayer-times/world/united-kingdom');
    expect(PROFILES.deobandi.sources.map((x) => x.url)).toContain('https://www.wifaqululama.co.uk/highlat/');
  });
});

describe('madhab', () => {
  it('Asr shadow factor: Hanafi 2, others 1', () => {
    expect(asrShadowFactor('hanafi')).toBe(2);
    for (const m of ['shafii', 'maliki', 'hanbali', 'jafari'] as Madhab[]) expect(asrShadowFactor(m)).toBe(1);
  });
  it('MADHAB_INFO is consistent with the factor and combining rules', () => {
    for (const m of Object.keys(MADHAB_INFO) as Madhab[]) {
      const info = MADHAB_INFO[m];
      expect(info.asrFactor).toBe(asrShadowFactor(m));
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.qasrNote.length).toBeGreaterThan(0);
      expect(info.notes.length).toBeGreaterThan(0);
      expect(info.allowsTravelCombining).toBe(m !== 'hanafi');
    }
    expect(MADHAB_INFO.hanafi.qasrNote).toMatch(/obligatory|wajib/i);
  });
});

describe('customMethod', () => {
  it('builds a custom method and honours overrides', () => {
    const c = customMethod(15, 14);
    expect(c).toMatchObject({ id: 'custom', fajrAngle: 15, ishaAngle: 14, ishaIntervalMin: null, maghribAngle: null, midnight: 'standard' });
    const i = customMethod(18.5, null, { ishaIntervalMin: 90, name: 'Mine' });
    expect(i.ishaAngle).toBeNull();
    expect(i.ishaIntervalMin).toBe(90);
    expect(i.name).toBe('Mine');
    expect(validateSettings({ ...DEFAULT_SETTINGS, method: i })).toEqual([]);
  });
});

describe('validateSettings', () => {
  const withMethod = (patch: object) => ({ ...DEFAULT_SETTINGS, method: { ...DEFAULT_SETTINGS.method, ...patch } });
  it('rejects out-of-range, non-finite angles and intervals', () => {
    expect(validateSettings(withMethod({ fajrAngle: -1 })).length).toBe(1);
    expect(validateSettings(withMethod({ fajrAngle: 30.5 })).length).toBe(1);
    expect(validateSettings(withMethod({ fajrAngle: NaN })).length).toBe(1);
    expect(validateSettings(withMethod({ ishaAngle: Infinity })).length).toBe(1);
    expect(validateSettings(withMethod({ ishaAngle: null, ishaIntervalMin: 241 })).length).toBe(1);
    expect(validateSettings(withMethod({ ishaAngle: null, ishaIntervalMin: -5 })).length).toBe(1);
    expect(validateSettings(withMethod({ maghribAngle: 31 })).length).toBe(1);
  });
  it('accepts the boundaries', () => {
    expect(validateSettings(withMethod({ fajrAngle: 0, ishaAngle: 30 }))).toEqual([]);
    expect(validateSettings(withMethod({ ishaAngle: null, ishaIntervalMin: 240 }))).toEqual([]);
    expect(validateSettings(withMethod({ ishaAngle: null, ishaIntervalMin: 0 }))).toEqual([]);
  });
  it('requires an Isha angle or an interval', () => {
    const errs = validateSettings(withMethod({ ishaAngle: null, ishaIntervalMin: null }));
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/isha/i);
  });
  it('limits offsets to ±120 minutes', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, offsets: { ...DEFAULT_SETTINGS.offsets, asr: 120, fajr: -120 } })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, offsets: { ...DEFAULT_SETTINGS.offsets, asr: 121 } }).length).toBe(1);
    expect(validateSettings({ ...DEFAULT_SETTINGS, offsets: { ...DEFAULT_SETTINGS.offsets, isha: NaN } }).length).toBe(1);
  });
  it('validates polarFallback; a missing value is fine', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, polarFallback: 'fixedLatitude' })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, polarFallback: 'nearestLocation' })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, polarFallback: undefined })).toEqual([]);
    const { polarFallback: _omit, ...legacy } = DEFAULT_SETTINGS;
    expect(validateSettings(legacy)).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, polarFallback: 'bogus' as never }).length).toBe(1);
  });
  it('validates the red-twilight angle, Fajr fallback and profile', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: 0 })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: 18 })).toEqual([]); // equal to Isha angle is fine
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: 18.5 }).length).toBe(1); // deeper than Isha
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: 31 }).length).toBe(1);
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: NaN }).length).toBe(1);
    expect(validateSettings({ ...DEFAULT_SETTINGS, redTwilightAngle: -1 }).length).toBe(1);
    // With an interval-based Isha there is no Isha angle to compare with.
    expect(validateSettings({ ...DEFAULT_SETTINGS, method: METHODS.ummAlQura, redTwilightAngle: 20 })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, fajrFallback: 'redTwilight' })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, fajrFallback: 'bogus' as never }).length).toBe(1);
    for (const profile of ['barelvi', 'deobandi', 'custom'] as const) expect(validateSettings({ ...DEFAULT_SETTINGS, profile })).toEqual([]);
    expect(validateSettings({ ...DEFAULT_SETTINGS, profile: 'x' as never }).length).toBe(1);
    expect(validateSettings({ ...DEFAULT_SETTINGS, highLatitudeRule: 'redTwilight' })).toEqual([]);
    const { redTwilightAngle: _a, fajrFallback: _b, profile: _c, ...legacy } = DEFAULT_SETTINGS;
    expect(validateSettings(legacy)).toEqual([]);
  });
  it('reports every problem, in plain language', () => {
    const errs = validateSettings({
      ...DEFAULT_SETTINGS,
      method: { ...DEFAULT_SETTINGS.method, fajrAngle: 99, ishaAngle: -3 },
      offsets: { ...DEFAULT_SETTINGS.offsets, maghrib: 500 },
    });
    expect(errs.length).toBe(4); // fajr, isha, the red twilight (12 > -3 isha angle) and the offset
    errs.forEach((e) => expect(e).toMatch(/\w+ \w+/));
  });
});

describe('mergeSettings', () => {
  it('returns the defaults for an empty partial, without aliasing them', () => {
    const m = mergeSettings({});
    expect(m).toEqual(DEFAULT_SETTINGS);
    expect(m).not.toBe(DEFAULT_SETTINGS);
    m.offsets.fajr = 5;
    m.method.fajrAngle = 1;
    expect(DEFAULT_SETTINGS.offsets.fajr).toBe(0);
    expect(DEFAULT_SETTINGS.method.fajrAngle).toBe(18);
  });
  it('deep-merges offsets and method fields, keeps everything else default', () => {
    const m = mergeSettings({ madhab: 'shafii', offsets: { asr: 3 } as never, method: { fajrAngle: 16 } as never });
    expect(m.madhab).toBe('shafii');
    expect(m.offsets).toEqual({ ...DEFAULT_SETTINGS.offsets, asr: 3 });
    expect(m.method).toEqual({ ...DEFAULT_SETTINGS.method, fajrAngle: 16 });
    expect(m.highLatitudeRule).toBe('redTwilight');
    expect(m.offsets.maghrib).toBe(3);
  });
  it('a full preset replaces the method, including null fields (Umm al-Qura interval)', () => {
    const m = mergeSettings({ method: METHODS.ummAlQura });
    expect(m.method).toEqual(METHODS.ummAlQura);
    expect(m.method.ishaAngle).toBeNull();
  });
  it('fills the red-twilight defaults and honours overrides', () => {
    const m = mergeSettings({ redTwilightAngle: 13, fajrFallback: 'redTwilight' });
    expect(m.redTwilightAngle).toBe(13);
    expect(m.fajrFallback).toBe('redTwilight');
    expect(mergeSettings({}).redTwilightAngle).toBe(12);
    expect(mergeSettings({ ...PROFILES.deobandi.settings }).highLatitudeRule).toBe('nearestLatitude');
    expect(mergeSettings({ ...PROFILES.deobandi.settings }).offsets.maghrib).toBe(0);
  });
  it("polarFallback defaults to 'nearestLocation' and can be overridden", () => {
    expect(mergeSettings({}).polarFallback).toBe('nearestLocation');
    expect(mergeSettings({ polarFallback: 'fixedLatitude' }).polarFallback).toBe('fixedLatitude');
    expect(mergeSettings({ polarFallback: undefined }).polarFallback).toBe('nearestLocation');
  });
  it('ignores undefined values', () => {
    const m = mergeSettings({ madhab: undefined, dipForTwilight: true });
    expect(m.madhab).toBe('hanafi');
    expect(m.dipForTwilight).toBe(true);
  });
});
