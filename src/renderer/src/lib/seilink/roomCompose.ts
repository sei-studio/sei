/**
 * SeiLink room compositing (261104). Draws draw-plan layers (shared/
 * seilinkDraw.ts) onto a 2D context whose transform maps canvas px to the
 * target's pixels. Used by RoomRenderer for its cached layers; the editor can
 * use it for thumbnails.
 *
 * Tint (format rule): inside the mask the frame is multiplied by the tint,
 * outside it is untouched, so the art's own shading stays:
 *   out = frame * (1 - m) + frame * tint * m,   m = mask luminance x alpha.
 */
import { itemRect, type GlowLayer, type ItemLayer, type RoomDrawPlan, type SlotLayer } from '@shared/seilinkDraw';
import type { RoomBox } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { ctx2d, loadRoomGlow, loadRoomImage, loadRoomMask, makeCanvas, maskBounds, type AnyCanvas, type AnyContext2D, type TrimmedGlow } from './roomImages';

export interface RoomAssets {
  images: Map<string, ImageBitmap>;
  masks: Map<string, ImageBitmap>;
  glows: Map<string, TrimmedGlow>;
}

export interface RoomAssetError {
  file: string;
  message: string;
}

/** Load everything a plan draws. Missing files are reported, not thrown: the rest still draws. */
export async function loadPlanAssets(plan: RoomDrawPlan, resolve: RoomUrlResolver, into?: RoomAssets): Promise<{ assets: RoomAssets; errors: RoomAssetError[] }> {
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
  }
  for (const g of plan.glows) want(assets.glows, g.src, loadRoomGlow);
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
function drawTinted(ctx: AnyContext2D, frame: ImageBitmap, mask: ImageBitmap, tint: string, rect: RoomBox, scale: number, flip = false, clip?: RoomBox): void {
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
  sc.fillStyle = tint;
  sc.fillRect(0, 0, sw, sh);
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
    if (l.tint && l.frame.mask) {
      const mask = assets.masks.get(l.frame.mask);
      if (mask) {
        drawTinted(ctx, img, mask, l.tint, rect, scale, l.kind === 'item' && l.flip, clip);
        continue;
      }
    }
    drawFlipped(ctx, img, rect, l.kind === 'item' && l.flip);
  }
}

/** Draw glows (into a layer that is screen-blended over the scene). `alpha(g)` is each glow's opacity. */
export function drawRoomGlows(
  ctx: AnyContext2D,
  glows: ReadonlyArray<GlowLayer>,
  canvas: readonly [number, number],
  assets: RoomAssets,
  alpha: (g: GlowLayer) => number,
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
    drawFlipped(ctx, glow.bitmap, [gx, y + glow.y * sy, glow.w * sx, glow.h * sy], flip);
  }
  ctx.globalAlpha = 1;
}
