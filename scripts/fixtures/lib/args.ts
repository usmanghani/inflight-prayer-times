/** Tiny argv parser: `--key value`, `--key=value`, `--flag`. Positional args go to `_`. */
export interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export function str(a: Args, key: string): string | undefined {
  const v = a.flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(a: Args, key: string): number | undefined {
  const v = str(a, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} expects a number, got "${v}"`);
  return n;
}

export function has(a: Args, key: string): boolean {
  return a.flags[key] !== undefined;
}
