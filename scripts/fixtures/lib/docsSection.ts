import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'REGRESSION.md');
export { join };

/** Replace the text between `<!-- NAME:START -->` and `<!-- NAME:END -->` in docs/REGRESSION.md (appends when absent). */
export function replaceDocSection(name: string, body: string, path = DOC_PATH): void {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  let doc = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a >= 0 && b > a) doc = doc.slice(0, a) + block + doc.slice(b + end.length);
  else doc = `${doc.trimEnd()}\n\n${block}\n`;
  writeFileSync(path, doc);
}
