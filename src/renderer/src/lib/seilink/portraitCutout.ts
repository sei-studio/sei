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
 *     leave a band of it over her hair. `silhouetteMatte` (261105, T335)
 *     widens the oval where her outline sticks out of it (Lyra's cat ears,
 *     a twin tail): rays from her head walk in from the backdrop and stop
 *     at her edge. It only adds where the edge matte runs and the outline
 *     is smooth, so a busy backdrop (Marv) keeps the plain oval. A real
 *     matte needs a segmentation pass this client does not have.
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

const dist = (d: ArrayLike<number>, i: number, k: ArrayLike<number>): number => {
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
  // A min after the median: never deeper than a neighbour, so a scan that slipped into hair
  // of the backdrop's colour is pulled back to its neighbours' depth.
  return minTrace(topDepth(data, w, h, opts), Math.max(2, Math.round(w * 0.015)));
}

/** `topTrace` before its min filter (only a median against texture and single strands). */
export function topDepth(data: Uint8ClampedArray, w: number, h: number, opts: Partial<EdgeMatteOptions> = {}): Float32Array {
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
  return medianTrace(depth, Math.max(2, Math.round(w * 0.01)));
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

/** Head oval of `vignetteAlpha` in picture fractions: centre and radii. */
const HEAD = { cx: 0.5, cy: 0.42, rx: 0.34, ry: 0.44 } as const;

export interface SilhouetteOptions {
  /** Colour distance from the running backdrop colour that ends a ray. */
  tolerance: number;
  /** Consecutive pixels past the tolerance that count as her edge. */
  run: number;
  /** One pixel this far (x tolerance) from the backdrop is her edge on its own. */
  strong: number;
  /** Outer end of the rays, in head radii (the oval is 1). */
  reach: number;
  /** Rays never stop inside this (head radii): the oval keeps that part anyway. */
  inner: number;
  /** Widest angle from straight up that gets a ray (degrees); lower down the shoulders take over. */
  maxAngle: number;
  /** Dropped when the traced outline is ragged (mean |second difference|, px per ray). */
  maxRoughness: number;
  /** How far past a stop (fraction of the long side) the backdrop may come back, making the stop a line of the backdrop. */
  skip: number;
  /** Pixels of backdrop colour in a row that count as it coming back. */
  back: number;
  /** How far her outline is followed past the rays that start in known backdrop (degrees). */
  trackMax: number;
  /** Degrees over which a followed outline fades out next to rays that are not followed. */
  taper: number;
  /**
   * Only rays at least this far from straight up taper (degrees): lower down
   * it is hair falling past the oval, which should fade rather than end in a
   * cut; higher up an ear can sit right next to a ray that is not followed,
   * and tapering would clip it again.
   */
  taperFrom: number;
}

export const DEFAULT_SILHOUETTE: SilhouetteOptions = {
  tolerance: 32,
  run: 2,
  strong: 1.8,
  reach: 1.5,
  inner: 0.9,
  maxAngle: 118,
  maxRoughness: 2,
  skip: 0.012,
  back: 4,
  trackMax: 20,
  taper: 8,
  taperFrom: 70,
};

/** Rays per full turn. Fine enough that an ear tip (about 3 degrees) spans several rays. */
const RAYS = 1440;

/**
 * Backdrop that is known to be backdrop (1 per pixel): what lies above the
 * top edge's colour run (`topDepth`), grown down and sideways through pixels
 * that continue it smoothly (a step under `tolerance / 2` from the pixel it
 * came from, and within `tolerance` of the colour it carries, which drifts
 * only slowly so a long smooth gradient cannot carry it into her). It grows
 * only outside her head (vignette under 0.9) and above the head centre. Lyra: the dark window frame beside her ear joins the
 * ceiling, so the rays at her ear start there instead of in the bright glass.
 */
export function knownBackdrop(data: Uint8ClampedArray, w: number, h: number, opts: Partial<SilhouetteOptions> = {}): Uint8Array {
  const o = { ...DEFAULT_SILHOUETTE, ...opts };
  const top = topDepth(data, w, h, { maxTop: 1 });
  const yMax = Math.round(HEAD.cy * h);
  const known = new Uint8Array(w * h);
  const run = new Float32Array(w * h * 3);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < top[x] - 1; y++) {
      const p = y * w + x;
      known[p] = 1;
      for (let c = 0; c < 3; c++) run[p * 3 + c] = data[p * 4 + c];
      queue[tail++] = p;
    }
  }
  const step = o.tolerance / 2;
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    for (let n = 0; n < 4; n++) {
      const nx = n === 0 ? x - 1 : n === 1 ? x + 1 : x;
      const ny = n === 2 ? y - 1 : n === 3 ? y + 1 : y;
      if (nx < 0 || nx >= w || ny < 0 || ny >= yMax) continue;
      const q = ny * w + nx;
      if (known[q] || data[q * 4 + 3] < 24) continue;
      if (dist(data, q * 4, [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]) >= step) continue;
      if (dist(data, q * 4, run.subarray(p * 3, p * 3 + 3)) >= o.tolerance) continue;
      if (vignetteAlpha(nx, ny, w, h) >= 0.9) continue;
      known[q] = 1;
      for (let c = 0; c < 3; c++) run[q * 3 + c] = run[p * 3 + c] + (data[q * 4 + c] - run[p * 3 + c]) * 0.01;
      queue[tail++] = q;
    }
  }
  return known;
}

export interface RadialTrace {
  /** Per ray (angle k / RAYS of a turn from straight up, clockwise): px from the head centre where she ends; NaN = no ray. */
  stop: Float32Array;
  /** The ray's inner limit (px). */
  inner: Float32Array;
  /** 1 = the ray started in known backdrop and was followed; 0 = it keeps the oval (stop = inner). */
  followed: Uint8Array;
}

/**
 * Per ray from the head centre, how far out she reaches, scanned INWARD
 * from `reach` head radii (261105, T335): the first pixel that leaves the
 * running backdrop colour is her outline, as `topTrace` does per column. A
 * thin line of the backdrop (a window bar, a lamp chain) is passed when the
 * backdrop colour comes back just inside it.
 *
 * Only a ray that STARTS in known backdrop is followed: above `top`, the
 * depth the top edge's colour runs down to (`topDepth`). A ray starting in
 * anything else (Lyra's window, at the side) cannot tell the window's bars
 * from her outline, so it keeps the oval.
 */
export function radialTrace(data: Uint8ClampedArray, w: number, h: number, opts: Partial<SilhouetteOptions> = {}, known: Uint8Array = knownBackdrop(data, w, h, opts)): RadialTrace {
  const o = { ...DEFAULT_SILHOUETTE, ...opts };
  const cx = HEAD.cx * w;
  const cy = HEAD.cy * h;
  const stop = new Float32Array(RAYS).fill(Number.NaN);
  const innerR = new Float32Array(RAYS).fill(Number.NaN);
  const followed = new Uint8Array(RAYS);
  const skip = Math.max(4, Math.round(Math.max(w, h) * o.skip));
  // Mean colour of the left and right edges (3 px) on each row: [row * 2] left, [row * 2 + 1] right, RGB.
  const side = new Float32Array(h * 2 * 3);
  for (let y = 0; y < h; y++) {
    for (let e = 0; e < 2; e++) {
      for (let j = 0; j < 3; j++) {
        const i = (y * w + (e ? w - 1 - j : j)) * 4;
        for (let q = 0; q < 3; q++) side[(y * 2 + e) * 3 + q] += data[i + q] / 3;
      }
    }
  }
  for (let k = 0; k < RAYS; k++) {
    const deg = (k / RAYS) * 360;
    if (Math.min(deg, 360 - deg) > o.maxAngle) continue;
    const a = (k / RAYS) * 2 * Math.PI;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    // px per head radius along this ray.
    const unit = 1 / Math.sqrt((dx / (HEAD.rx * w)) ** 2 + (dy / (HEAD.ry * h)) ** 2);
    const rIn = o.inner * unit;
    innerR[k] = rIn;
    stop[k] = rIn;
    // Start inside the picture.
    let rOut = o.reach * unit;
    if (dx < 0) rOut = Math.min(rOut, (cx - 0.5) / -dx);
    if (dx > 0) rOut = Math.min(rOut, (w - 1.5 - cx) / dx);
    if (dy < 0) rOut = Math.min(rOut, (cy - 0.5) / -dy);
    if (dy > 0) rOut = Math.min(rOut, (h - 1.5 - cy) / dy);
    if (rOut <= rIn + 2) continue;
    const at = (r: number): number => (Math.round(cy + dy * r) * w + Math.round(cx + dx * r)) * 4;
    // Start where the ray first enters known backdrop.
    while (rOut > rIn + 2 && !known[at(rOut) >> 2]) rOut--;
    if (rOut <= rIn + 2) continue;
    // Seed: the first few px at the outer end.
    const bg = [0, 0, 0];
    for (let s = 0; s < 3; s++) {
      const i = at(rOut - s);
      for (let c = 0; c < 3; c++) bg[c] += data[i + c] / 3;
    }
    const resumesAt = (from: number): number => {
      let same = 0;
      for (let r = from; r > Math.max(rIn, from - skip); r--) {
        if (dist(data, at(r), bg) < o.tolerance * 0.75) {
          if (++same >= o.back) return r;
        } else same = 0;
      }
      return -1;
    };
    followed[k] = 1;
    let run = 0;
    for (let r = rOut; r > rIn; r--) {
      const i = at(r);
      const d = data[i + 3] < 24 ? 0 : dist(data, i, bg);
      let hit = -1;
      if (d >= o.tolerance * o.strong) hit = r;
      else if (d < o.tolerance) {
        run = 0;
        for (let c = 0; c < 3; c++) bg[c] += (data[i + c] - bg[c]) * 0.08;
      } else if (++run >= o.run) hit = r + o.run - 1;
      if (hit < 0) continue;
      const again = resumesAt(r - 1);
      if (again < 0) {
        stop[k] = hit;
        break;
      }
      run = 0;
      r = again;
    }
    // What the ray stopped at may be a line in the backdrop (a ceiling
    // meeting a wall) with more backdrop under it: then what lies just
    // inside the stop has the colour of both side edges of the picture on
    // that row (a wall runs right across; her ears and hair do not reach
    // both sides; lower down her hair and shoulders may, so only rows
    // above the head centre are checked). Such a ray keeps the oval.
    const near = Math.max(4, Math.round(Math.max(w, h) * 0.03));
    let same = 0;
    for (let r = stop[k] - 1; r > Math.max(rIn, stop[k] - near); r--) {
      const row = Math.round(cy + dy * r);
      if (row >= cy) break;
      const i = at(r);
      if (dist(data, i, side.subarray(row * 6, row * 6 + 3)) < o.tolerance && dist(data, i, side.subarray(row * 6 + 3, row * 6 + 6)) < o.tolerance) {
        if (++same >= 3) {
          followed[k] = 0;
          stop[k] = rIn;
          break;
        }
      } else same = 0;
    }
  }
  traceOutline(data, w, h, o, stop, innerR, followed);
  return { stop, inner: innerR, followed };
}

/**
 * From the last followed ray of a run, follow her outline into the rays
 * that were not followed (followed = 2): on each next ray, the strongest
 * colour edge within a few px of the previous ray's stop, while it stays
 * strong. Lyra's left ear borders the bright window, so its rays cannot
 * start in known backdrop; her ink outline is still there to follow, from
 * the top of the ear down its outer side. Only the upper rays (under
 * `taperFrom` from straight up), and at most `trackMax` degrees.
 */
function traceOutline(data: Uint8ClampedArray, w: number, h: number, o: SilhouetteOptions, stop: Float32Array, inner: Float32Array, followed: Uint8Array): void {
  const cx = HEAD.cx * w;
  const cy = HEAD.cy * h;
  const len = stop.length;
  const maxN = Math.round((o.trackMax / 360) * len);
  const thr = o.tolerance * o.strong;
  const px = (k: number, r: number): number => {
    const a = (k / len) * 2 * Math.PI;
    const x = Math.round(cx + Math.sin(a) * r);
    const y = Math.round(cy - Math.cos(a) * r);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : (y * w + x) * 4;
  };
  const upper = (k: number): boolean => {
    const deg = (k / len) * 360;
    return Math.min(deg, 360 - deg) < o.taperFrom;
  };
  const seeds: [number, number][] = [];
  for (let k = 0; k < len; k++) {
    if (followed[k] !== 1) continue;
    for (const dir of [-1, 1]) {
      const n = (k + dir + len) % len;
      if (!followed[n] && !Number.isNaN(inner[n]) && upper(n)) seeds.push([k, dir]);
    }
  }
  for (const [k0, dir] of seeds) {
    let r = stop[k0];
    if (r <= inner[k0] + 2) continue;
    for (let n = 1; n <= maxN; n++) {
      const k = (k0 + dir * n + len) % len;
      if (followed[k] || Number.isNaN(inner[k]) || !upper(k)) break;
      let best = -1;
      let bestR = 0;
      for (let q = Math.round(r) - 3; q <= Math.round(r) + 3; q++) {
        if (q <= inner[k] + 2) continue;
        const i0 = px(k, q - 2);
        const i1 = px(k, q + 1);
        if (i0 < 0 || i1 < 0) continue;
        const d = dist(data, i0, [data[i1], data[i1 + 1], data[i1 + 2]]);
        if (d > best) {
          best = d;
          bestR = q;
        }
      }
      if (best < thr) break;
      // Just outside the edge, so her ink line stays.
      r = bestR;
      stop[k] = r + 2;
      followed[k] = 2;
    }
  }
}

/** Circular min (sign -1) or max (sign 1) filter of a ray trace, NaN skipped. */
function extremeRays(t: Float32Array, r: number, sign: 1 | -1): Float32Array {
  const out = new Float32Array(t.length).fill(Number.NaN);
  for (let i = 0; i < t.length; i++) {
    if (Number.isNaN(t[i])) continue;
    let m = t[i];
    for (let j = -r; j <= r; j++) {
      const v = t[(i + j + t.length) % t.length];
      if (!Number.isNaN(v) && (v - m) * sign > 0) m = v;
    }
    out[i] = m;
  }
  return out;
}

/** Circular median of a ray trace (NaN = no ray, kept NaN). */
function medianRays(t: Float32Array, r: number): Float32Array {
  const out = new Float32Array(t.length).fill(Number.NaN);
  const win: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (Number.isNaN(t[i])) continue;
    win.length = 0;
    for (let j = -r; j <= r; j++) {
      const v = t[(i + j + t.length) % t.length];
      if (!Number.isNaN(v)) win.push(v);
    }
    out[i] = median(win);
  }
  return out;
}

/**
 * Per-ray weight 0..1 of the silhouette. Where followed rays meet rays that
 * keep the oval, her outline would end in a hard cut along one ray (through
 * the hair falling past the oval). Lower down (from `fromDeg`) the weight
 * eases to 0 over `n` rays instead, so the hair fades like the oval's own
 * soft edge. Higher up it stays 1: an ear can sit right next to a ray that
 * is not followed, and fading would clip it again.
 */
function rayWeights(tr: RadialTrace, n: number, fromDeg: number): Float32Array {
  const len = tr.followed.length;
  const out = new Float32Array(len);
  // A ray or two not followed inside a followed run (a side-check miss) is
  // a gap, not a boundary: it would draw a hairline slit through her.
  const on = (k: number): boolean => tr.followed[(k + len) % len] > 0;
  const filled = new Uint8Array(len);
  for (let k = 0; k < len; k++) filled[k] = on(k) || ((on(k - 1) || on(k - 2)) && (on(k + 1) || on(k + 2))) ? 1 : 0;
  const kept = (k: number): boolean => !filled[(k + len) % len];
  for (let k = 0; k < len; k++) {
    if (kept(k)) continue;
    out[k] = 1;
    const deg = (k / len) * 360;
    if (Math.min(deg, 360 - deg) < fromDeg) continue;
    for (let j = 1; j <= n; j++) {
      if (kept(k + j) || kept(k - j)) {
        const f = j / (n + 1);
        out[k] = f * f * (3 - 2 * f);
        break;
      }
    }
  }
  return out;
}

/**
 * Silhouette round the head for a portrait with a painted backdrop (261105,
 * T335), as alpha 0..1, or null when the outline it traces is ragged.
 *
 * Why: the vignette's head oval is a fixed shape, so whatever stuck out of
 * it was cut: Lyra's cat ears lost their outer edges and the hair past her
 * temples was sliced along the oval. `radialTrace` follows her outline round
 * the head instead, so ears, hair tufts and anything she wears there keep
 * their own edge. `portraitMatte` takes the union with the vignette, so a
 * ray that stops early never cuts more than the oval did, and the top matte
 * still removes the backdrop above her. A busy backdrop stops the rays at
 * its own shapes and the trace comes out ragged: then the oval is used alone.
 */
export function silhouetteMatte(data: Uint8ClampedArray, w: number, h: number, opts: Partial<SilhouetteOptions> = {}): Float32Array | null {
  const o = { ...DEFAULT_SILHOUETTE, ...opts };
  if (w < 16 || h < 16 || data.length < w * h * 4) return null;
  const tr = radialTrace(data, w, h, o, knownBackdrop(data, w, h, o));
  // Median: a single ray caught on a speck of the backdrop. Then a closing
  // (max, then min): a few rays that slipped inside her outline (along a dark
  // strand) would cut a slit through her hair.
  const closed = extremeRays(extremeRays(medianRays(tr.stop, 3), 4, 1), 4, -1);
  const t = closed;
  const wt = rayWeights(tr, Math.round((o.taper / 360) * RAYS), o.taperFrom);
  const cx = HEAD.cx * w;
  const cy = HEAD.cy * h;
  // Roughness where the trace adds something past the oval.
  let bend = 0;
  let seen = 0;
  for (let k = 0; k < RAYS; k++) {
    const p = t[(k + RAYS - 1) % RAYS];
    const q = t[(k + 1) % RAYS];
    if (!tr.followed[k] || Number.isNaN(p) || Number.isNaN(q)) continue;
    const a = (k / RAYS) * 2 * Math.PI;
    if (vignetteAlpha(cx + Math.sin(a) * t[k], cy - Math.cos(a) * t[k], w, h) > 0.95) continue;
    bend += Math.abs(p - 2 * t[k] + q);
    seen++;
  }
  if (seen === 0 || bend / seen > o.maxRoughness) return null;
  const feather = Math.max(2, Math.round(Math.max(w, h) * 0.004));
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // Angle from straight up, clockwise, to a ray index (linear between the two nearest rays).
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += 2 * Math.PI;
      const f = (a / (2 * Math.PI)) * RAYS;
      const k0 = Math.floor(f) % RAYS;
      const k1 = (k0 + 1) % RAYS;
      const r0 = t[k0];
      const r1 = t[k1];
      if (Number.isNaN(r0) || Number.isNaN(r1)) continue;
      const fr = f - Math.floor(f);
      const r = r0 + (r1 - r0) * fr;
      const s = Math.min(1, Math.max(0, (r - Math.sqrt(dx * dx + dy * dy) + 1) / feather));
      m[y * w + x] = s * s * (3 - 2 * s) * (wt[k0] + (wt[k1] - wt[k0]) * fr);
    }
  }
  return m;
}


/**
 * The alpha multiplier for a portrait with a painted backdrop: the vignette
 * joined with her silhouette round the head (when it traces cleanly), cut by
 * the top matte. Pure, so tests and shots use the same pipeline as the room.
 */
export function portraitMatte(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const edge = edgeMatte(data, w, h);
  // The rays trust the top trace's backdrop, so without a clean top matte there is no silhouette either.
  const sil = edge ? silhouetteMatte(data, w, h) : null;
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      m[p] = Math.max(vignetteAlpha(x, y, w, h), sil ? sil[p] : 0) * (edge ? edge[p] : 1);
    }
  }
  return m;
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
    const m = portraitMatte(d, w, h);
    for (let p = 0; p < w * h; p++) d[p * 4 + 3] = Math.round(d[p * 4 + 3] * m[p]);
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
