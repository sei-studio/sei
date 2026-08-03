/**
 * Backseat OCR worker (260802) — reading the words off the shared screen.
 *
 * Its own worker, not part of captureWorker, for one reason: Tesseract is
 * synchronous WASM and a recognition takes on the order of a second. Running it
 * next to the frame loop would stall the ring buffer for that whole second and
 * put every grid cell off its offset, which is the exact failure the log-spaced
 * grid was built to fix.
 *
 * Model delivery matches whisperWorker.ts: the core and the English traineddata
 * are fetched on first use and cached by the browser, so there is nothing new
 * to bundle and nothing to download for a player who never starts a backseat
 * session.
 *
 * Protocol (postMessage):
 *   in:  { type: 'frame', bitmap, at }  -> { type: 'text', at, text, ms }
 *                                          { type: 'error', message }
 *   in:  { type: 'stop' }
 *
 * One frame at a time by construction: the caller waits for a result before
 * sending another. A queue would only ever hold pictures of a screen that has
 * already moved on.
 */

import { createWorker, PSM, type Worker as TessWorker } from 'tesseract.js';

import { SCREEN_TEXT_SCALE, TICK_SCREEN_TEXT_MAX_WORDS } from '../../../../shared/backseatIpc';
import { shapeScreenText, type OcrWord } from './screenText';

let tess: TessWorker | null = null;
let loading: Promise<TessWorker> | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

async function engine(): Promise<TessWorker> {
  if (tess) return tess;
  if (!loading) {
    loading = (async () => {
      const w = await createWorker('eng');
      await w.setParameters({
        // SPARSE_TEXT, not the default page layout. A game screen is not a
        // page: no columns, no reading order, no paragraphs, just labels
        // scattered over a picture. Measured on the Valorant clip, the default
        // AUTO mode returned nothing at all on most frames while SPARSE_TEXT
        // recovered map callouts, the kill feed and the counters
        // (scripts/backseat-ocr.ts records the comparison).
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        // Without this the engine guesses a DPI from the image and lands
        // anywhere from 286 to 663 across frames of the same clip, which
        // changes how it segments identical text.
        user_defined_dpi: '300',
      });
      tess = w;
      return w;
    })();
  }
  return loading;
}

/**
 * Upscale before recognition. HUD text at 720p is around 12 px tall, well under
 * what Tesseract reads comfortably; 2x is where callouts and counters start
 * surviving. The upscale happens here rather than on the wire so the transfer
 * stays at capture resolution.
 */
function scaled(bitmap: ImageBitmap): OffscreenCanvas {
  const w = Math.round(bitmap.width * SCREEN_TEXT_SCALE);
  const h = Math.round(bitmap.height * SCREEN_TEXT_SCALE);
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { alpha: false });
  }
  ctx!.imageSmoothingQuality = 'high';
  ctx!.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

async function read(bitmap: ImageBitmap, at: number): Promise<void> {
  const started = Date.now();
  let blob: Blob;
  try {
    blob = await scaled(bitmap).convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
  const w = await engine();
  const { data } = await w.recognize(blob, {}, { blocks: true, text: false });
  const words: OcrWord[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        for (const word of l.words) words.push({ text: word.text, confidence: word.confidence });
      }
    }
  }
  self.postMessage({
    type: 'text',
    at,
    text: shapeScreenText(words, TICK_SCREEN_TEXT_MAX_WORDS),
    ms: Date.now() - started,
  });
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as { type: 'frame'; bitmap: ImageBitmap; at: number } | { type: 'stop' };
  if (msg.type === 'frame') {
    try {
      await read(msg.bitmap, msg.at);
    } catch (err) {
      // Never leave the caller waiting: it single-flights on the reply, so a
      // swallowed error would stop every later frame from being read.
      self.postMessage({ type: 'error', at: msg.at, message: (err as Error)?.message ?? 'ocr failed' });
    }
    return;
  }
  if (msg.type === 'stop') {
    const w = tess;
    tess = null;
    loading = null;
    canvas = null;
    ctx = null;
    try {
      await w?.terminate();
    } catch {
      /* the thread is going away anyway */
    }
  }
};

export {};
