/**
 * SeiLink look(): her room as one picture, WITHOUT her in it (261104).
 *
 * Composes a preset's pack layers in the main process with sharp, from the
 * SAME draw plan the host's RoomCanvas follows (roomDrawPlan in
 * src/shared/seilinkDraw.ts), so the picture she sees and the room the
 * player sees cannot drift apart:
 *   - layers in plan order (slots and items interleaved by z, ties slot
 *     first), each frame for the room's time of day;
 *   - a slot is full-canvas at (0,0) unless its component has a box; a
 *     tinted slot (layer.tint) is recoloured inside its mask by multiplying,
 *     so the frame's own shading stays;
 *   - an item sits on its BOTTOM CENTRE (itemRect), natural size or box
 *     times scale, mirrored when flipped;
 *   - a lip layer (a slot with `clip`) is kept only inside its polygons; an
 *     item on a soft top (`sink`) has its base faded into the top over a
 *     soft contact shadow, by the same sinkLook / sinkKeep / contactShadow
 *     rules the renderer uses;
 *   - glows last, with 'screen', on their owner's placement.
 * The plan is built with `avatar: false`: she is never drawn here. The
 * picture is what she would see of her room, and she is not part of it.
 * Glow effects (flicker, pulse) are animation only: a still picture draws
 * them at full strength.
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
import { resolveRoomTime } from '../../shared/seilinkRoom';
import { baseSpan, contactShadow, itemRect, roomDrawPlan, sinkKeep, sinkLook, type ItemLayer, type SlotLayer } from '../../shared/seilinkDraw';
import { pointInPolygon } from '../../shared/seilinkPlace';
import type { RoomPolygon } from '../../shared/seilinkRoom';
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

interface Place {
  left: number;
  top: number;
  width: number;
  height: number;
  flip?: boolean;
}

/** A layer's pixels (at `place`, output px) cut to polygons (canvas px; `s` = output px per canvas px): only their bounds are kept. */
export function cutToPolygons(data: Buffer, place: Place, polys: readonly RoomPolygon[], s: number): Layer | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const left = Math.max(place.left, Math.floor(x0 * s));
  const top = Math.max(place.top, Math.floor(y0 * s));
  const right = Math.min(place.left + place.width, Math.ceil(x1 * s));
  const bottom = Math.min(place.top + place.height, Math.ceil(y1 * s));
  if (right <= left || bottom <= top) return null;
  const w = right - left;
  const h = bottom - top;
  const out = Buffer.alloc(w * h * 4);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const cx = (left + u + 0.5) / s;
      const cy = (top + v + 0.5) / s;
      if (!polys.some((p) => pointInPolygon(p, cx, cy))) continue;
      const from = ((top - place.top + v) * place.width + (left - place.left + u)) * 4;
      data.copy(out, (v * w + u) * 4, from, from + 4);
    }
  }
  return { data: out, width: w, height: h, left, top };
}

/**
 * A sunk item: its place moved down by the sink (returned), its base faded
 * (in place) and its soft contact shadow as a layer to draw under it.
 * null when the item is not on a soft top.
 */
export function sinkItem(l: ItemLayer, data: Buffer, at: Place, s: number): { place: Place; shadow: Layer } | null {
  const look = sinkLook(l);
  if (!look) return null;
  const place = { ...at, top: at.top + Math.round(look.shift * s) };
  const rect: [number, number, number, number] = [place.left / s, place.top / s, place.width / s, place.height / s];
  // Measure the base before fading it (flip is already in the pixels, so read them unflipped).
  const base = baseSpan({ ...l, flip: false }, look, [place.width, place.height], rect, (u, v) => data[(v * place.width + u) * 4 + 3]);
  for (let v = 0; v < place.height; v++) {
    const k = sinkKeep(look, (place.top + v + 0.5) / s);
    if (k >= 1) continue;
    for (let u = 0; u < place.width; u++) {
      const i = (v * place.width + u) * 4 + 3;
      data[i] = Math.round(data[i] * k);
    }
  }
  const sh = contactShadow(l, look, base, rect[2]);
  const left = Math.floor((sh.cx - sh.rx) * s);
  const top = Math.floor((sh.cy - sh.ry) * s);
  const w = Math.max(1, Math.ceil(sh.rx * 2 * s));
  const h = Math.max(1, Math.ceil(sh.ry * 2 * s));
  const out = Buffer.alloc(w * h * 4);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const dx = ((left + u + 0.5) / s - sh.cx) / sh.rx;
      const dy = ((top + v + 0.5) / s - sh.cy) / sh.ry;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= 1) continue;
      const a = r < 0.55 ? 1 - (0.45 * r) / 0.55 : 0.55 * (1 - (r - 0.55) / 0.45);
      const i = (v * w + u) * 4;
      out[i] = 58;
      out[i + 1] = 44;
      out[i + 2] = 40;
      out[i + 3] = Math.round(255 * sh.alpha * a);
    }
  }
  return { place, shadow: { data: out, width: w, height: h, left, top } };
}

/** A slot: its box, else the whole canvas, in output px. */
function slotPlace(l: SlotLayer, s: number, W: number, H: number): Place {
  if (!l.box) return { left: 0, top: 0, width: W, height: H };
  const [x, y, w, h] = l.box;
  return { left: Math.round(x * s), top: Math.round(y * s), width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** An item: bottom-centre anchored (itemRect), natural size unless boxed. null = unreadable art. */
async function itemPlace(sharp: SharpFn, l: ItemLayer, src: string, s: number): Promise<Place | null> {
  let natural: [number, number] = [0, 0];
  if (!l.size) {
    const meta = await sharp(src).metadata().catch(() => ({}) as { width?: number; height?: number });
    if (!meta.width || !meta.height) return null;
    natural = [meta.width, meta.height];
  }
  const [x, y, w, h] = itemRect(l, natural);
  return { left: Math.round(x * s), top: Math.round(y * s), width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), flip: l.flip };
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

  const plan = roomDrawPlan(manifest, state, time, { avatar: false });
  /** Output-px placement of each drawn layer, so its glow lands on it. */
  const placed = new Map<SlotLayer | ItemLayer, Place>();

  // Decode every layer at once (sharp works on libuv's pool), keep plan order.
  const drawn = await Promise.all(
    plan.layers.map(async (l): Promise<Layer | Layer[] | null> => {
      if (l.kind === 'avatar') return null; // never present (avatar: false); she is not in the picture
      const id = l.component.id;
      const src = packFile(packDir, l.frame.src);
      if (!src) {
        console.warn(`[seilink/look] ${id}: frame path leaves the pack, skipped`);
        return null;
      }
      try {
        const place = l.kind === 'slot' ? slotPlace(l, s, W, H) : await itemPlace(sharp, l, src, s);
        if (!place) return null;
        const rgb = hexRgb(l.tint ?? undefined);
        const maskFile = rgb && l.frame.mask ? packFile(packDir, l.frame.mask) : null;
        const [data, mask] = await Promise.all([
          rawOf(sharp, src, place.width, place.height, place.flip),
          maskFile ? rawOf(sharp, maskFile, place.width, place.height, place.flip) : null,
        ]);
        if (rgb && mask) applyTint(data, mask, rgb);
        placed.set(l, place);
        if (l.kind === 'slot' && l.clip?.length) return cutToPolygons(data, place, l.clip, s);
        const sunk = l.kind === 'item' ? sinkItem(l, data, place, s) : null;
        if (!sunk) return { data, ...place };
        placed.set(l, sunk.place);
        return [sunk.shadow, { data, ...sunk.place }];
      } catch (err) {
        console.warn(`[seilink/look] ${id}: layer skipped (${(err as Error).message})`);
        return null;
      }
    }),
  );

  // Glows over everything, on their owner's placement.
  const glows = await Promise.all(
    plan.glows.map(async (g): Promise<Layer | null> => {
      const place = placed.get(g.owner);
      const file = place ? packFile(packDir, g.src) : null;
      if (!place || !file) return null;
      try {
        return { data: await rawOf(sharp, file, place.width, place.height, place.flip), ...place, blend: 'screen' };
      } catch (err) {
        console.warn(`[seilink/look] ${g.owner.component.id}: glow skipped (${(err as Error).message})`);
        return null;
      }
    }),
  );

  const overlays: Array<Record<string, unknown>> = [];
  for (const l of [...drawn.flat(), ...glows]) {
    if (!l) continue;
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
