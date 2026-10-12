/**
 * Minimal ambient declarations for the Node built-ins used by the fixture tooling.
 * The repo has no @types/node; if it is ever added to devDependencies, delete this file.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { size: number; mtimeMs: number };
  export function renameSync(from: string, to: string): void;
}
declare module 'node:path' {
  export function join(...p: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...p: string[]): string;
  export function basename(p: string, ext?: string): string;
}
declare module 'node:crypto' {
  export function createHash(alg: string): { update(s: string): { digest(enc: 'hex'): string } };
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  exitCode?: number;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  on(ev: string, fn: (...a: unknown[]) => void): void;
};
