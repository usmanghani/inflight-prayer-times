/**
 * Optional online backend (see docs/BACKEND.md). The app works fully without it.
 *
 * Resolution order: localStorage override (`ipt.apiBase`) > build-time `VITE_API_BASE`.
 * The value is the backend ORIGIN, e.g. "https://inflight-prayer-api.example.workers.dev".
 */
export const API_BASE_STORAGE_KEY = 'ipt.apiBase';

function normalize(url: string | null | undefined): string | null {
  const v = (url ?? '').trim().replace(/\/+$/, '');
  return v ? v : null;
}

/** Test hook: bundlers inline/copy import.meta.env per module, so tests inject the env value here. */
let envBaseOverride: string | null | undefined;
export function __setEnvApiBaseForTests(v: string | null | undefined): void {
  envBaseOverride = v;
}

export function getApiBase(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const o = normalize(localStorage.getItem(API_BASE_STORAGE_KEY));
      if (o) return o;
    }
  } catch {
    /* storage unavailable */
  }
  if (envBaseOverride !== undefined) return normalize(envBaseOverride);
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return normalize(env?.VITE_API_BASE);
  } catch {
    return null;
  }
}

/** Set (or clear with null/empty) the runtime override. Returns false if storage is unavailable. */
export function setApiBase(url: string | null): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const v = normalize(url);
    if (v) localStorage.setItem(API_BASE_STORAGE_KEY, v);
    else localStorage.removeItem(API_BASE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
