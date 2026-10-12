/** localStorage persistence and URL-hash sharing. Every storage access is wrapped in try/catch. */
import { defaultAppSettings, isLegacyDefault, sanitizeAppSettings, sanitizeDrafts, type AppSettings, type LegDraft } from './model';

export const SETTINGS_KEY = 'ipt.ui.settings.v2';
/** v1 stored pre-profile settings (old defaults: Maghrib +0, angle-based). Migrated on load. */
export const LEGACY_SETTINGS_KEY = 'ipt.ui.settings.v1';
export const ITINERARY_KEY = 'ipt.ui.itinerary.v1';

export function storageGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadSettings(): AppSettings {
  const raw = parseJson(storageGet(SETTINGS_KEY));
  if (raw) return sanitizeAppSettings(raw);
  // v1 (before profiles): untouched old defaults upgrade to the Barelvi default; customised settings are kept as 'custom'.
  const legacy = parseJson(storageGet(LEGACY_SETTINGS_KEY));
  if (legacy && !isLegacyDefault(legacy)) {
    const kept = sanitizeAppSettings(legacy);
    // tz choices / step from the legacy blob are kept by sanitizeAppSettings
    return kept;
  }
  if (legacy) {
    const base = defaultAppSettings();
    const old = sanitizeAppSettings(legacy);
    base.tzChoices = old.tzChoices;
    base.stepMinutes = old.stepMinutes;
    return base;
  }
  return defaultAppSettings();
}

export function saveSettings(s: AppSettings): void {
  storageSet(SETTINGS_KEY, JSON.stringify(s));
}

/** Tracks are large and are not persisted; only the typed fields are. */
function plainDrafts(legs: LegDraft[]): unknown[] {
  return legs.map((l) => ({
    flightNumber: l.flightNumber,
    from: l.from,
    to: l.to,
    depLocal: l.depLocal,
    arrLocal: l.arrLocal,
    cruiseFt: l.cruiseFt,
  }));
}

export function loadItinerary(): LegDraft[] {
  return sanitizeDrafts(parseJson(storageGet(ITINERARY_KEY)));
}

export function saveItinerary(legs: LegDraft[]): void {
  storageSet(ITINERARY_KEY, JSON.stringify(plainDrafts(legs)));
}

// ───────────────────────────── URL hash ─────────────────────────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface SharedState {
  legs: LegDraft[];
  settings: AppSettings;
}

/** `#s=<base64url JSON>`: itinerary (without tracks) + settings. */
export function encodeShareHash(legs: LegDraft[], settings: AppSettings): string {
  const payload = { v: 1, legs: plainDrafts(legs), settings };
  return `#s=${toBase64Url(JSON.stringify(payload))}`;
}

export function decodeShareHash(hash: string): SharedState | null {
  try {
    const m = /^#?s=([A-Za-z0-9_-]+)$/.exec((hash ?? '').trim());
    if (!m) return null;
    const obj = JSON.parse(fromBase64Url(m[1])) as { v?: number; legs?: unknown; settings?: unknown };
    if (!obj || typeof obj !== 'object' || obj.v !== 1) return null;
    const legs = sanitizeDrafts(obj.legs);
    if (legs.length === 0) return null;
    return { legs, settings: sanitizeAppSettings(obj.settings) };
  } catch {
    return null;
  }
}

export function shareUrl(legs: LegDraft[], settings: AppSettings): string {
  const base = typeof location !== 'undefined' ? location.href.split('#')[0] : '';
  return base + encodeShareHash(legs, settings);
}
