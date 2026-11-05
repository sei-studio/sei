/**
 * Portrait cut-out for the SeiLink room (261104): a character portrait is a
 * rectangle with a background, and she must sit in the room as a figure,
 * never a card. Two ways out, tried in order:
 *
 *  1. Key the background: when the top and side borders are one flat colour
 *     (Sui's portrait: a near-white card), flood it from those borders. Only
 *     background REACHABLE from the edge goes, so a white dress inside her
 *     outline stays. Edge pixels get partial alpha from their distance to
 *     the key colour and the key is unmixed from their colour, so no halo.
 *     The bottom border is not sampled: a bust is cut there.
 *  2. Otherwise (a painted scene behind her, Lyra and Marv): a soft
 *     head-and-shoulders vignette, so the room shows round her instead of a
 *     hard rectangle, cut further by `edgeMatte` (261105): backdrop that
 *     runs down from the top edge in one colour goes, so the oval does not
 *     leave a band of it over her hair. A real matte needs a
 *     segmentation pass this client does not have.
 *
 * `keyAlpha` is pure (RGBA in, alpha out) and tested; `vignetteAlpha` is a
 * pure shape; `buildCutout` / `loadCutout` do the canvas work in the renderer.
 */

export interface KeyOptions {
  /** Colour distance (RGB, 0..441) under which a pixel counts as background. */
  tolerance: number;
  /** Fraction of sampled border pixels that must match the key. */
  borderMatch: number;
  /** Kept foreground must be within this fraction range of the image. */
  minFg: number;
  maxFg: number;
}

export const DEFAULT_KEY: KeyOptions = { tolerance: 34, borderMatch: 0.82, minFg: 0.08, maxFg: 0.94 };

export interface KeyResult {
  alpha: Uint8ClampedArray;
  key: [number, number, number];
  /** Fraction of the image kept. */
  fg: number;
}

const dist = (d: Uint8ClampedArray, i: number, k: readonly number[]): number => {
  const r = d[i] - k[0];
  const g = d[i + 1] - k[1];
  const b = d[i + 2] - k[2];
  return Math.sqrt(r * r + g * g + b * b);
};

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

/**
 * Background key by edge flood. Returns null when the border is not one flat
 * colour or the result is implausible (nothing kept, or nothing removed).
 * Already-transparent pixels count as background.
 */
export function keyAlpha(data: Uint8ClampedArray, w: number, h: number, opts: Partial<KeyOptions> = {}): KeyResult | null {
  const o = { ...DEFAULT_KEY, ...opts };
  if (w < 8 || h < 8 || data.length < w * h * 4) return null;

  // Border sample: top row and both sides, opaque pixels only.
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x);
  for (let y = 1; y < h; y++) border.push(y * w, y * w + w - 1);
  const opaque = border.filter((p) => data[p * 4 + 3] >= 200);
  const transparent = border.length - opaque.length;
  let key: [number, number, number] = [0, 0, 0];
  if (opaque.length > 0) {
    key = [median(opaque.map((p) => data[p * 4])), median(opaque.map((p) => data[p * 4 + 1])), median(opaque.map((p) => data[p * 4 + 2]))];
    const match = opaque.filter((p) => dist(data, p * 4, key) < o.tolerance).length + transparent;
    if (match / border.length < o.borderMatch) return null;
  }

  // Flood from the matching border pixels (4-connected).
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const isBg = (p: number): boolean => data[p * 4 + 3] < 24 || dist(data, p * 4, key) < o.tolerance;
  for (const p of border) {
    if (!bg[p] && isBg(p)) {
      bg[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0 && !bg[p - 1] && isBg(p - 1)) (bg[p - 1] = 1), (queue[tail++] = p - 1);
    if (x < w - 1 && !bg[p + 1] && isBg(p + 1)) (bg[p + 1] = 1), (queue[tail++] = p + 1);
    if (y > 0 && !bg[p - w] && isBg(p - w)) (bg[p - w] = 1), (queue[tail++] = p - w);
    if (y < h - 1 && !bg[p + w] && isBg(p + w)) (bg[p + w] = 1), (queue[tail++] = p + w);
  }

  const alpha = new Uint8ClampedArray(w * h);
  let kept = 0;
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) continue;
    const a0 = data[p * 4 + 3];
    // Foreground next to the flood: soft edge from its distance to the key.
    const x = p % w;
    const edge = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (p >= w && bg[p - w]) || (p < w * (h - 1) && bg[p + w]);
    let a = 255;
    if (edge) {
      // An antialiased rim pixel is a mix of her colour and the key: its
      // coverage is how far it sits from the key relative to the most
      // keyed-away neighbour inside her.
      const d = dist(data, p * 4, key);
      const y = (p - x) / w;
      let dmax = d;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!bg[q]) dmax = Math.max(dmax, dist(data, q * 4, key));
        }
      }
      const floor = o.tolerance * 0.5;
      const t = dmax > floor ? (d - floor) / (dmax - floor) : 1;
      a = Math.round(255 * Math.min(1, Math.max(0.12, t)));
    }
    alpha[p] = Math.min(a, a0);
    kept += alpha[p] / 255;
  }
  const fg = kept / (w * h);
  if (fg < o.minFg || fg > o.maxFg) return null;
  return { alpha, key, fg };
}

/**
 * Unmix the key colour from soft edge pixels (c = a * fg + (1 - a) * key),
 * in place, so a white card leaves no white rim on a dark room.
 */
export function unmixKey(data: Uint8ClampedArray, alpha: Uint8ClampedArray, key: readonly number[]): void {
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] / 255;
    const i = p * 4;
    if (a <= 0) {
      data[i + 3] = 0;
      continue;
    }
    if (a < 1) {
      for (let c = 0; c < 3; c++) data[i + c] = Math.round((data[i + c] - (1 - a) * key[c]) / a);
    }
    data[i + 3] = Math.min(data[i + 3], alpha[p]);
  }
}

/**
 * Soft head-and-shoulders vignette (alpha 0..1) at (x, y) in a w x h
 * portrait: an oval round the head joined to a wide shoulder mound that runs
 * off the bottom, both feathered.
 */
export function vignetteAlpha(x: number, y: number, w: number, h: number): number {
  const u = x / w - 0.5;
  const v = y / h;
  const feather = 0.09;
  const smooth = (d: number): number => {
    // d < 0 inside the shape, > 0 outside (in shape units).
    const t = Math.min(1, Math.max(0, 0.5 - d / feather));
    return t * t * (3 - 2 * t);
  };
  // Head oval, centred a bit above the middle.
  const head = Math.sqrt((u / 0.34) ** 2 + ((v - 0.42) / 0.44) ** 2) - 1;
  // Shoulders: a wide ellipse whose top sits below the chin.
  const shoulders = Math.sqrt((u / 0.52) ** 2 + ((v - 1.08) / 0.5) ** 2) - 1;
  // The top edge fades out: a portrait's background shows most between the ears and above the hair.
  const top = Math.min(1, Math.max(0, (v - 0.015) / 0.085));
  return Math.max(smooth(head), smooth(shoulders)) * top * top * (3 - 2 * top);
}

export interface EdgeMatteOptions {
  /** Colour distance (RGB) from the running backdrop colour that ends a scan. */
  tolerance: number;
  /** Consecutive pixels past the tolerance that count as her edge (not texture). */
  run: number;
  /** One pixel this far (x tolerance) from the backdrop is her edge on its own (a line-art outline). */
  strong: number;
  /** How far down a column scan may go (fraction of the height). */
  maxTop: number;
  /** Dropped when the scan reaches this deep over the middle (her hair is the backdrop's colour). */
  centreLimit: number;
  /**
   * Dropped when the traced edge is ragged: the mean |second difference| of
   * the trace (px per column) where the cut shows. A hair or helmet outline
   * bends smoothly (Lyra about 0.4 at 900 px, 0.5 at 450); a busy backdrop
   * stops the scans at its own shapes and would leave blocks of it (Marv
   * about 2).
   */
  maxRoughness: number;
}

export const DEFAULT_EDGE_MATTE: EdgeMatteOptions = { tolerance: 32, run: 2, strong: 1.8, maxTop: 0.4, centreLimit: 0.24, maxRoughness: 1 };

/** Min filter of a trace (window 2r+1): the shallower neighbour wins, so a scan that ran into her hair is pulled back. */
function minTrace(t: Float32Array, r: number): Float32Array {
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    let m = t[i];
    for (let j = Math.max(0, i - r); j <= Math.min(t.length - 1, i + r); j++) m = Math.min(m, t[j]);
    out[i] = m;
  }
  return out;
}

/** Median filter of a trace (window 2r+1). */
function medianTrace(t: Float32Array, r: number): Float32Array {
  const out = new Float32Array(t.length);
  const win: number[] = [];
  for (let i = 0; i < t.length; i++) {
    win.length = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(t.length - 1, i + r); j++) win.push(t[j]);
    out[i] = median(win);
  }
  return out;
}

/**
 * Per column, how far the backdrop runs down from the top edge: the first
 * pixel that leaves the running backdrop colour (`run` in a row, or one
 * `strong` one such as a line-art outline). The running colour follows a
 * slow gradient (a lit wall, a sky).
 */
export function topTrace(data: Uint8ClampedArray, w: number, h: number, opts: Partial<EdgeMatteOptions> = {}): Float32Array {
  const o = { ...DEFAULT_EDGE_MATTE, ...opts };
  const maxY = Math.round(h * o.maxTop);
  const seed = Math.max(2, Math.round(h * 0.01));
  const depth = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const bg = [0, 0, 0];
    for (let y = 0; y < seed; y++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) bg[c] += data[i + c] / seed;
    }
    let out = 0;
    let stop = maxY;
    for (let y = 0; y < maxY; y++) {
      const i = (y * w + x) * 4;
      const d = data[i + 3] < 24 ? 0 : dist(data, i, bg);
      if (d >= o.tolerance * o.strong) {
        stop = y;
        break;
      }
      if (d < o.tolerance) {
        out = 0;
        for (let c = 0; c < 3; c++) bg[c] += (data[i + c] - bg[c]) * 0.08;
      } else if (++out >= o.run) {
        stop = y - o.run + 1;
        break;
      }
    }
    depth[x] = stop;
  }
  // A median (texture, single strands), then a min: never deeper than a neighbour, so a scan
  // that slipped into hair of the backdrop's colour is pulled back to its neighbours' depth.
  return minTrace(medianTrace(depth, Math.max(2, Math.round(w * 0.01))), Math.max(2, Math.round(w * 0.015)));
}

/**
 * Top matte for a portrait with a painted backdrop (261105, T332): the
 * backdrop that runs down from the top edge in one slowly changing colour,
 * as an alpha multiplier (0 = backdrop), or null when there is none or the
 * cut would not be clean.
 *
 * Why: the vignette's head oval is a fixed shape, so the backdrop between
 * it and her hair stayed: Lyra's dark ceiling read as a dark band across
 * the top of her head. Only backdrop that touches the top edge and matches
 * it goes, so a figure that runs off the top keeps everything. Dropped
 * (the vignette alone, as before) when the scan runs deep over the middle
 * (her hair is the backdrop's colour) or the traced edge is ragged (a busy
 * backdrop, Marv's).
 */
export function edgeMatte(data: Uint8ClampedArray, w: number, h: number, opts: Partial<EdgeMatteOptions> = {}): Float32Array | null {
  const o = { ...DEFAULT_EDGE_MATTE, ...opts };
  if (w < 16 || h < 16 || data.length < w * h * 4) return null;
  const top = topTrace(data, w, h, o);
  const mid: number[] = [];
  for (let x = Math.round(w * 0.4); x <= Math.round(w * 0.6); x++) mid.push(top[x]);
  if (median(mid) > h * o.centreLimit) return null;
  // Roughness where the cut shows (the vignette keeps something there).
  let bend = 0;
  let seen = 0;
  for (let x = 1; x < w - 1; x++) {
    if (vignetteAlpha(x, top[x], w, h) < 0.05) continue;
    bend += Math.abs(top[x + 1] - 2 * top[x] + top[x - 1]);
    seen++;
  }
  if (seen === 0 || bend / seen > o.maxRoughness) return null;
  const feather = Math.max(2, Math.round(Math.max(w, h) * 0.006));
  const m = new Float32Array(w * h);
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance past the edge into her, feathered over a few px.
      const t = Math.min(1, Math.max(0, (y - top[x] + 1) / feather));
      const a = t * t * (3 - 2 * t);
      m[y * w + x] = a;
      removed += 1 - a;
    }
  }
  return removed > 0 ? m : null;
}

export interface Cutout {
  canvas: HTMLCanvasElement;
  method: 'key' | 'vignette';
}

/** A finished cut-out as an image URL, for any number of <img> at once. */
export interface CutoutImage {
  src: string;
  /** width / height. */
  aspect: number;
  method: Cutout['method'];
}

const cache = new Map<string, Promise<CutoutImage | null>>();
const done = new Map<string, CutoutImage>();

/** A cutout that has already finished loading, or null. Lets a remount draw on its first frame. */
export function peekCutout(url: string): CutoutImage | null {
  return done.get(url) ?? null;
}

/** Load a portrait and cut it out, as an object URL (cached per portrait URL). Null when it cannot load. */
export function loadCutout(url: string): Promise<CutoutImage | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const job = buildCutout(url).then(async (c) => {
    if (!c) return null;
    const blob = await new Promise<Blob | null>((res) => c.canvas.toBlob(res, 'image/png'));
    if (!blob) return null;
    return { src: URL.createObjectURL(blob), aspect: c.canvas.width / Math.max(1, c.canvas.height), method: c.method };
  });
  cache.set(url, job);
  void job.then((r) => {
    if (!r) cache.delete(url);
    else done.set(url, r);
  });
  return job;
}

/** Load a portrait and cut it out. Null when it cannot load. */
export async function buildCutout(url: string, maxSide = 900): Promise<Cutout | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let frame: ImageData;
  try {
    frame = ctx.getImageData(0, 0, w, h);
  } catch {
    // A tainted canvas (no CORS): the vignette needs no readback.
    return vignetteCanvas(canvas, ctx, w, h, null);
  }
  const keyed = keyAlpha(frame.data, w, h);
  if (keyed) {
    unmixKey(frame.data, keyed.alpha, keyed.key);
    ctx.putImageData(frame, 0, 0);
    return { canvas: trimToFigure(canvas, frame.data, w, h), method: 'key' };
  }
  return vignetteCanvas(canvas, ctx, w, h, frame);
}

function vignetteCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number, frame: ImageData | null): Cutout {
  if (frame) {
    const d = frame.data;
    const edge = edgeMatte(d, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        d[p * 4 + 3] = Math.round(d[p * 4 + 3] * vignetteAlpha(x, y, w, h) * (edge ? edge[p] : 1));
      }
    }
    ctx.putImageData(frame, 0, 0);
  } else {
    // No readback: mask with a drawn alpha image instead.
    const mask = new ImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask.data[(y * w + x) * 4 + 3] = Math.round(255 * vignetteAlpha(x, y, w, h));
    const m = document.createElement('canvas');
    m.width = w;
    m.height = h;
    m.getContext('2d')?.putImageData(mask, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(m, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }
  return { canvas, method: 'vignette' };
}

/** Crop the transparent margin round her, so her lowest pixel sits on the floor line. */
function trimToFigure(canvas: HTMLCanvasElement, d: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return canvas;
  const pad = Math.round(w * 0.01);
  x0 = Math.max(0, x0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y0 = Math.max(0, y0 - pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
