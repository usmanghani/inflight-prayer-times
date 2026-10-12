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

export async function recognizeImage(
  image: File | Blob | string,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: (m: { status?: string; progress?: number }) => {
      if (onProgress) onProgress({ status: String(m.status ?? ''), progress: Number(m.progress ?? 0) });
    },
  });
  try {
    const result = await worker.recognize(image);
    return result.data.text ?? '';
  } finally {
    await worker.terminate();
  }
}
