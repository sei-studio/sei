/**
 * SeiLink room image loading (261104). One cache per renderer, keyed by URL
 * (pack URLs carry ?v=<rev>, so a pack update is a new key).
 *
 *  - frames load as ImageBitmaps;
 *  - masks are converted once to an alpha mask (alpha = luminance x alpha,
 *    the same weight the AI side's look() composite uses), so a mask painted
 *    white-on-black and one painted white-on-transparent both work;
 *  - glows are trimmed to their visible bounds once, so the per-frame glow
 *    redraw touches only the lit pixels, not a full-canvas layer.
 */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): AnyCanvas {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  return c;
}

export function ctx2d(c: AnyCanvas, opts?: CanvasRenderingContext2DSettings): AnyContext2D {
  const ctx = c.getContext('2d', opts) as AnyContext2D | null;
  if (!ctx) throw new Error('2d canvas unavailable');
  return ctx;
}

/** A glow trimmed to its lit bounds. (x, y, w, h) are in the source image's px; (fw, fh) its full size. */
export interface TrimmedGlow {
  bitmap: ImageBitmap | null;
  x: number;
  y: number;
  w: number;
  h: number;
  fw: number;
  fh: number;
}

const MAX_ENTRIES = 160;
const cache = new Map<string, Promise<unknown>>();

function remember<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = make();
  cache.set(key, p);
  // A failed load is not cached: the next draw retries (a pack being written).
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  return p;
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

export function loadRoomImage(url: string): Promise<ImageBitmap> {
  return remember(`img:${url}`, () => fetchBitmap(url));
}

export function loadRoomMask(url: string): Promise<ImageBitmap> {
  return remember(`mask:${url}`, async () => {
    const src = await loadRoomImage(url);
    const c = makeCanvas(src.width, src.height);
    const ctx = ctx2d(c, { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = ((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * d[i + 3]) / 255;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return createImageBitmap(c);
  });
}

export function loadRoomGlow(url: string): Promise<TrimmedGlow> {
  return remember(`glow:${url}`, async () => {
    const src = await loadRoomImage(url);
    const c = makeCanvas(src.width, src.height);
    const ctx = ctx2d(c, { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = row + x * 4;
        // Screen-blended: a pixel only lights the scene when it has colour AND alpha.
        if (data[i + 3] > 1 && data[i] + data[i + 1] + data[i + 2] > 3) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return { bitmap: null, x: 0, y: 0, w: 0, h: 0, fw: width, fh: height };
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const bitmap = await createImageBitmap(src, x0, y0, w, h);
    return { bitmap, x: x0, y: y0, w, h, fw: width, fh: height };
  });
}

/** Drop every cached image (the dev preview's reload; a pack swap). */
export function clearRoomImageCache(): void {
  cache.clear();
}
