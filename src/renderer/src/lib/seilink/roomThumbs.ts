/**
 * SeiLink editor thumbnails (261104, editor pass): the small "inventory"
 * icons of the room editor are drawn from the pack's own art, with the same
 * compositing the room uses (roomCompose), so a recoloured part shows its
 * colour in its tile.
 *
 *  - componentThumb: one part (slot frame or item sprite), trimmed to its
 *    visible pixels and fitted into a square with a little air around it;
 *  - roomThumb: a whole preset room (no avatar) at card size.
 *
 * Results are object URLs, cached by everything that changes the picture.
 */
import { roomDrawPlan, type ItemLayer, type SlotLayer } from '@shared/seilinkDraw';
import type { RoomComponent, RoomPresetManifest, RoomState, RoomTime } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { drawRoomGlows, drawRoomLayers, loadPlanAssets, type RoomAssets } from './roomCompose';
import { ctx2d, loadRoomImage, loadRoomMask, makeCanvas, type AnyCanvas } from './roomImages';

const cache = new Map<string, Promise<string>>();
const MAX = 240;

function remember(key: string, make: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = make();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value as string;
    const old = cache.get(oldest);
    cache.delete(oldest);
    void old?.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return p;
}

async function toUrl(c: AnyCanvas): Promise<string> {
  if ('convertToBlob' in c) return URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }));
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('thumbnail encode failed');
  return URL.createObjectURL(blob);
}

/** Visible bounds (alpha > 8) of a small canvas, or null when empty. */
function trim(c: AnyCanvas): [number, number, number, number] | null {
  const ctx = ctx2d(c, { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** Draw `src` (a region of it) contained in a `size` square, `pad` px of air. */
function fitSquare(src: AnyCanvas, region: [number, number, number, number], size: number, pad: number): AnyCanvas {
  const out = makeCanvas(size, size);
  const ctx = ctx2d(out);
  const [x, y, w, h] = region;
  const s = Math.min((size - pad * 2) / w, (size - pad * 2) / h);
  const dw = w * s;
  const dh = h * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h, (size - dw) / 2, (size - dh) / 2, dw, dh);
  return out;
}

/** Long thin parts (a rug, a floor lamp) would be slivers in a square: show their middle (wide) or top (tall) instead. */
const MAX_ASPECT = 1.7;

function limitAspect([x, y, w, h]: [number, number, number, number]): [number, number, number, number] {
  if (w / h > MAX_ASPECT) {
    const nw = h * MAX_ASPECT;
    return [x + (w - nw) / 2, y, nw, h];
  }
  if (h / w > MAX_ASPECT) return [x, y, w, w * MAX_ASPECT];
  return [x, y, w, h];
}

/**
 * A part's icon. `cover` fills the square with the part's middle instead of
 * fitting all of it (used for the window view and the walls, which are
 * scenes rather than objects).
 */
export function componentThumb(
  manifest: RoomPresetManifest,
  component: RoomComponent,
  opts: { time: RoomTime; tint: string | null; resolve: RoomUrlResolver; size?: number; cover?: boolean },
): Promise<string> {
  const size = opts.size ?? 112;
  const frame = component.frames[opts.time] ?? component.frames.day;
  const key = `c:${manifest.id}:${opts.resolve(frame.src)}:${opts.tint ?? ''}:${size}:${opts.cover ? 1 : 0}`;
  return remember(key, async () => {
    const assets: RoomAssets = { images: new Map(), masks: new Map(), glows: new Map() };
    const img = await loadRoomImage(opts.resolve(frame.src));
    assets.images.set(frame.src, img);
    const tint = component.tintable && frame.mask && opts.tint ? opts.tint : null;
    if (tint && frame.mask) assets.masks.set(frame.mask, await loadRoomMask(opts.resolve(frame.mask)));
    // Work at about 4x the icon size: enough detail, cheap to scan.
    let work: AnyCanvas;
    if (component.slot === 'item') {
      const [w0, h0] = component.box ? [component.box[2], component.box[3]] : [img.width, img.height];
      const s = Math.min(1, (size * 4) / Math.max(w0, h0));
      work = makeCanvas(w0 * s, h0 * s);
      const ctx = ctx2d(work);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      const layer: ItemLayer = { kind: 'item', z: 0, index: 0, component, frame, x: w0 / 2, y: h0, scale: 1, flip: false, size: [w0, h0], tint };
      drawRoomLayers(ctx, [layer], manifest.canvas, assets, s);
    } else {
      const [cw, ch] = manifest.canvas;
      const s = Math.min(1, (size * 5) / Math.max(cw, ch));
      work = makeCanvas(cw * s, ch * s);
      const ctx = ctx2d(work);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      const layer: SlotLayer = { kind: 'slot', z: 0, slot: component.slot, component, frame, tint, box: component.box ?? null };
      drawRoomLayers(ctx, [layer], manifest.canvas, assets, s);
    }
    const bounds = trim(work) ?? [0, 0, work.width, work.height];
    if (opts.cover) {
      const [x, y, w, h] = bounds;
      const side = Math.min(w, h);
      return toUrl(fitSquare(work, [x + (w - side) / 2, y + (h - side) / 2, side, side], size, 0));
    }
    return toUrl(fitSquare(work, limitAspect(bounds), size, Math.round(size * 0.04)));
  });
}

/** A whole room (no avatar) at `width` px, for the room type cards. */
export function roomThumb(
  manifest: RoomPresetManifest,
  state: RoomState,
  opts: { time: RoomTime; resolve: RoomUrlResolver; width?: number; rev?: string | number },
): Promise<string> {
  const width = opts.width ?? 360;
  const key = `r:${manifest.id}:${opts.rev ?? ''}:${opts.resolve('x.webp')}:${JSON.stringify({ ...state, time: null })}:${opts.time}:${width}`;
  return remember(key, async () => {
    const plan = roomDrawPlan(manifest, state, opts.time, { avatar: false });
    const { assets } = await loadPlanAssets(plan, opts.resolve);
    const [cw, ch] = manifest.canvas;
    const s = width / cw;
    const c = makeCanvas(width, ch * s);
    const ctx = ctx2d(c);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    const layers = plan.layers.filter((l): l is SlotLayer | ItemLayer => l.kind !== 'avatar');
    drawRoomLayers(ctx, layers, manifest.canvas, assets, s);
    ctx.globalCompositeOperation = 'screen';
    drawRoomGlows(ctx, plan.glows, manifest.canvas, assets, () => 1);
    return toUrl(c);
  });
}
