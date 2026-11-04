/**
 * SeiLink look(): her room as one picture, WITHOUT her in it (261104).
 *
 * Composes a preset's pack layers in the main process with sharp, following
 * the draw rules in src/shared/seilinkRoom.ts:
 *   1. slots by z ascending (resolveSlots), each component's frame for the
 *      room's time of day (a missing time falls back to day), full-canvas at
 *      (0,0) unless the component has a box;
 *   2. a tintable frame with a mask is recoloured inside the mask by
 *      multiplying with the tint, so the frame's own shading stays;
 *   3. the avatar would sit at AVATAR_Z: it is NEVER drawn here. The picture
 *      is what she would see of her room, and she is not part of it;
 *   4. items, by their own z (stable in placement order);
 *   5. every frame's glow layer last, with 'screen'.
 *
 * The whole composite runs at OUTPUT size (1024 px wide by default), not at
 * the 2560 px canvas, so tinting is a few hundred thousand pixels and the
 * picture costs the model about 800 visual tokens.
 *
 * sharp is loaded through bundleRequire (packaged ESM main has no ambient
 * require, and a cwd-anchored one resolves from `/` in Finder launches; see
 * bundleRequire.ts). It is a transitive dependency of img2skin, resolved the
 * same way uniqueGeneration.ts resolves it.
 */
import path from 'node:path';
import { bundleRequire } from '../bundleRequire';
import { resolveRoomTime, resolveSlots, type RoomComponent, type RoomFrame, type RoomTime } from '../../shared/seilinkRoom';
import type { RoomContext } from './types';

/** Output width of the look() picture. Height follows the preset's canvas aspect. */
export const ROOM_LOOK_WIDTH = 1024;
export const ROOM_LOOK_JPEG_QUALITY = 80;

export interface RoomImage {
  data: Buffer;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

// ── sharp (minimal surface, so the module does not need sharp's types) ─────

interface RawOut {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}
interface SharpImage {
  resize(w: number, h: number, o?: { fit?: string }): SharpImage;
  flop(): SharpImage;
  ensureAlpha(): SharpImage;
  extract(r: { left: number; top: number; width: number; height: number }): SharpImage;
  raw(): SharpImage;
  composite(layers: Array<Record<string, unknown>>): SharpImage;
  flatten(o?: { background?: string }): SharpImage;
  jpeg(o?: { quality?: number }): SharpImage;
  metadata(): Promise<{ width?: number; height?: number }>;
  toBuffer(): Promise<Buffer>;
  toBuffer(o: { resolveWithObject: true }): Promise<RawOut>;
}
type SharpFn = (input?: unknown, opts?: Record<string, unknown>) => SharpImage;

let sharpMod: SharpFn | null | undefined;

function loadSharp(): SharpFn | null {
  if (sharpMod !== undefined) return sharpMod;
  const req = bundleRequire();
  const tries: Array<() => string> = [
    () => req.resolve('sharp', { paths: [path.dirname(req.resolve('img2skin/package.json'))] }),
    () => req.resolve('sharp'),
  ];
  for (const resolve of tries) {
    try {
      const m = req(resolve()) as SharpFn | { default: SharpFn };
      sharpMod = typeof m === 'function' ? m : m.default;
      return sharpMod;
    } catch {
      /* try the next */
    }
  }
  sharpMod = null;
  return null;
}

// ── layers ──────────────────────────────────────────────────────────────

interface Layer {
  data: Buffer; // raw RGBA
  width: number;
  height: number;
  left: number;
  top: number;
  blend?: 'screen';
}

/** A pack-relative path, refused when it climbs out of the pack. */
function packFile(packDir: string, rel: string): string | null {
  const root = path.resolve(packDir);
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function frameFor(c: RoomComponent, time: RoomTime): RoomFrame {
  return c.frames[time] ?? c.frames.day;
}

async function rawOf(sharp: SharpFn, file: string, w: number, h: number, flip = false): Promise<Buffer> {
  let img = sharp(file).resize(w, h, { fit: 'fill' });
  if (flip) img = img.flop();
  const out = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return out.data;
}

/** Multiply the frame by `tint` where the mask is white (luminance x alpha). In place. */
export function applyTint(frame: Buffer, mask: Buffer, tint: [number, number, number]): void {
  for (let i = 0; i < frame.length; i += 4) {
    const m = ((mask[i] * 0.299 + mask[i + 1] * 0.587 + mask[i + 2] * 0.114) / 255) * (mask[i + 3] / 255);
    if (m <= 0) continue;
    for (let k = 0; k < 3; k++) frame[i + k] = Math.round(frame[i + k] * (1 - m + (m * tint[k]) / 255));
  }
}

function hexRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Clip a layer to the output canvas (sharp refuses overlays that hang off the edge). */
async function clipped(sharp: SharpFn, l: Layer, W: number, H: number): Promise<Layer | null> {
  const x0 = Math.max(0, l.left), y0 = Math.max(0, l.top);
  const x1 = Math.min(W, l.left + l.width), y1 = Math.min(H, l.top + l.height);
  if (x1 <= x0 || y1 <= y0) return null;
  if (x0 === l.left && y0 === l.top && x1 - x0 === l.width && y1 - y0 === l.height) return l;
  const out = await sharp(l.data, { raw: { width: l.width, height: l.height, channels: 4 } })
    .extract({ left: x0 - l.left, top: y0 - l.top, width: x1 - x0, height: y1 - y0 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { ...l, data: out.data, width: x1 - x0, height: y1 - y0, left: x0, top: y0 };
}

/**
 * Compose her room as a JPEG, without her. Throws only when sharp is missing;
 * a missing or unreadable layer is skipped (logged) so one bad file costs that
 * layer, not the look.
 */
export async function renderRoomImage(
  ctx: RoomContext,
  opts: { now?: Date; width?: number; quality?: number } = {},
): Promise<RoomImage> {
  const sharp = loadSharp();
  if (!sharp) throw new Error('sharp is not available');
  const { manifest, state, packDir } = ctx;
  const time = resolveRoomTime(state, opts.now ?? new Date());
  const [cw, ch] = manifest.canvas;
  const W = Math.max(1, Math.round(opts.width ?? ROOM_LOOK_WIDTH));
  const s = W / cw;
  const H = Math.max(1, Math.round(ch * s));

  const layers: Layer[] = [];
  const glows: Layer[] = [];

  const addFrame = async (c: RoomComponent, tint: string | undefined, place: { left: number; top: number; width: number; height: number; flip?: boolean }): Promise<void> => {
    const f = frameFor(c, time);
    const src = packFile(packDir, f.src);
    if (!src) return void console.warn(`[seilink/look] ${c.id}: frame path leaves the pack, skipped`);
    try {
      const data = await rawOf(sharp, src, place.width, place.height, place.flip);
      const rgb = c.tintable ? hexRgb(tint ?? c.defaultTint) : null;
      const maskFile = f.mask ? packFile(packDir, f.mask) : null;
      if (rgb && maskFile) applyTint(data, await rawOf(sharp, maskFile, place.width, place.height, place.flip), rgb);
      layers.push({ data, width: place.width, height: place.height, left: place.left, top: place.top });
      const glowFile = f.glow ? packFile(packDir, f.glow) : null;
      if (glowFile) {
        glows.push({ data: await rawOf(sharp, glowFile, place.width, place.height, place.flip), width: place.width, height: place.height, left: place.left, top: place.top, blend: 'screen' });
      }
    } catch (err) {
      console.warn(`[seilink/look] ${c.id}: layer skipped (${(err as Error).message})`);
    }
  };

  const fullOrBox = (c: RoomComponent) =>
    c.box
      ? { left: Math.round(c.box[0] * s), top: Math.round(c.box[1] * s), width: Math.max(1, Math.round(c.box[2] * s)), height: Math.max(1, Math.round(c.box[3] * s)) }
      : { left: 0, top: 0, width: W, height: H };

  // 1-2. Slots by z, tinted. The avatar (AVATAR_Z) is deliberately absent.
  for (const { component, tint } of resolveSlots(manifest, state)) {
    await addFrame(component, tint, fullOrBox(component));
  }

  // 4. Items by their own z, stable in placement order. (x, y) is the item's
  // top-left on the canvas; its size is its box, else its art's own size, times scale.
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const items = state.items
    .map((it, i) => ({ it, i, c: byId.get(it.id) }))
    .filter((x): x is { it: (typeof state.items)[number]; i: number; c: RoomComponent } => Boolean(x.c))
    .sort((a, b) => (a.c.z ?? 0) - (b.c.z ?? 0) || a.i - b.i);
  for (const { it, c } of items) {
    let w: number, h: number;
    if (c.box) {
      w = c.box[2];
      h = c.box[3];
    } else {
      const src = packFile(packDir, frameFor(c, time).src);
      const meta = src ? await sharp(src).metadata().catch(() => ({} as { width?: number; height?: number })) : {};
      if (!meta.width || !meta.height) continue;
      w = meta.width;
      h = meta.height;
    }
    const k = (it.scale ?? 1) * s;
    await addFrame(c, undefined, {
      left: Math.round(it.x * s),
      top: Math.round(it.y * s),
      width: Math.max(1, Math.round(w * k)),
      height: Math.max(1, Math.round(h * k)),
      flip: it.flip === true,
    });
  }

  // 5. Glow last.
  const overlays: Array<Record<string, unknown>> = [];
  for (const l of [...layers, ...glows]) {
    const c = await clipped(sharp, l, W, H);
    if (!c) continue;
    overlays.push({ input: c.data, raw: { width: c.width, height: c.height, channels: 4 }, left: c.left, top: c.top, ...(c.blend ? { blend: c.blend } : {}) });
  }
  const data = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite(overlays)
    .flatten({ background: '#000000' })
    .jpeg({ quality: opts.quality ?? ROOM_LOOK_JPEG_QUALITY })
    .toBuffer();
  return { data, mediaType: 'image/jpeg', width: W, height: H };
}
