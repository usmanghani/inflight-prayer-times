/** Parse many upstream timestamp spellings into an ISO-8601 UTC string, or undefined. */
export function toIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof v !== 'string' || !v) return undefined;
  // AeroDataBox: "2026-10-12 22:25Z"
  let s = v.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(s)) s = s.replace(/T(\d{2}:\d{2})(Z|[+-])/, 'T$1:00$2');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function dayRangeUtc(date: string): { start: string; end: string } {
  const s = new Date(`${date}T00:00:00Z`);
  const e = new Date(s.getTime() + 86400_000);
  return { start: s.toISOString().replace('.000Z', 'Z'), end: e.toISOString().replace('.000Z', 'Z') };
}
