/**
 * Pattern layers for the room renderer (261105, room catalog). The maths is
 * shared (src/shared/seilinkPatterns.ts); this file only caches canvases.
 *
 * A patterned part is drawn like a tinted one (roomCompose drawTinted), with
 * the flat tint fill replaced by a COLOUR canvas over the mask's bounds:
 *   C = accent * (1 - g) + base * g,  g = the tile laid through the planes.
 * Two caches keep it off the frame loop and cheap to recolour:
 *  - grey: the warped tile (CPU, warpPatternGrey) as an alpha canvas, keyed
 *    by frame, pattern, planes and output size. Built only when the pattern
 *    or the geometry changes (or the display resolution does);
 *  - colour: C, keyed by grey + base + accent. Dragging a colour rebuilds
 *    only this, in three canvas ops.
 * The grey skips pixels outside the mask (a keep map read once from the
 * mask) and is capped at WARP_MAX_PX (drawn stretched past that).
 */
import type { ItemLayer, SlotLayer } from '@shared/seilinkDraw';
import type { RoomBox } from '@shared/seilinkRoom';
import { codeTile, mipTile, warpPatternGrey, warpScale, type MipTile, type PatternQuad } from '@shared/seilinkPatterns';
import { ctx2d, makeCanvas, maskBounds, type AnyCanvas } from './roomImages';

const greyCache = new Map<string, AnyCanvas>();
const colourCache = new Map<string, AnyCanvas>();
const codeMips = new Map<string, MipTile>();
const GREY_MAX = 8;
const COLOUR_MAX = 12;
let frameIds = new WeakMap<ImageBitmap, number>();
let nextFrameId = 1;

function idOf(b: ImageBitmap): number {
  let id = frameIds.get(b);
  if (!id) frameIds.set(b, (id = nextFrameId++));
  return id;
}

function lru<T>(map: Map<string, T>, key: string, max: number, make: () => T): T {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const v = make();
  map.set(key, v);
  while (map.size > max) map.delete(map.keys().next().value as string);
  return v;
}

/** Counters for the perf harness: how often the CPU warp ran and how long it took. */
export const patternStats = { warps: 0, warpMs: 0, colours: 0 };

/** The tile of a layer's pattern: generated for a code pattern, from the loaded tiles for a painted one. */
export function layerTile(layer: SlotLayer | ItemLayer, tiles: ReadonlyMap<string, MipTile> | undefined): MipTile | null {
  const def = layer.pattern?.def;
  if (!def) return null;
  if (def.made === 'tile') return def.tile ? (tiles?.get(def.tile) ?? null) : null;
  let m = codeMips.get(def.id);
  if (!m) {
    const t = codeTile(def.id);
    if (!t) return null;
    codeMips.set(def.id, (m = mipTile(t)));
  }
  return m;
}

/**
 * The colour canvas for a patterned layer drawn at `rect` (canvas px) on a
 * context at `res` device px per canvas px, and the canvas-px rect it covers
 * (the mask's bounds, unflipped). null when the layer has no pattern, its
 * tile is not loaded, or its mask is empty.
 */
export function patternColour(
  layer: SlotLayer | ItemLayer,
  rect: RoomBox,
  frame: ImageBitmap,
  mask: ImageBitmap,
  tiles: ReadonlyMap<string, MipTile> | undefined,
  res: number,
): { canvas: AnyCanvas; rect: RoomBox } | null {
  const p = layer.pattern;
  const base = layer.tint;
  if (!p || !base) return null;
  const tile = layerTile(layer, tiles);
  if (!tile) return null;
  const b = maskBounds(mask);
  if (b === null) return null;
  const mb = b ?? [0, 0, mask.width, mask.height];
  // Mask px -> frame px -> canvas px.
  const kx = frame.width / mask.width;
  const ky = frame.height / mask.height;
  const fb: RoomBox = [mb[0] * kx, mb[1] * ky, mb[2] * kx, mb[3] * ky];
  const cx = rect[2] / frame.width;
  const cy = rect[3] / frame.height;
  const region: RoomBox = [rect[0] + fb[0] * cx, rect[1] + fb[1] * cy, fb[2] * cx, fb[3] * cy];
  const scale = warpScale([fb[0], fb[1], fb[2], fb[3]], cx * res);
  const ow = Math.max(1, Math.ceil(fb[2] * scale));
  const oh = Math.max(1, Math.ceil(fb[3] * scale));
  const quads: readonly PatternQuad[] = layer.quads?.length
    ? layer.quads
    : [{ quad: [[0, 0], [frame.width, 0], [frame.width, frame.height], [0, frame.height]] }];
  const greyKey = [idOf(frame), idOf(mask), p.def.id, p.period.join('x'), ow, oh, JSON.stringify(quads)].join('|');
  const grey = lru(greyCache, greyKey, GREY_MAX, () => {
    const t0 = performance.now();
    // Keep map: the mask's alpha at the output size (skip what the mask hides).
    const kc = makeCanvas(ow, oh);
    const kctx = ctx2d(kc, { willReadFrequently: true });
    kctx.drawImage(mask, mb[0], mb[1], mb[2], mb[3], 0, 0, ow, oh);
    const kd = kctx.getImageData(0, 0, ow, oh).data;
    const keep = new Uint8Array(ow * oh);
    for (let i = 0; i < keep.length; i++) keep[i] = kd[i * 4 + 3];
    const out = warpPatternGrey({ tile, period: p.period, quads, rect: fb, scale, out: [ow, oh], keep });
    const gc = makeCanvas(ow, oh);
    const gctx = ctx2d(gc);
    const img = gctx.createImageData(ow, oh);
    const d = img.data;
    for (let i = 0; i < out.data.length; i++) {
      d[i * 4] = 255;
      d[i * 4 + 1] = 255;
      d[i * 4 + 2] = 255;
      d[i * 4 + 3] = out.data[i];
    }
    gctx.putImageData(img, 0, 0);
    patternStats.warps++;
    patternStats.warpMs += performance.now() - t0;
    return gc;
  });
  const canvas = lru(colourCache, `${greyKey}|${base}|${p.accent}`, COLOUR_MAX, () => {
    patternStats.colours++;
    const c = makeCanvas(ow, oh);
    const ctx = ctx2d(c);
    // base where the grey is white: grey alpha, filled with the base colour...
    ctx.drawImage(grey, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, ow, oh);
    // ...over the accent.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, ow, oh);
    ctx.globalCompositeOperation = 'source-over';
    return c;
  });
  return { canvas, rect: region };
}

/** Drop the caches (a pack reload). */
export function clearPatternCache(): void {
  greyCache.clear();
  colourCache.clear();
  frameIds = new WeakMap();
}
