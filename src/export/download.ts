/** Save text to a file via Blob + anchor click. */

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 80) || 'download';
}

export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(filename);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): boolean {
  return downloadBlob(new Blob([text], { type: mime }), filename);
}
