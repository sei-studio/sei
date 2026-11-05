/**
 * SeiLink patterns (261105, room catalog; Shawn msgs 1590 + 1627). Pure: no
 * DOM, no Node, so the renderer, main's look() picture and the tests share
 * one implementation.
 *
 * A tintable surface (walls, curtains, bedding, a rug, a tent, a blanket) can
 * take a pattern: ONE seamless greyscale tile, white = the base colour,
 * black = the accent colour. Inside the part's tint mask the renderer draws
 *
 *   out = frame * (1 - m) + frame * mix(accent, base, g) * m
 *
 * (m = mask weight, g = the tile's grey at that pixel), so the art's own
 * shading is multiplied on top and one tile works for every colour. With no
 * accent picked the accent is the base shifted in lightness (toneOnTone), so
 * a single picker still gives a matching two-tone look.
 *
 * Perspective: a pack lists `patternQuads` per part: 4 canvas points per flat
 * plane (left wall, back wall, duvet top, each curtain panel). The tile is
 * laid on each plane in surface px (`size`, default from the quad's edges)
 * and mapped through the plane's homography, so it shrinks with depth like
 * the room does. Pixels of the mask outside every quad take the plain base.
 * The warp (warpPatternGrey) runs on the CPU, once per change of pattern or
 * geometry; the renderer caches its result and only recolours it (two
 * canvas ops) on a colour change, so there is no per-frame cost.
 *
 * The code patterns below are generated here (patternValue + patternTile).
 * Tile patterns (painted tiles, e.g. the Gemini florals) come from the pack:
 * RoomPresetManifest.patternTiles, files under the shared pack folder.
 */

// ── Surfaces and the registry ───────────────────────────────────────────────

/** Kinds of patternable surface (the catalog's W C B R K T). */
export type PatternSurface = 'walls' | 'curtains' | 'bedding' | 'rugs' | 'cushions' | 'tents';
export const PATTERN_SURFACES: readonly PatternSurface[] = ['walls', 'curtains', 'bedding', 'rugs', 'cushions', 'tents'];

export interface PatternDef {
  id: string;
  /** Editor name (English key; see i18n). */
  name: string;
  /** Word look() puts before the part: "blue gingham curtains". */
  adjective: string;
  /** Surface px one tile covers at scale 1, [w, h]. */
  period: [number, number];
  surfaces: readonly PatternSurface[];
  /** 'code' = generated here; 'tile' = a painted tile file from the pack. */
  made: 'code' | 'tile';
  /** Tile patterns: the pack-relative file (usually under the shared folder). */
  tile?: string;
}

/**
 * The code-drawn patterns that ship now: the catalog's 11 v1 code patterns
 * plus plaid and herringbone (Shawn's list, msg 1627).
 */
export const CODE_PATTERNS: readonly PatternDef[] = [
  { id: 'pinstripe', name: 'Pinstripe', adjective: 'pinstriped', period: [44, 44], surfaces: ['walls', 'curtains', 'bedding'], made: 'code' },
  { id: 'wide_stripe', name: 'Wide stripe', adjective: 'striped', period: [150, 150], surfaces: ['walls', 'curtains', 'bedding', 'rugs', 'cushions', 'tents'], made: 'code' },
  { id: 'breton', name: 'Breton stripe', adjective: 'striped', period: [64, 64], surfaces: ['bedding', 'cushions', 'curtains'], made: 'code' },
  { id: 'polka', name: 'Polka dot', adjective: 'polka-dot', period: [84, 84], surfaces: ['walls', 'curtains', 'bedding', 'cushions'], made: 'code' },
  { id: 'gingham', name: 'Gingham', adjective: 'gingham', period: [72, 72], surfaces: ['curtains', 'bedding', 'rugs', 'cushions', 'tents'], made: 'code' },
  { id: 'buffalo', name: 'Buffalo check', adjective: 'buffalo-check', period: [170, 170], surfaces: ['bedding', 'rugs', 'cushions', 'tents'], made: 'code' },
  { id: 'checker', name: 'Checkerboard', adjective: 'checked', period: [130, 130], surfaces: ['walls', 'rugs', 'cushions'], made: 'code' },
  { id: 'grid', name: 'Grid', adjective: 'grid', period: [90, 90], surfaces: ['walls'], made: 'code' },
  { id: 'hex', name: 'Hexagons', adjective: 'honeycomb', period: [104, 180], surfaces: ['walls', 'rugs'], made: 'code' },
  { id: 'stars4', name: 'Stars', adjective: 'starry', period: [130, 130], surfaces: ['walls', 'curtains', 'bedding', 'cushions'], made: 'code' },
  { id: 'seigaiha', name: 'Waves', adjective: 'wave-print', period: [120, 60], surfaces: ['walls', 'curtains', 'bedding', 'cushions'], made: 'code' },
  { id: 'plaid', name: 'Plaid', adjective: 'plaid', period: [180, 180], surfaces: ['bedding', 'cushions', 'rugs', 'tents'], made: 'code' },
  { id: 'herringbone', name: 'Herringbone', adjective: 'herringbone', period: [96, 96], surfaces: ['rugs'], made: 'code' },
];

const CODE_BY_ID = new Map(CODE_PATTERNS.map((p) => [p.id, p]));

export function codePattern(id: string): PatternDef | undefined {
  return CODE_BY_ID.get(id);
}

export const PATTERN_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

// ── Code tiles ──────────────────────────────────────────────────────────────

const frac = (x: number): number => x - Math.floor(x);
/** 1 inside a band [a, b) of a periodic coordinate, else 0. */
const band = (x: number, a: number, b: number): number => {
  const f = frac(x);
  return f >= a && f < b ? 1 : 0;
};

/** Distance from p to the nearest point of a lattice with the given offsets, wrapped in the unit tile. */
function wrapDist(u: number, v: number, cx: number, cy: number, aspect: number): number {
  let dx = Math.abs(frac(u) - cx);
  let dy = Math.abs(frac(v) - cy);
  dx = Math.min(dx, 1 - dx);
  dy = Math.min(dy, 1 - dy);
  return Math.hypot(dx * aspect, dy);
}

/** Four-point star (Sui's motif): inside when |x|^k + |y|^k < r^k with k < 1 (pinched). */
function star(dx: number, dy: number, r: number): boolean {
  const k = 0.62;
  return Math.abs(dx) ** k + Math.abs(dy) ** k < r ** k;
}

function wrapDelta(a: number, c: number): number {
  let d = frac(a) - c;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/** Grey of a hexagon outline lattice. Tile = one period of the honeycomb (w : h = sqrt3 : 3). */
function hexValue(u: number, v: number): number {
  // Tile space to hex space: point-up hexagons of circumradius 1, period (sqrt3, 3).
  const s3 = Math.sqrt(3);
  const x = frac(u) * s3;
  const y = frac(v) * 3;
  // Centres of the hexes touching this tile.
  const centres: Array<[number, number]> = [
    [0, 0], [s3, 0], [s3 / 2, 1.5], [0, 3], [s3, 3], [-s3 / 2, 1.5], [s3 * 1.5, 1.5],
  ];
  let best = Infinity;
  let second = Infinity;
  for (const [cx, cy] of centres) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < best) {
      second = best;
      best = d;
    } else if (d < second) second = d;
  }
  // Near the line where two cells meet = on an edge.
  return second - best < 0.16 ? 0 : 1;
}

/** Grey of seigaiha (overlapping wave arcs): lattice (2R, 0) and (R, R/2); later rows overlap earlier ones. */
function seigaihaValue(u: number, v: number): number {
  // Tile = 2R wide, R tall; R = 1 in this space.
  const x = frac(u) * 2;
  const y = frac(v);
  let best: { cy: number; d: number } | null = null;
  for (let row = -2; row <= 3; row++) {
    const cy = row * 0.5;
    const off = row % 2 === 0 ? 0 : 1;
    for (let col = -1; col <= 2; col++) {
      const cx = col * 2 + off;
      const d = Math.hypot(x - cx, y - cy);
      if (d >= 1) continue;
      // The circle drawn last (lowest on screen) covers the others.
      if (!best || cy > best.cy) best = { cy, d };
    }
  }
  if (!best) return 1;
  const r = best.d;
  // Three rings per scale plus a solid core.
  if (r < 0.22) return 0;
  const ring = frac(r * 3.6);
  return ring < 0.42 ? 0 : 1;
}

/** Plaid weave: weighted stripes each way, crossings darker (generic, no named tartan). */
function plaidValue(u: number, v: number): number {
  const stripe = (t: number): number => {
    const f = frac(t);
    if (f < 0.34) return 0.62; // wide band
    if (f >= 0.5 && f < 0.56) return 1; // thin line
    if (f >= 0.7 && f < 0.74) return 0.8; // hairline
    return 0;
  };
  const a = stripe(u);
  const b = stripe(v);
  return 1 - Math.min(1, (a + b) * 0.55);
}

/** Herringbone: columns of slanted bricks, alternating direction, thin accent seams. */
function herringboneValue(u: number, v: number): number {
  const cols = 4;
  const c = Math.floor(frac(u) * cols);
  const x = frac(frac(u) * cols);
  // Odd columns slope the other way and sit half a brick lower, so the seams zigzag.
  const slant = c % 2 === 0 ? x : 1 - x;
  const t = frac(v * 4 + slant + (c % 2) * 0.5);
  const seamX = x < 0.06;
  return seamX || t < 0.12 ? 0 : 1;
}

/**
 * Grey of a code pattern at tile point (u, v) in [0, 1): 1 = base, 0 = accent.
 * Periodic in both: any u, v works. Unknown ids are plain (1).
 */
export function patternValue(id: string, u: number, v: number): number {
  switch (id) {
    case 'pinstripe':
      return band(u, 0, 0.1) ? 0 : 1;
    case 'wide_stripe':
      return band(u, 0, 0.5) ? 0 : 1;
    case 'breton':
      return band(v, 0, 0.34) ? 0 : 1;
    case 'polka': {
      const a = wrapDist(u, v, 0.25, 0.25, 1);
      const b = wrapDist(u, v, 0.75, 0.75, 1);
      return Math.min(a, b) < 0.13 ? 0 : 1;
    }
    case 'gingham':
      return 1 - 0.5 * (band(u, 0, 0.5) + band(v, 0, 0.5));
    case 'buffalo': {
      const n = band(u, 0, 0.5) + band(v, 0, 0.5);
      return n === 2 ? 0 : n === 1 ? 0.42 : 1;
    }
    case 'checker':
      return band(u, 0, 0.5) !== band(v, 0, 0.5) ? 0 : 1;
    case 'grid':
      return band(u, 0, 0.05) || band(v, 0, 0.05) ? 0 : 1;
    case 'hex':
      return hexValue(u, v);
    case 'stars4': {
      const big = star(wrapDelta(u, 0.25), wrapDelta(v, 0.25), 0.15);
      const small = star(wrapDelta(u, 0.75), wrapDelta(v, 0.75), 0.075);
      return big || small ? 0 : 1;
    }
    case 'seigaiha':
      return seigaihaValue(u, v);
    case 'plaid':
      return plaidValue(u, v);
    case 'herringbone':
      return herringboneValue(u, v);
    default:
      return 1;
  }
}

/** A greyscale tile raster, row major, 0..255 (255 = base). */
export interface PatternTile {
  w: number;
  h: number;
  data: Uint8Array;
}

const TILE_SS = 4;

/** Tile px for a code pattern: about one texel per surface px, power-of-two-ish, at most 256. */
export function tileSizeFor(def: Pick<PatternDef, 'period'>): [number, number] {
  const fit = (p: number): number => Math.max(16, Math.min(256, Math.round(p)));
  return [fit(def.period[0]), fit(def.period[1])];
}

/** Rasterise a code pattern, anti-aliased (4x4 samples per texel). */
export function patternTile(id: string, w: number, h: number): PatternTile {
  const data = new Uint8Array(w * h);
  const n = TILE_SS * TILE_SS;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < TILE_SS; sy++) {
        for (let sx = 0; sx < TILE_SS; sx++) {
          sum += patternValue(id, (x + (sx + 0.5) / TILE_SS) / w, (y + (sy + 0.5) / TILE_SS) / h);
        }
      }
      data[y * w + x] = Math.round((sum / n) * 255);
    }
  }
  return { w, h, data };
}

const tileCache = new Map<string, PatternTile>();

/** A code pattern's tile at its default size, generated once. */
export function codeTile(id: string): PatternTile | null {
  const def = CODE_BY_ID.get(id);
  if (!def) return null;
  let t = tileCache.get(id);
  if (!t) {
    const [w, h] = tileSizeFor(def);
    t = patternTile(id, w, h);
    tileCache.set(id, t);
  }
  return t;
}

/** A painted tile (RGBA, any colours) as grey: luminance x alpha, white where transparent. */
export function greyTileFromRgba(rgba: ArrayLike<number>, w: number, h: number): PatternTile {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3] / 255;
    const l = r * 0.299 + g * 0.587 + b * 0.114;
    data[i] = Math.round(l * a + 255 * (1 - a));
  }
  return { w, h, data };
}

// ── Colour ──────────────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Lightness step of the default accent (the catalog's 18%). */
export const TONE_ON_TONE_STEP = 0.18;

/**
 * The default accent for a base: the same hue shifted 18% in lightness,
 * darker for a light base and lighter for a dark one, so the pattern reads
 * as tone on tone.
 */
export function toneOnTone(base: string): string {
  const rgb = hexToRgb(base);
  if (!rgb) return '#808080';
  const [h, s, l] = rgbToHsl(rgb);
  const next = l > 0.42 ? l - TONE_ON_TONE_STEP : l + TONE_ON_TONE_STEP;
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, next))]));
}

/** The colour a tile grey `g` (0..1) stands for: accent at 0, base at 1. */
export function mixPatternColour(base: Rgb, accent: Rgb, g: number): Rgb {
  const t = Math.max(0, Math.min(1, g));
  return [accent[0] + (base[0] - accent[0]) * t, accent[1] + (base[1] - accent[1]) * t, accent[2] + (base[2] - accent[2]) * t];
}

/**
 * One patterned pixel: the frame's own colour multiplied by the pattern's
 * colour inside the mask (weight m, 0..1), untouched outside it. Same rule
 * as a plain tint (seilinkRoom.ts), with the tint replaced by the mix.
 */
export function patternPixel(frame: Rgb, m: number, base: Rgb, accent: Rgb, g: number): Rgb {
  const c = mixPatternColour(base, accent, g);
  const w = Math.max(0, Math.min(1, m));
  return [frame[0] * (1 - w + (w * c[0]) / 255), frame[1] * (1 - w + (w * c[1]) / 255), frame[2] * (1 - w + (w * c[2]) / 255)];
}

// ── Perspective (UV quads) ──────────────────────────────────────────────────

export type QuadPoints = [[number, number], [number, number], [number, number], [number, number]];

/** One flat plane of a patternable part (see the header). */
export interface PatternQuad {
  /** Corners, canvas px (sprite px for items): top-left, top-right, bottom-right, bottom-left of the plane. */
  quad: QuadPoints;
  /** The plane's flat size in surface px (default from its edge lengths). */
  size?: [number, number];
  /** Surface px of the tile at the quad's top-left (keeps a pattern continuous across neighbouring quads). */
  uv?: [number, number];
}

/** 3x3 matrix, row major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** The default flat size of a quad: its mean top/bottom and left/right edge lengths. */
export function quadSize(q: QuadPoints): [number, number] {
  const d = (a: [number, number], b: [number, number]): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(d(q[0], q[1]) + d(q[3], q[2])) / 2, (d(q[0], q[3]) + d(q[1], q[2])) / 2];
}

/**
 * Homography from the unit square to a quad: (0,0)->q0, (1,0)->q1,
 * (1,1)->q2, (0,1)->q3 (Heckbert's square-to-quad). null when degenerate.
 */
export function squareToQuad(q: QuadPoints): Mat3 | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const m: Mat3 = [a, b, x0, d, e, y0, g, h, 1];
  return Math.abs(det3(m)) < 1e-12 ? null : m;
}

function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function invert3(m: Mat3): Mat3 | null {
  const d = det3(m);
  if (Math.abs(d) < 1e-15) return null;
  const [a, b, c, e, f, g, h, i, j] = m;
  return [
    (f * j - g * i) / d,
    (c * i - b * j) / d,
    (b * g - c * f) / d,
    (g * h - e * j) / d,
    (a * j - c * h) / d,
    (c * e - a * g) / d,
    (e * i - f * h) / d,
    (b * h - a * i) / d,
    (a * f - b * e) / d,
  ];
}

/** Apply a homography to a point. */
export function project(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** A quad's screen-to-surface map: canvas px to surface px (0..size), or null when degenerate. */
export interface QuadMap {
  inv: Mat3;
  size: [number, number];
  uv: [number, number];
  quad: QuadPoints;
}

export function quadMap(q: PatternQuad): QuadMap | null {
  const m = squareToQuad(q.quad);
  const inv = m && invert3(m);
  if (!inv) return null;
  const size = q.size && q.size[0] > 0 && q.size[1] > 0 ? q.size : quadSize(q.quad);
  return { inv, size, uv: q.uv ?? [0, 0], quad: q.quad };
}

/** Surface px of canvas point (x, y) on a quad (may be outside 0..size when the point is outside it). */
export function screenToSurface(map: QuadMap, x: number, y: number): [number, number] {
  const [u, v] = project(map.inv, x, y);
  return [map.uv[0] + u * map.size[0], map.uv[1] + v * map.size[1]];
}

/** Point in a convex or concave quad (even-odd). */
export function inQuad(q: QuadPoints, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── The warp ────────────────────────────────────────────────────────────────

/**
 * A tile with its mip levels (each half the size of the one before, box
 * averaged), for anti-aliased lookups at any scale: a far wall samples a
 * smaller level, so thin stripes fade to their mean instead of shimmering
 * into moire.
 */
export interface MipTile {
  w: number;
  h: number;
  levels: Array<{ w: number; h: number; data: Float32Array }>;
  mean: number;
}

export function mipTile(t: PatternTile): MipTile {
  const base = new Float32Array(t.w * t.h);
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    base[i] = t.data[i] / 255;
    sum += base[i];
  }
  const levels = [{ w: t.w, h: t.h, data: base }];
  let prev = levels[0];
  while (prev.w > 1 || prev.h > 1) {
    const w = Math.max(1, Math.ceil(prev.w / 2));
    const h = Math.max(1, Math.ceil(prev.h / 2));
    const data = new Float32Array(w * h);
    // Each texel averages the (wrapped) 2x2 block of the level above; odd sizes wrap one texel.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xa = (x * 2) % prev.w;
        const xb = (x * 2 + 1) % prev.w;
        const ya = (y * 2) % prev.h;
        const yb = (y * 2 + 1) % prev.h;
        data[y * w + x] = (prev.data[ya * prev.w + xa] + prev.data[ya * prev.w + xb] + prev.data[yb * prev.w + xa] + prev.data[yb * prev.w + xb]) / 4;
      }
    }
    prev = { w, h, data };
    levels.push(prev);
  }
  return { w: t.w, h: t.h, levels, mean: sum / base.length };
}

function bilinear(l: { w: number; h: number; data: Float32Array }, x: number, y: number): number {
  const { w, h, data } = l;
  const px = x - 0.5;
  const py = y - 0.5;
  const fx0 = Math.floor(px);
  const fy0 = Math.floor(py);
  const fx = px - fx0;
  const fy = py - fy0;
  let x0 = fx0 - Math.floor(fx0 / w) * w;
  let y0 = fy0 - Math.floor(fy0 / h) * h;
  if (x0 >= w) x0 = 0;
  if (y0 >= h) y0 = 0;
  const x1 = x0 + 1 === w ? 0 : x0 + 1;
  const y1 = y0 + 1 === h ? 0 : y0 + 1;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const a = data[r0 + x0] + (data[r0 + x1] - data[r0 + x0]) * fx;
  const b = data[r1 + x0] + (data[r1 + x1] - data[r1 + x0]) * fx;
  return a + (b - a) * fy;
}

/**
 * Grey (0..1) of the tile at texel point (x, y) of level 0 (any real value,
 * the tile repeats), filtered for a pixel footprint of `foot` texels.
 */
export function sampleMip(t: MipTile, x: number, y: number, foot: number): number {
  // Up to 1.25 texels per px a plain bilinear look is sharp and still alias-free enough.
  if (!(foot > 1.25)) return bilinear(t.levels[0], x, y);
  const lod = Math.log2(foot);
  const top = t.levels.length - 1;
  if (lod >= top) return t.mean;
  const k = Math.floor(lod);
  const f = lod - k;
  const s0 = 2 ** k;
  const a = bilinear(t.levels[k], x / s0, y / s0);
  if (f < 0.01) return a;
  const b = bilinear(t.levels[k + 1], x / (s0 * 2), y / (s0 * 2));
  return a + (b - a) * f;
}

export interface WarpInput {
  tile: MipTile;
  /** Surface px one tile covers, [w, h]. */
  period: [number, number];
  /** Quads in the same px as `rect`. */
  quads: readonly PatternQuad[];
  /** Region to fill: [x, y, w, h] in the quads' px. */
  rect: [number, number, number, number];
  /** Output px per quad px. */
  scale: number;
  /** Output size; default ceil(rect size x scale). */
  out?: [number, number];
  /** Optional, output size: pixels where this is 0 are skipped (left at base), e.g. outside the tint mask. */
  keep?: Uint8Array | Uint8ClampedArray;
}

/** Most output px a warp computes; a bigger region is computed smaller and drawn stretched (soft, not slow). */
export const WARP_MAX_PX = 1_200_000;

/** Output px per quad px for a region at `res`, under the WARP_MAX_PX budget. */
export function warpScale(rect: readonly [number, number, number, number], res: number, max = WARP_MAX_PX): number {
  const px = rect[2] * rect[3] * res * res;
  return px <= max ? res : res * Math.sqrt(max / px);
}

export interface WarpOutput {
  w: number;
  h: number;
  /** Grey per output px, 0..255 (255 = base). Outside every quad: 255 (plain base). */
  data: Uint8Array;
}

/** x ranges where the horizontal line at y is inside the polygon (even-odd), sorted pairs. */
function rowSpans(q: QuadPoints, y: number, xs: number[]): number[] {
  xs.length = 0;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i];
    const [xj, yj] = q[j];
    if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  return xs;
}

/**
 * The tile laid through the quads over `rect`, one sample per output pixel
 * centre, filtered by the pixel's footprint on the tile. Later quads win
 * where quads overlap. Steps the homography incrementally along each row,
 * so a full-screen wall is a few tens of ms.
 */
export function warpPatternGrey(input: WarpInput): WarpOutput {
  const { tile, period, quads, rect, scale } = input;
  const [rx, ry, rw, rh] = rect;
  const w = input.out?.[0] ?? Math.max(1, Math.ceil(rw * scale));
  const h = input.out?.[1] ?? Math.max(1, Math.ceil(rh * scale));
  const data = new Uint8Array(w * h).fill(255);
  const keep = input.keep && input.keep.length >= w * h ? input.keep : null;
  const sx = rw / w;
  const sy = rh / h;
  const tx = tile.w / period[0];
  const ty = tile.h / period[1];
  const xs: number[] = [];
  for (const q of quads) {
    const map = quadMap(q);
    if (!map) continue;
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = map.inv;
    // Texel coords: X = (u0 + U * uw) * tx where U = (m0 x + m1 y + m2) / W.
    const kx = map.size[0] * tx;
    const ky = map.size[1] * ty;
    const ox = map.uv[0] * tx;
    const oy = map.uv[1] * ty;
    let qy0 = Infinity;
    let qy1 = -Infinity;
    for (const p of q.quad) {
      qy0 = Math.min(qy0, p[1]);
      qy1 = Math.max(qy1, p[1]);
    }
    const j0 = Math.max(0, Math.floor((qy0 - ry) / sy));
    const j1 = Math.min(h - 1, Math.ceil((qy1 - ry) / sy));
    for (let j = j0; j <= j1; j++) {
      const cy = ry + (j + 0.5) * sy;
      const spans = rowSpans(q.quad, cy, xs);
      for (let s = 0; s + 1 < spans.length; s += 2) {
        // Pixel centres cx = rx + (i + 0.5) sx inside [spans[s], spans[s + 1]).
        const i0 = Math.max(0, Math.ceil((spans[s] - rx) / sx - 0.5));
        const i1 = Math.min(w - 1, Math.ceil((spans[s + 1] - rx) / sx - 0.5) - 1);
        if (i1 < i0) continue;
        const cx0 = rx + (i0 + 0.5) * sx;
        let nu = m0 * cx0 + m1 * cy + m2;
        let nv = m3 * cx0 + m4 * cy + m5;
        let wz = m6 * cx0 + m7 * cy + m8;
        const dnu = m0 * sx;
        const dnv = m3 * sx;
        const dwz = m6 * sx;
        let o = j * w + i0;
        for (let i = i0; i <= i1; i++) {
          if (keep && keep[o] === 0) {
            o++;
            nu += dnu;
            nv += dnv;
            wz += dwz;
            continue;
          }
          const iw = 1 / wz;
          const U = nu * iw;
          const V = nv * iw;
          // Jacobian of (U, V) per output px, in texels: the footprint.
          const dux = (m0 - U * m6) * iw * sx * kx;
          const duy = (m1 - U * m7) * iw * sy * kx;
          const dvx = (m3 - V * m6) * iw * sx * ky;
          const dvy = (m4 - V * m7) * iw * sy * ky;
          const foot = Math.max(Math.abs(dux) + Math.abs(duy), Math.abs(dvx) + Math.abs(dvy));
          const g = sampleMip(tile, ox + U * kx, oy + V * ky, foot);
          data[o++] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
          nu += dnu;
          nv += dnv;
          wz += dwz;
        }
      }
    }
  }
  return { w, h, data };
}
