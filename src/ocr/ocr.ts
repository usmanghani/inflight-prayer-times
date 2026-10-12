/**
 * On-device OCR using Tesseract.js (WebAssembly), lazily loaded.
 *
 * Privacy: the image is decoded and recognised entirely inside the browser; it is
 * never uploaded anywhere. The only network traffic is tesseract.js fetching its
 * own assets (the English language data `eng.traineddata`, and the WASM core) from
 * a public CDN the first time OCR is used; those requests do not contain your image
 * or any itinerary data.
 */

export interface OcrProgress {
  status: string;
  progress: number; // 0..1
}

/** Progress of a batch: `index` is the 0-based image being read, `progress` is 0..1 for that image. */
export interface OcrBatchProgress {
  index: number;
  total: number;
  status: string;
  progress: number;
}

export interface OcrBatchResult {
  index: number;
  text: string;
  /** Set when this image failed; the rest of the batch is unaffected. */
  error?: string;
}

type ImageLike = File | Blob | string;

function abortError(): DOMException {
  return new DOMException('OCR was cancelled.', 'AbortError');
}

/**
 * Recognise several images in order with ONE reused Tesseract worker (the language data and WASM
 * core are loaded once). A failure on one image is reported in its result and does not stop the
 * batch. Aborting terminates the worker immediately and rejects with an `AbortError`.
 */
async function runBatch(
  images: ImageLike[],
  onProgress?: (p: OcrBatchProgress) => void,
  signal?: AbortSignal,
): Promise<OcrBatchResult[]> {
  if (signal?.aborted) throw abortError();
  if (images.length === 0) return [];
  const { createWorker } = await import('tesseract.js');
  if (signal?.aborted) throw abortError();

  let current = 0;
  const total = images.length;
  const worker = await createWorker('eng', 1, {
    logger: (m: { status?: string; progress?: number }) => {
      if (onProgress) onProgress({ index: current, total, status: String(m.status ?? ''), progress: Number(m.progress ?? 0) });
    },
  });

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    void worker.terminate().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const results: OcrBatchResult[] = [];
  try {
    for (let i = 0; i < total; i++) {
      if (aborted) throw abortError();
      current = i;
      onProgress?.({ index: i, total, status: 'starting', progress: 0 });
      try {
        const r = await worker.recognize(images[i]!);
        results.push({ index: i, text: r.data.text ?? '' });
      } catch (e) {
        if (aborted) throw abortError();
        results.push({ index: i, text: '', error: e instanceof Error && e.message ? e.message : 'The image could not be read.' });
      }
      onProgress?.({ index: i, total, status: 'done', progress: 1 });
    }
    if (aborted) throw abortError();
    return results;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!aborted) await worker.terminate().catch(() => undefined);
  }
}

export function recognizeImages(
  images: (File | Blob)[],
  onProgress?: (p: OcrBatchProgress) => void,
  signal?: AbortSignal,
): Promise<OcrBatchResult[]> {
  return runBatch(images, onProgress, signal);
}

/** Single image (kept for callers that only have one). Rejects if the image cannot be read. */
export async function recognizeImage(
  image: File | Blob | string,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const [r] = await runBatch([image], onProgress ? (p) => onProgress({ status: p.status, progress: p.progress }) : undefined);
  if (!r) return '';
  if (r.error) throw new Error(r.error);
  return r.text;
}
