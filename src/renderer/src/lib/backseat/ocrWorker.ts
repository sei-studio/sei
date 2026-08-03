/**
 * Backseat OCR fallback worker (260802, demoted 260803).
 *
 * tesseract.js, used wherever the native path cannot run: Windows, Linux, and
 * any macOS where the bundled Vision helper is missing. On macOS the helper
 * wins by a distance (whole phrases instead of fragments, ~100 ms against
 * ~1000 ms, no upscale pass), so this is now the floor rather than the plan.
 * See src/main/backseat/visionOcr.ts for the measured comparison.
 *
 * Its own worker, not part of captureWorker, for one reason: Tesseract is
 * synchronous WASM and a recognition takes on the order of a second. Running it
 * next to the frame loop would stall the ring buffer for that whole second and
 * put every grid cell off its offset, which is the exact failure the log-spaced
 * grid was built to fix.
 *
 * Model delivery matches whisperWorker.ts: the core and the English traineddata
 * are fetched on first use and cached by the browser, so there is nothing new
 * to bundle and nothing to download for a player who never shares a screen.
 *
 * Protocol (postMessage):
 *   in:  { type: 'frame', jpeg, at }  -> { type: 'lines', at, lines, ms }
 *                                        { type: 'error', at, message }
 *   in:  { type: 'stop' }
 *
 * One frame at a time by construction: the caller waits for a result before
 * sending another. A queue would only ever hold pictures of a screen that has
 * already moved on.
 *
 * 260803: this reports LINES rather than words, so both engines feed the same
 * shaping. Tesseract already has the line structure; it was being discarded.
 */

import { createWorker, PSM, type Worker as TessWorker } from 'tesseract.js';

import { SCREEN_TEXT_SCALE, type OcrLine } from '../../../../shared/backseatIpc';

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
 * stays at capture resolution. Vision needs none of this.
 */
async function scaled(jpeg: ArrayBuffer): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  try {
    const w = Math.round(bitmap.width * SCREEN_TEXT_SCALE);
    const h = Math.round(bitmap.height * SCREEN_TEXT_SCALE);
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d', { alpha: false });
    }
    ctx!.imageSmoothingQuality = 'high';
    ctx!.drawImage(bitmap, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

async function read(jpeg: ArrayBuffer, at: number): Promise<void> {
  const started = Date.now();
  const png = await scaled(jpeg);
  const w = await engine();
  const { data } = await w.recognize(png, {}, { blocks: true, text: false });
  const lines: OcrLine[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        const text = l.text.trim();
        if (!text) continue;
        // Tesseract scores every word; the line's own confidence field is not
        // comparable across engines, so take the mean of the words the way a
        // per-line engine would report it.
        const words = l.words ?? [];
        const confidence = words.length
          ? words.reduce((a, x) => a + x.confidence, 0) / words.length
          : 0;
        lines.push({ text, confidence });
      }
    }
  }
  self.postMessage({ type: 'lines', at, lines, ms: Date.now() - started });
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as { type: 'frame'; jpeg: ArrayBuffer; at: number } | { type: 'stop' };
  if (msg.type === 'frame') {
    try {
      await read(msg.jpeg, msg.at);
    } catch (err) {
      // Never leave the caller waiting: it single-flights on the reply, so a
      // swallowed error would stop every later frame from being read.
      self.postMessage({
        type: 'error',
        at: msg.at,
        message: (err as Error)?.message ?? 'ocr failed',
      });
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
