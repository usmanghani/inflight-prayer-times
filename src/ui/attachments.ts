/**
 * Pure model of the "attachments tray" (several itinerary photos / PDFs): validation, limits,
 * de-duplication and ordering. No DOM here, so it is easy to test.
 */

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = 'image' | 'pdf';

export interface Attachment {
  id: string;
  file: File;
  kind: AttachmentKind;
}

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** The MIME type to use for a file: its own, or one inferred from the extension when the OS left it empty. */
export function mimeOf(f: { type: string; name: string }): string {
  if (f.type) return f.type.toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase();
  return (ext && EXT_TYPES[ext]) || '';
}

export function fileKind(f: { type: string; name: string }): AttachmentKind | null {
  const t = mimeOf(f);
  if (t === 'application/pdf') return 'pdf';
  return IMAGE_MIME.has(t) ? 'image' : null;
}

/** Two files are the same attachment when name, size and last-modified time are identical. */
export const fileKey = (f: File): string => `${f.name}|${f.size}|${f.lastModified}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const totalBytes = (list: Attachment[]): number => list.reduce((n, a) => n + a.file.size, 0);

let counter = 0;
const nextId = (): string => `att-${++counter}`;

export interface AddResult {
  next: Attachment[];
  added: Attachment[];
  /** Friendly, plain-text reasons for everything that was not added. */
  messages: string[];
}

const q = (name: string): string => `“${name.length > 60 ? `${name.slice(0, 57)}…` : name}”`;

/**
 * Add files to the tray, in the order given. Rules: supported type (JPG, PNG, WebP, GIF, PDF), not a
 * duplicate (name + size + last-modified), <= 10 MB each, <= 10 files and <= 25 MB in total.
 */
export function addFiles(current: Attachment[], incoming: File[]): AddResult {
  const next = current.slice();
  const added: Attachment[] = [];
  const messages: string[] = [];
  const seen = new Set(current.map((a) => fileKey(a.file)));
  let total = totalBytes(current);
  const overflow: string[] = [];

  for (const original of incoming) {
    const kind = fileKind(original);
    if (!kind) {
      const heic = /heic|heif/i.test(original.type) || /\.(heic|heif)$/i.test(original.name);
      messages.push(
        heic
          ? `${q(original.name)} is a HEIC photo, which browsers cannot read. Take a screenshot instead, or export it as JPG.`
          : `${q(original.name)} is not a supported file type. Use a JPG, PNG, WebP or GIF image, or a PDF.`,
      );
      continue;
    }
    const key = fileKey(original);
    if (seen.has(key)) {
      messages.push(`${q(original.name)} is already attached, so it was skipped.`);
      continue;
    }
    if (original.size > MAX_FILE_BYTES) {
      messages.push(`${q(original.name)} is ${formatBytes(original.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file.`);
      continue;
    }
    if (next.length >= MAX_FILES) {
      overflow.push(original.name);
      continue;
    }
    if (total + original.size > MAX_TOTAL_BYTES) {
      messages.push(`${q(original.name)} would take the total over ${formatBytes(MAX_TOTAL_BYTES)}, so it was not added. Remove a file first.`);
      continue;
    }
    // Give files whose MIME type is empty (some drag-and-drop sources) the type inferred from the extension.
    const file =
      original.type === '' ? new File([original], original.name, { type: mimeOf(original), lastModified: original.lastModified }) : original;
    const att: Attachment = { id: nextId(), file, kind };
    seen.add(key);
    total += file.size;
    next.push(att);
    added.push(att);
  }
  if (overflow.length) {
    const first = q(overflow[0]!);
    messages.push(
      `You can attach up to ${MAX_FILES} files. ${overflow.length === 1 ? `${first} was not added.` : `${first} and ${overflow.length - 1} more were not added.`}`,
    );
  }
  return { next, added, messages };
}

/** Move the item at `index` by `delta` positions (clamped); returns a new array. */
export function moveAttachment(list: Attachment[], index: number, delta: number): Attachment[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || to === index) return list;
  const out = list.slice();
  const [item] = out.splice(index, 1);
  out.splice(to, 0, item!);
  return out;
}
