import { beforeEach, describe, expect, it, vi } from 'vitest';

type Logger = (m: { status?: string; progress?: number }) => void;

const state = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
  logger: undefined as undefined | ((m: { status?: string; progress?: number }) => void),
}));

vi.mock('tesseract.js', () => ({ createWorker: state.createWorker }));

import { recognizeImage, recognizeImages, type OcrBatchProgress } from '../src/ocr/ocr';

const img = (name: string): File => new File([name], name, { type: 'image/png' });

beforeEach(() => {
  state.createWorker.mockReset();
  state.recognize.mockReset();
  state.terminate.mockReset();
  state.terminate.mockResolvedValue(undefined);
  state.createWorker.mockImplementation(async (_lang: string, _n: number, opts: { logger: Logger }) => {
    state.logger = opts.logger;
    return { recognize: state.recognize, terminate: state.terminate };
  });
  state.recognize.mockImplementation(async (f: File) => {
    state.logger?.({ status: 'recognizing text', progress: 0.5 });
    return { data: { text: `text of ${f.name}` } };
  });
});

describe('recognizeImages', () => {
  it('reads every image in order with ONE worker and terminates it', async () => {
    const out = await recognizeImages([img('a.png'), img('b.png'), img('c.png')]);
    expect(out).toEqual([
      { index: 0, text: 'text of a.png' },
      { index: 1, text: 'text of b.png' },
      { index: 2, text: 'text of c.png' },
    ]);
    expect(state.createWorker).toHaveBeenCalledTimes(1);
    expect(state.createWorker.mock.calls[0]![0]).toBe('eng');
    expect(state.recognize.mock.calls.map((c) => (c[0] as File).name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(state.terminate).toHaveBeenCalledTimes(1);
  });

  it('reports progress with the index of the image being read', async () => {
    const seen: OcrBatchProgress[] = [];
    await recognizeImages([img('a.png'), img('b.png')], (p) => seen.push(p));
    const mid = seen.filter((p) => p.status === 'recognizing text');
    expect(mid.map((p) => [p.index, p.total, p.progress])).toEqual([[0, 2, 0.5], [1, 2, 0.5]]);
    expect(seen[seen.length - 1]).toMatchObject({ index: 1, total: 2, progress: 1 });
  });

  it('a failure on one image does not abort the batch', async () => {
    state.recognize.mockImplementation(async (f: File) => {
      if (f.name === 'bad.png') throw new Error('Could not decode image');
      return { data: { text: `ok ${f.name}` } };
    });
    const out = await recognizeImages([img('a.png'), img('bad.png'), img('c.png')]);
    expect(out).toEqual([
      { index: 0, text: 'ok a.png' },
      { index: 1, text: '', error: 'Could not decode image' },
      { index: 2, text: 'ok c.png' },
    ]);
    expect(state.createWorker).toHaveBeenCalledTimes(1);
    expect(state.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns [] without loading the engine for an empty list', async () => {
    expect(await recognizeImages([])).toEqual([]);
    expect(state.createWorker).not.toHaveBeenCalled();
  });

  it('rejects with AbortError without starting when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(recognizeImages([img('a.png')], undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.createWorker).not.toHaveBeenCalled();
  });

  it('aborting mid-batch terminates the worker and rejects with AbortError', async () => {
    const ac = new AbortController();
    state.recognize.mockImplementation(async (f: File) => {
      if (f.name === 'a.png') {
        ac.abort(); // the user presses Cancel while photo 1 is being read
        return { data: { text: 'late' } };
      }
      return { data: { text: 'never' } };
    });
    await expect(recognizeImages([img('a.png'), img('b.png')], undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.terminate).toHaveBeenCalledTimes(1);
    expect(state.recognize).toHaveBeenCalledTimes(1);
  });
});

describe('recognizeImage (single)', () => {
  it('returns the text and shares the batch code path', async () => {
    const seen: number[] = [];
    expect(await recognizeImage(img('one.png'), (p) => seen.push(p.progress))).toBe('text of one.png');
    expect(seen).toContain(0.5);
    expect(state.createWorker).toHaveBeenCalledTimes(1);
    expect(state.terminate).toHaveBeenCalledTimes(1);
  });

  it('throws when the image cannot be read', async () => {
    state.recognize.mockRejectedValue(new Error('boom'));
    await expect(recognizeImage(img('x.png'))).rejects.toThrow('boom');
    expect(state.terminate).toHaveBeenCalledTimes(1);
  });
});
