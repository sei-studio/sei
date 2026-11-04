/**
 * SeiLink room compositing (261104). Draws draw-plan layers (shared/
 * seilinkDraw.ts) onto a 2D context whose transform maps canvas px to the
 * target's pixels. Used by RoomRenderer for its cached layers; the editor can
 * use it for thumbnails.
 *
 * Tint (format rule): inside the mask the frame is multiplied by the tint,
 * outside it is untouched, so the art's own shading stays:
 *   out = frame * (1 - m) + frame * tint * m,   m = mask luminance x alpha.
 *
 * Lips and soft tops (261105 shelf pass): a slot layer with `clip` (a top's
 * lip) is drawn only inside its polygons; an item with `sink` is drawn
 * through a scratch with its base faded into the top (sinkKeep), over a soft
 * contact shadow as wide as its base. Both happen when a cached layer is
 * built, never per frame.
 *
 * 261105 catalog: a patterned layer multiplies by its colour canvas
 * (roomPattern.ts) instead of a flat tint; a `fit: 'cover'` slot is cropped
 * to its box (coverCrop); a light's glow can be lit in a colour (its grey
 * version times the colour, per frame while it cycles).
 */
import {
  baseSpan,
  contactShadow,
  coverCrop,
  itemRect,
  sinkKeep,
  sinkLook,
  sunkRect,
  type GlowLayer,
  type ItemLayer,
  type RoomDrawPlan,
  type SinkLook,
  type SlotLayer,
} from '@shared/seilinkDraw';
import type { RoomBox, RoomPolygon } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { mipTile, type MipTile } from '@shared/seilinkPatterns';
import { ctx2d, loadPatternTileGrey, loadRoomGlow, loadRoomGlowGrey, loadRoomImage, loadRoomMask, makeCanvas, maskBounds, type AnyCanvas, type AnyContext2D, type TrimmedGlow } from './roomImages';
import { patternColour } from './roomPattern';

export interface RoomAssets {
  images: Map<string, ImageBitmap>;
  masks: Map<string, ImageBitmap>;
  glows: Map<string, TrimmedGlow>;
  /** 261105: painted pattern tiles by pack path. */
  tiles?: Map<string, MipTile>;
  /** 261105: glows with their colour taken out, for lights lit in a colour. */
  glowsGrey?: Map<string, TrimmedGlow>;
}

export interface RoomAssetError {
  file: string;
  message: string;
}

/** Load everything a plan draws. Missing files are reported, not thrown: the rest still draws. */
export async function loadPlanAssets(plan: Pick<RoomDrawPlan, 'layers' | 'glows'> & Partial<RoomDrawPlan>, resolve: RoomUrlResolver, into?: RoomAssets): Promise<{ assets: RoomAssets; errors: RoomAssetError[] }> {
  const assets: RoomAssets = into ?? { images: new Map(), masks: new Map(), glows: new Map() };
  const errors: RoomAssetError[] = [];
  const jobs: Array<Promise<void>> = [];
  const want = <T>(map: Map<string, T>, rel: string, load: (url: string) => Promise<T>): void => {
    if (map.has(rel)) return;
    jobs.push(
      load(resolve(rel)).then(
        (v) => void map.set(rel, v),
        (err: unknown) => void errors.push({ file: rel, message: err instanceof Error ? err.message : String(err) }),
      ),
    );
  };
  for (const l of plan.layers) {
    if (l.kind === 'avatar') continue;
    want(assets.images, l.frame.src, loadRoomImage);
    if (l.tint && l.frame.mask) want(assets.masks, l.frame.mask, loadRoomMask);
    // 261105: an indoor shell's window glass (where rain runs and view particles show).
    if (l.frame.glass && plan.particles?.length) want(assets.masks, l.frame.glass, loadRoomMask);
    const tile = l.pattern?.def.made === 'tile' ? l.pattern.def.tile : undefined;
    if (tile) want((assets.tiles ??= new Map()), tile, async (url) => mipTile(await loadPatternTileGrey(url)));
  }
  for (const g of plan.glows) {
    want(assets.glows, g.src, loadRoomGlow);
    if (g.tint || g.cycle) want((assets.glowsGrey ??= new Map()), g.src, loadRoomGlowGrey);
  }
  await Promise.all(jobs);
  return { assets, errors };
}

/** Destination rect (canvas px) of a slot or item layer, or null until its image is loaded. */
export function layerRect(layer: SlotLayer | ItemLayer, canvas: readonly [number, number], assets: RoomAssets): RoomBox | null {
  const img = assets.images.get(layer.frame.src);
  if (!img) return null;
  if (layer.kind === 'slot') return layer.box ?? [0, 0, canvas[0], canvas[1]];
  return itemRect(layer, [img.width, img.height]);
}

let scratch: { c: AnyCanvas; ctx: AnyContext2D } | null = null;

function scratchOf(w: number, h: number): { c: AnyCanvas; ctx: AnyContext2D } {
  if (!scratch || scratch.c.width < w || scratch.c.height < h) {
    const c = makeCanvas(Math.max(w, scratch?.c.width ?? 0), Math.max(h, scratch?.c.height ?? 0));
    scratch = { c, ctx: ctx2d(c) };
  }
  return scratch;
}

function drawFlipped(ctx: AnyContext2D, img: CanvasImageSource, [x, y, w, h]: RoomBox, flip: boolean): void {
  if (!flip) {
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

/**
 * Draw one tinted frame. `scale` is ctx's canvas-px to device-px factor, for
 * the scratch size. `clip` (canvas px) limits the work to a region: the
 * recolour fast path redraws only where the mask is.
 */
function drawTinted(
  ctx: AnyContext2D,
  frame: ImageBitmap,
  mask: ImageBitmap,
  tint: string,
  rect: RoomBox,
  scale: number,
  flip = false,
  clip?: RoomBox,
  colour?: { canvas: AnyCanvas; rect: RoomBox } | null,
): void {
  let [x, y, w, h] = rect;
  // Source regions of the frame and the mask (they may differ in size).
  let fx = 0;
  let fy = 0;
  let fw = frame.width;
  let fh = frame.height;
  let mx = 0;
  let my = 0;
  let mw = mask.width;
  let mh = mask.height;
  if (clip && !flip) {
    const ix = Math.max(x, clip[0]);
    const iy = Math.max(y, clip[1]);
    const ix2 = Math.min(x + w, clip[0] + clip[2]);
    const iy2 = Math.min(y + h, clip[1] + clip[3]);
    if (ix2 <= ix || iy2 <= iy) return;
    const u0 = (ix - x) / w;
    const v0 = (iy - y) / h;
    const u1 = (ix2 - x) / w;
    const v1 = (iy2 - y) / h;
    [fx, fy, fw, fh] = [u0 * frame.width, v0 * frame.height, (u1 - u0) * frame.width, (v1 - v0) * frame.height];
    [mx, my, mw, mh] = [u0 * mask.width, v0 * mask.height, (u1 - u0) * mask.width, (v1 - v0) * mask.height];
    [x, y, w, h] = [ix, iy, ix2 - ix, iy2 - iy];
  }
  const dest: RoomBox = [x, y, w, h];
  if (flip) drawFlipped(ctx, frame, dest, true);
  else ctx.drawImage(frame, fx, fy, fw, fh, x, y, w, h);
  const sw = Math.max(1, Math.ceil(w * scale));
  const sh = Math.max(1, Math.ceil(h * scale));
  const s = scratchOf(sw, sh);
  const sc = s.ctx;
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, sw, sh);
  sc.drawImage(frame, fx, fy, fw, fh, 0, 0, sw, sh);
  sc.globalCompositeOperation = 'multiply';
  if (colour) {
    // The pattern's colours over the mask's bounds (outside them the mask is empty anyway).
    const [rx, ry, rw, rh] = colour.rect;
    const kx = sw / w;
    const ky = sh / h;
    sc.imageSmoothingEnabled = true;
    sc.drawImage(colour.canvas, (rx - x) * kx, (ry - y) * ky, rw * kx, rh * ky);
  } else {
    sc.fillStyle = tint;
    sc.fillRect(0, 0, sw, sh);
  }
  sc.globalCompositeOperation = 'destination-in';
  sc.drawImage(mask, mx, my, mw, mh, 0, 0, sw, sh);
  sc.drawImage(frame, fx, fy, fw, fh, 0, 0, sw, sh);
  sc.restore();
  if (!flip) {
    ctx.drawImage(s.c, 0, 0, sw, sh, x, y, w, h);
    return;
  }
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(s.c, 0, 0, sw, sh, 0, 0, w, h);
  ctx.restore();
}

/**
 * Canvas-px region a tinted layer's mask covers (where a recolour changes
 * pixels), or null when unknown (draw it all).
 */
export function tintRegion(layer: SlotLayer | ItemLayer, canvas: readonly [number, number], assets: RoomAssets): RoomBox | null {
  if (!layer.frame.mask) return null;
  const mask = assets.masks.get(layer.frame.mask);
  const rect = layerRect(layer, canvas, assets);
  if (!mask || !rect) return null;
  const b = maskBounds(mask);
  if (b === undefined) return null;
  if (b === null) return [rect[0], rect[1], 0, 0];
  const [x, y, w, h] = rect;
  const sx = w / mask.width;
  const sy = h / mask.height;
  const flip = layer.kind === 'item' && layer.flip;
  const bx = flip ? mask.width - b[0] - b[2] : b[0];
  return [x + bx * sx, y + b[1] * sy, b[2] * sx, b[3] * sy];
}

function polygonsBox(polys: readonly RoomPolygon[]): RoomBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys) {
    for (const [x, y] of p) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

function intersect(a: RoomBox, b: RoomBox | undefined): RoomBox {
  if (!b) return a;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}

/** One layer as it is, with its tint (or pattern) when it has one. */
function drawPlain(ctx: AnyContext2D, l: SlotLayer | ItemLayer, img: ImageBitmap, rect: RoomBox, assets: RoomAssets, scale: number, clip?: RoomBox): void {
  if (l.tint && l.frame.mask) {
    const mask = assets.masks.get(l.frame.mask);
    if (mask) {
      const colour = l.pattern ? patternColour(l, rect, img, mask, assets.tiles, scale) : null;
      drawTinted(ctx, img, mask, l.tint, rect, scale, l.kind === 'item' && l.flip, clip, colour);
      return;
    }
  }
  if (l.kind === 'slot' && l.component.fit === 'cover' && l.box) {
    const [sx, sy, sw, sh] = coverCrop([img.width, img.height], [rect[2], rect[3]], l.component.focus);
    ctx.drawImage(img, sx, sy, sw, sh, rect[0], rect[1], rect[2], rect[3]);
    return;
  }
  drawFlipped(ctx, img, rect, l.kind === 'item' && l.flip);
}

let sinkScratch: { c: AnyCanvas; ctx: AnyContext2D } | null = null;
/** Base span of each sprite at each sink look, measured once (sprite alpha read back once per frame file). */
const baseCache = new Map<string, [number, number] | null>();
const alphaCache = new WeakMap<ImageBitmap, { w: number; h: number; data: Uint8ClampedArray } | null>();

function spriteAlpha(img: ImageBitmap): { w: number; h: number; data: Uint8ClampedArray } | null {
  if (alphaCache.has(img)) return alphaCache.get(img)!;
  let out: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  try {
    // Item sprites are small; a big one is read at a quarter million px at most.
    const s = Math.min(1, Math.sqrt(250_000 / Math.max(1, img.width * img.height)));
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const c = makeCanvas(w, h);
    const cx = ctx2d(c, { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    out = { w, h, data: cx.getImageData(0, 0, w, h).data };
  } catch {
    out = null;
  }
  alphaCache.set(img, out);
  return out;
}

function baseOf(l: ItemLayer, look: SinkLook, img: ImageBitmap, rect: RoomBox): [number, number] | null {
  const key = `${l.frame.src}:${l.flip ? 1 : 0}:${rect.map((v) => v.toFixed(1)).join(',')}:${look.contact.toFixed(1)}:${look.fadeTop.toFixed(1)}`;
  if (baseCache.has(key)) return baseCache.get(key)!;
  const a = spriteAlpha(img);
  const span = a ? baseSpan(l, look, [a.w, a.h], rect, (u, v) => a.data[(v * a.w + u) * 4 + 3]) : null;
  if (baseCache.size > 256) baseCache.clear();
  baseCache.set(key, span);
  return span;
}

/** An item on a soft top: a soft shadow at its contact, then the sprite a little lower with its base faded into the top. */
function drawSunk(ctx: AnyContext2D, l: ItemLayer, look: SinkLook, img: ImageBitmap, at: RoomBox, assets: RoomAssets, scale: number): void {
  const rect = sunkRect(at, look);
  const [x, y, w, h] = rect;
  const sh = contactShadow(l, look, baseOf(l, look, img, rect), w);
  ctx.save();
  ctx.translate(sh.cx, sh.cy);
  ctx.scale(1, sh.ry / sh.rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, sh.rx);
  g.addColorStop(0, `rgba(58, 44, 40, ${sh.alpha})`);
  g.addColorStop(0.55, `rgba(58, 44, 40, ${sh.alpha * 0.55})`);
  g.addColorStop(1, 'rgba(58, 44, 40, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(-sh.rx, -sh.rx, sh.rx * 2, sh.rx * 2);
  ctx.restore();
  // The sprite through a scratch at device px, its base erased by the fade.
  const pw = Math.max(1, Math.ceil(w * scale));
  const ph = Math.max(1, Math.ceil(h * scale));
  if (!sinkScratch || sinkScratch.c.width < pw || sinkScratch.c.height < ph) {
    const c = makeCanvas(Math.max(pw, sinkScratch?.c.width ?? 0), Math.max(ph, sinkScratch?.c.height ?? 0));
    sinkScratch = { c, ctx: ctx2d(c) };
  }
  const sc = sinkScratch.ctx;
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, pw, ph);
  sc.setTransform(pw / w, 0, 0, ph / h, -x * (pw / w), -y * (ph / h));
  drawPlain(sc, l, img, rect, assets, scale);
  sc.globalCompositeOperation = 'destination-out';
  // sinkKeep is linear from fadeTop (kept) to fadeEnd (gone): two stops draw it exactly.
  const fade = sc.createLinearGradient(0, look.fadeTop, 0, look.fadeEnd);
  fade.addColorStop(0, `rgba(0, 0, 0, ${1 - sinkKeep(look, look.fadeTop)})`);
  fade.addColorStop(1, `rgba(0, 0, 0, ${1 - sinkKeep(look, look.fadeEnd)})`);
  sc.fillStyle = fade;
  sc.fillRect(x, look.fadeTop, w, y + h - look.fadeTop + 1);
  sc.restore();
  ctx.drawImage(sinkScratch.c, 0, 0, pw, ph, x, y, w, h);
}

/**
 * Draw slot and item layers in order. `scale` = device px per canvas px of
 * ctx's current transform (used to size the tint scratch).
 */
export function drawRoomLayers(
  ctx: AnyContext2D,
  layers: ReadonlyArray<SlotLayer | ItemLayer>,
  canvas: readonly [number, number],
  assets: RoomAssets,
  scale: number,
  clip?: RoomBox,
): void {
  for (const l of layers) {
    const img = assets.images.get(l.frame.src);
    const rect = layerRect(l, canvas, assets);
    if (!img || !rect) continue;
    if (l.kind === 'slot' && l.clip?.length) {
      // A lip: only inside its polygons (and only that box goes through the tint scratch).
      const box = intersect(polygonsBox(l.clip), clip);
      if (box[2] <= 0 || box[3] <= 0) continue;
      ctx.save();
      clipTo(ctx, l.clip);
      drawPlain(ctx, l, img, rect, assets, scale, box);
      ctx.restore();
      continue;
    }
    // An item on a lipped top: only above the lip's top edge.
    const cut = l.kind === 'item' && l.clip?.length ? l.clip : null;
    if (cut) {
      ctx.save();
      clipTo(ctx, cut);
    }
    const look = l.kind === 'item' ? sinkLook(l) : null;
    if (l.kind === 'item' && look) {
      ctx.save();
      if (clip) {
        // A recolour repaints only `clip`: keep the shadow and sprite inside it too.
        ctx.beginPath();
        ctx.rect(clip[0], clip[1], clip[2], clip[3]);
        ctx.clip();
      }
      drawSunk(ctx, l, look, img, rect, assets, scale);
      ctx.restore();
    } else {
      drawPlain(ctx, l, img, rect, assets, scale, clip);
    }
    if (cut) ctx.restore();
  }
}

/** Intersect ctx's clip with the union of polygons (canvas px). */
function clipTo(ctx: AnyContext2D, polys: readonly RoomPolygon[]): void {
  ctx.beginPath();
  for (const p of polys) {
    p.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
  }
  ctx.clip();
}

let glowScratch: { c: AnyCanvas; ctx: AnyContext2D } | null = null;

/** A grey glow multiplied by a colour, at its own trimmed size (cached per glow + colour for still lights). */
function colouredGlow(glow: TrimmedGlow, colour: string): AnyCanvas | null {
  if (!glow.bitmap) return null;
  const { w, h } = glow;
  if (!glowScratch || glowScratch.c.width < w || glowScratch.c.height < h) {
    const c = makeCanvas(Math.max(w, glowScratch?.c.width ?? 0), Math.max(h, glowScratch?.c.height ?? 0));
    glowScratch = { c, ctx: ctx2d(c) };
  }
  const sc = glowScratch.ctx;
  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, w, h);
  sc.drawImage(glow.bitmap, 0, 0);
  sc.globalCompositeOperation = 'multiply';
  sc.fillStyle = colour;
  sc.fillRect(0, 0, w, h);
  sc.globalCompositeOperation = 'destination-in';
  sc.drawImage(glow.bitmap, 0, 0);
  sc.restore();
  return glowScratch.c;
}

/**
 * Draw glows (into a layer that is screen-blended over the scene). `alpha(g)`
 * is each glow's opacity; `colour(g)` (261105) the colour a light is lit in,
 * or null for the glow's own colours.
 */
export function drawRoomGlows(
  ctx: AnyContext2D,
  glows: ReadonlyArray<GlowLayer>,
  canvas: readonly [number, number],
  assets: RoomAssets,
  alpha: (g: GlowLayer) => number,
  colour: (g: GlowLayer) => string | null = (g) => g.tint ?? null,
): void {
  for (const g of glows) {
    const glow = assets.glows.get(g.src);
    const rect = layerRect(g.owner, canvas, assets);
    if (!glow?.bitmap || !rect) continue;
    const a = alpha(g);
    if (a <= 0.003) continue;
    const [x, y, w, h] = rect;
    const sx = w / glow.fw;
    const sy = h / glow.fh;
    const flip = g.owner.kind === 'item' && g.owner.flip;
    const gx = flip ? x + (glow.fw - glow.x - glow.w) * sx : x + glow.x * sx;
    ctx.globalAlpha = Math.min(1, a);
    const tint = colour(g);
    const grey = tint ? assets.glowsGrey?.get(g.src) : undefined;
    const lit = grey && tint ? colouredGlow(grey, tint) : null;
    const dest: RoomBox = [gx, y + glow.y * sy, glow.w * sx, glow.h * sy];
    if (lit && grey) {
      if (flip) {
        ctx.save();
        ctx.translate(dest[0] + dest[2], dest[1]);
        ctx.scale(-1, 1);
        ctx.drawImage(lit, 0, 0, grey.w, grey.h, 0, 0, dest[2], dest[3]);
        ctx.restore();
      } else {
        ctx.drawImage(lit, 0, 0, grey.w, grey.h, dest[0], dest[1], dest[2], dest[3]);
      }
    } else {
      drawFlipped(ctx, glow.bitmap, dest, flip);
    }
  }
  ctx.globalAlpha = 1;
}
