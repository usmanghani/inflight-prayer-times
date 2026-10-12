import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS, MADHAB_INFO, METHODS, asrShadowFactor, customMethod, mergeSettings, validateSettings,
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

describe('defaults', () => {
  it('Hanafi + Karachi 18/18, angle-based, dip for sunrise/sunset only, zero offsets', () => {
    expect(DEFAULT_SETTINGS.madhab).toBe('hanafi');
    expect(DEFAULT_SETTINGS.method.id).toBe('karachi');
    expect(DEFAULT_SETTINGS.method.fajrAngle).toBe(18);
    expect(DEFAULT_SETTINGS.method.ishaAngle).toBe(18);
    expect(DEFAULT_SETTINGS.highLatitudeRule).toBe('angleBased');
    expect(DEFAULT_SETTINGS.dipForSunriseSunset).toBe(true);
    expect(DEFAULT_SETTINGS.dipForTwilight).toBe(false);
    expect(Object.values(DEFAULT_SETTINGS.offsets).every((v) => v === 0)).toBe(true);
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
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
  it('reports every problem, in plain language', () => {
    const errs = validateSettings({
      ...DEFAULT_SETTINGS,
      method: { ...DEFAULT_SETTINGS.method, fajrAngle: 99, ishaAngle: -3 },
      offsets: { ...DEFAULT_SETTINGS.offsets, maghrib: 500 },
    });
    expect(errs.length).toBe(3);
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
    expect(m.highLatitudeRule).toBe('angleBased');
  });
  it('a full preset replaces the method, including null fields (Umm al-Qura interval)', () => {
    const m = mergeSettings({ method: METHODS.ummAlQura });
    expect(m.method).toEqual(METHODS.ummAlQura);
    expect(m.method.ishaAngle).toBeNull();
  });
  it('ignores undefined values', () => {
    const m = mergeSettings({ madhab: undefined, dipForTwilight: true });
    expect(m.madhab).toBe('hanafi');
    expect(m.dipForTwilight).toBe(true);
  });
});
