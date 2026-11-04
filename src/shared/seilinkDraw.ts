/**
 * SeiLink draw plan (261104, host pass). Pure: no DOM, no Node. The room
 * renderer (RoomCanvas), the editor and the AI's look() composite all draw
 * from the same plan, so the three can never disagree about what is where.
 *
 * Rules (seilinkRoom.ts has the format):
 *  - one entry per filled slot, the avatar at AVATAR_Z, one per placed item,
 *    sorted by z; ties: slots, then the avatar, then items, each in input
 *    order (stable sort);
 *  - slot frames are full canvas at (0,0) unless the component has a box;
 *  - item sprites sit with their bottom centre on (x, y), scaled, maybe
 *    mirrored; a floor item's scale includes its depth scale and its z grows
 *    with y, a surface item takes the z of the part it rests on
 *    (seilinkPlace.ts);
 *  - a surface top with a `lip` (261105 shelf pass) that has items on it
 *    adds one more slot layer: its part's frame cut to the lip polygon
 *    (`clip`), at the top of that top's z slice, so it covers the base of
 *    the items on it and nothing else (seilinkPlace.ts has the slices). The
 *    lip is the whole visible plank below its top face, so the plank's
 *    front, end and underside all draw over an item tucked behind it; the
 *    items on it are themselves cut to above the plank's bottom edge (their
 *    `clip`), so nothing of them shows under a thin plank;
 *  - an item on a soft top (`sink`) carries how its base settles in
 *    (ItemLayer.sink): the renderers draw it a little lower, fade its base
 *    out just under the top's surface and lay a soft contact shadow under
 *    it (sinkLook, sunkRect, sinkKeep, contactShadow);
 *  - a frame for a time the component does not have falls back to day;
 *  - glows are listed separately: they are drawn with 'screen' over
 *    everything, the avatar included, in the same z order.
 */
import {
  AVATAR_Z,
  ITEM_Z,
  resolveSlots,
  roomTimeAt,
  type RoomBox,
  type RoomComponent,
  type RoomFrame,
  type RoomGlowEffect,
  type RoomPolygon,
  type RoomPresetManifest,
  type RoomSlotId,
  type RoomState,
  type RoomTime,
} from './seilinkRoom';
import { contactY, depthScale, placedItemZ, placementOf, placementRegions, surfaceAt } from './seilinkPlace';

export interface SlotLayer {
  kind: 'slot';
  z: number;
  slot: RoomSlotId;
  component: RoomComponent;
  frame: RoomFrame;
  /** Tint to apply through frame.mask (only for tintable components with a mask). */
  tint: string | null;
  /** Where to draw, canvas px. null = full canvas at (0,0). */
  box: RoomBox | null;
  /** Draw only inside these polygons, canvas px (a top's lip over the items on it). Absent = all of it. */
  clip?: RoomPolygon[];
}

export interface AvatarLayer {
  kind: 'avatar';
  z: number;
  /** Bottom centre and height of her body, canvas px. */
  x: number;
  y: number;
  height: number;
}

export interface ItemLayer {
  kind: 'item';
  z: number;
  /** Index into state.items (the editor selects by it). */
  index: number;
  component: RoomComponent;
  frame: RoomFrame;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  /** Fixed sprite size from the component's box (w, h); null = natural image size. */
  size: [number, number] | null;
  /** Tint through frame.mask (tintable items with a mask), like SlotLayer.tint. */
  tint: string | null;
  /**
   * On a soft top (a duvet): canvas px its base settles in (`depth`) and from
   * its anchor up to its contact (`foot`), both at its scale. null = a hard top.
   */
  sink?: { depth: number; foot: number } | null;
  /**
   * Draw only inside these polygons, canvas px: on a top with a lip, the
   * region above the plank's bottom edge (AreaSurface.keep); the lip drawn
   * over the item hides the rest of its base. Absent = all of it.
   */
  clip?: RoomPolygon[];
}

export type RoomLayer = SlotLayer | AvatarLayer | ItemLayer;

export interface GlowLayer {
  z: number;
  src: string;
  effect: RoomGlowEffect | null;
  /** Same placement as its owner. */
  owner: SlotLayer | ItemLayer;
}

export interface RoomDrawPlan {
  canvas: [number, number];
  time: RoomTime;
  layers: RoomLayer[];
  glows: GlowLayer[];
}

const KIND_RANK: Record<RoomLayer['kind'], number> = { slot: 0, avatar: 1, item: 2 };

/** A component's frame for `time`, day when it has none. */
export function frameFor(component: RoomComponent, time: RoomTime): RoomFrame {
  return component.frames[time] ?? component.frames.day;
}

/** z of a placed item: the placement's, the component's, or the placement default. */
export function itemZ(component: RoomComponent, placementZ?: number): number {
  if (typeof placementZ === 'number' && Number.isFinite(placementZ)) return placementZ;
  if (typeof component.z === 'number') return component.z;
  return ITEM_Z[component.placement ?? 'floor'];
}

export function roomDrawPlan(
  manifest: RoomPresetManifest,
  state: RoomState,
  time: RoomTime,
  opts: { avatar?: boolean } = {},
): RoomDrawPlan {
  const layers: RoomLayer[] = [];
  for (const { slot, component, tint } of resolveSlots(manifest, state)) {
    const frame = frameFor(component, time);
    layers.push({
      kind: 'slot',
      z: manifest.slots[slot]!.z,
      slot,
      component,
      frame,
      tint: component.tintable && frame.mask && tint ? tint : null,
      box: component.box ?? null,
    });
  }
  if (opts.avatar !== false) {
    layers.push({ kind: 'avatar', z: AVATAR_Z, x: manifest.avatar.x, y: manifest.avatar.y, height: manifest.avatar.height });
  }
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const regions = state.items.length ? placementRegions(manifest, state) : null;
  /** Tops with a lip that hold an item (index into regions.surfaces). */
  const lipped = new Set<number>();
  state.items.forEach((it, index) => {
    const component = byId.get(it.id);
    if (!component || component.slot !== 'item' || !regions) return;
    const frame = frameFor(component, time);
    const tint = it.tint ?? component.defaultTint;
    const manual = typeof it.scale === 'number' && it.scale > 0 ? it.scale : 1;
    const scale = manual * depthScale(regions, component, it.y);
    let sink: ItemLayer['sink'] = null;
    let clip: RoomPolygon[] | undefined;
    if (placementOf(component) === 'surface') {
      const on = surfaceAt(regions, it.x, contactY(regions, component, it));
      const top = on >= 0 ? regions.surfaces[on] : null;
      if (top?.kind === 'area') {
        if (top.lip) lipped.add(on);
        if (top.keep) clip = [top.keep];
        if (top.sink > 0) sink = { depth: top.sink * scale, foot: Math.max(0, component.foot ?? 0) * scale };
      }
    }
    layers.push({
      kind: 'item',
      z: placedItemZ(regions, component, it),
      index,
      component,
      frame,
      x: it.x,
      y: it.y,
      scale,
      flip: it.flip === true,
      size: component.box ? [component.box[2], component.box[3]] : null,
      tint: component.tintable && frame.mask && tint ? tint : null,
      sink,
      ...(clip ? { clip } : {}),
    });
  });
  // Each used lip: its part's frame again, cut to the lip, just over the items on that top.
  for (const i of lipped) {
    const top = regions!.surfaces[i];
    if (top.kind !== 'area' || !top.lip) continue;
    const part = layers.find((l): l is SlotLayer => l.kind === 'slot' && l.slot === top.slot && !l.clip);
    if (part) layers.push({ ...part, z: top.band[1], clip: [top.lip] });
  }
  const order = layers.map((l, i) => ({ l, i }));
  order.sort((a, b) => a.l.z - b.l.z || KIND_RANK[a.l.kind] - KIND_RANK[b.l.kind] || a.i - b.i);
  const sorted = order.map((o) => o.l);
  const glows: GlowLayer[] = [];
  for (const l of sorted) {
    // A lip is its part drawn again in part: the part's own layer carries the glow.
    if (l.kind === 'avatar' || !l.frame.glow || (l.kind === 'slot' && l.clip)) continue;
    glows.push({ z: l.z, src: l.frame.glow, effect: l.frame.effect ?? null, owner: l });
  }
  return { canvas: manifest.canvas, time, layers: sorted, glows };
}

/** Split a plan at the avatar: what is behind her and what is in front. */
export function splitAtAvatar(plan: RoomDrawPlan): { back: Array<SlotLayer | ItemLayer>; front: Array<SlotLayer | ItemLayer> } {
  const back: Array<SlotLayer | ItemLayer> = [];
  const front: Array<SlotLayer | ItemLayer> = [];
  let seen = false;
  for (const l of plan.layers) {
    if (l.kind === 'avatar') {
      seen = true;
      continue;
    }
    (seen ? front : back).push(l);
  }
  return { back, front };
}

/** Every pack file a plan draws (frames, masks, glows), deduped, for preloading. */
export function planFiles(plan: RoomDrawPlan): string[] {
  const out = new Set<string>();
  for (const l of plan.layers) {
    if (l.kind === 'avatar') continue;
    out.add(l.frame.src);
    if (l.tint && l.frame.mask) out.add(l.frame.mask);
    if (l.frame.glow) out.add(l.frame.glow);
  }
  return [...out];
}

/**
 * Destination rect of an item sprite in canvas px, given the sprite's natural
 * size (used when the component has no box).
 */
export function itemRect(layer: ItemLayer, natural: [number, number]): RoomBox {
  const [w0, h0] = layer.size ?? natural;
  const w = w0 * layer.scale;
  const h = h0 * layer.scale;
  return [layer.x - w / 2, layer.y - h, w, h];
}

// ── Soft tops ───────────────────────────────────────────────────────────────

/**
 * How a sunk item meets a soft top, canvas px. The sprite is drawn `shift`
 * px lower than its anchor says, so its base goes below the top's surface at
 * `contact` (where the object would touch it), and its pixels fade out from
 * `fadeTop` (as is) to `fadeEnd` (gone): the base disappears into the duvet
 * just under the surface line instead of perching on it.
 */
export interface SinkLook {
  shift: number;
  fadeTop: number;
  contact: number;
  fadeEnd: number;
}

export function sinkLook(layer: ItemLayer): SinkLook | null {
  const s = layer.sink;
  if (!s || !(s.depth > 0)) return null;
  const contact = layer.y - s.foot;
  return { shift: s.depth, fadeTop: contact - s.depth * 0.35, contact, fadeEnd: contact + Math.max(1, s.depth * 0.2) };
}

/** Opacity multiplier of a sunk sprite at canvas y: 1 above fadeTop, 0 from fadeEnd, linear between. */
export function sinkKeep(look: SinkLook, y: number): number {
  if (y <= look.fadeTop) return 1;
  if (y >= look.fadeEnd) return 0;
  return (look.fadeEnd - y) / Math.max(1e-6, look.fadeEnd - look.fadeTop);
}

/** Where a sunk item's sprite is drawn: its rect moved down by the sink. */
export function sunkRect(rect: RoomBox, look: SinkLook): RoomBox {
  return [rect[0], rect[1] + look.shift, rect[2], rect[3]];
}

/**
 * The soft contact shadow under a sunk item: an ellipse at its contact as wide
 * as its base (`base`: canvas x span of the sprite's opaque pixels just above
 * the contact; null = a guess from the sprite width), darkest in the middle.
 */
export function contactShadow(layer: ItemLayer, look: SinkLook, base: [number, number] | null, spriteW: number): { cx: number; cy: number; rx: number; ry: number; alpha: number } {
  const [x0, x1] = base ?? [layer.x - spriteW * 0.3, layer.x + spriteW * 0.3];
  const rx = Math.max(4, (x1 - x0) / 2 + 3);
  return { cx: (x0 + x1) / 2, cy: look.contact, rx, ry: Math.max(3, rx * 0.12 + look.shift * 0.3), alpha: 0.32 };
}

/**
 * Canvas x span of an item's base: the opaque run of its sprite on the first
 * row (going up from where it fades out) that has one. `alphaAt(u, v)` reads
 * the sprite's alpha at sprite px; `size` is the sprite's px size, `rect`
 * where it is drawn (sunkRect). null when no row near the base is opaque.
 */
export function baseSpan(
  layer: ItemLayer,
  look: SinkLook,
  size: [number, number],
  rect: RoomBox,
  alphaAt: (u: number, v: number) => number,
): [number, number] | null {
  const [sw, sh] = size;
  const [rx, ry, rw, rh] = rect;
  if (!(sw > 0 && sh > 0 && rw > 0 && rh > 0)) return null;
  const toV = (y: number): number => Math.floor(((y - ry) / rh) * sh);
  const vContact = Math.min(sh - 1, toV(look.fadeEnd));
  const vStop = Math.max(0, toV(look.fadeTop - look.shift * 2));
  for (let v = vContact; v >= vStop; v--) {
    let u0 = -1;
    let u1 = -1;
    for (let u = 0; u < sw; u++) {
      if (alphaAt(u, v) > 140) {
        if (u0 < 0) u0 = u;
        u1 = u;
      }
    }
    if (u0 >= 0) {
      let a = rx + (u0 / sw) * rw;
      let b = rx + ((u1 + 1) / sw) * rw;
      if (layer.flip) [a, b] = [rx + rw - (b - rx), rx + rw - (a - rx)];
      return [a, b];
    }
  }
  return null;
}

// ── Time of day ─────────────────────────────────────────────────────────────

/** Minutes a clock change of room time takes to crossfade. */
export const ROOM_TIME_FADE_MIN = 30;

/** Clock boundaries (hours) where roomTimeAt changes, with the time it changes to. */
const BOUNDARIES: Array<[number, RoomTime]> = [
  [5, 'dusk'],
  [7, 'day'],
  [17, 'dusk'],
  [19.5, 'night'],
];

export interface RoomTimeMix {
  /** Fading out. Equal to `to` when no fade is running. */
  from: RoomTime;
  to: RoomTime;
  /** 0 = all `from`, 1 = all `to`. */
  t: number;
}

/**
 * The clock's room time as a crossfade: for ROOM_TIME_FADE_MIN minutes after
 * each boundary the previous time fades into the new one. roomTimeAt (what
 * the AI is told) switches at the boundary itself.
 */
export function roomTimeMixAt(date: Date, fadeMin: number = ROOM_TIME_FADE_MIN): RoomTimeMix {
  const to = roomTimeAt(date);
  const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  for (let i = 0; i < BOUNDARIES.length; i++) {
    const [at, time] = BOUNDARIES[i];
    if (time !== to) continue;
    const since = (h - at) * 60;
    if (since >= 0 && since < fadeMin) {
      const from = BOUNDARIES[(i + BOUNDARIES.length - 1) % BOUNDARIES.length][1];
      return { from, to, t: since / fadeMin };
    }
  }
  return { from: to, to, t: 1 };
}

/** The mix for a room state: a fixed time never fades with the clock. */
export function roomTimeMix(state: Pick<RoomState, 'time'>, now: Date = new Date()): RoomTimeMix {
  if (state.time !== 'auto') return { from: state.time, to: state.time, t: 1 };
  return roomTimeMixAt(now);
}

// ── Overlay tint ────────────────────────────────────────────────────────────

const FALLBACK_OVERLAY: Record<RoomTime, string> = { day: '#efe6da', dusk: '#6b4a5a', night: '#1c2033' };

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex: string): number {
  const rgb = hexRgb(hex);
  if (!rgb) return 0;
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export interface RoomOverlay {
  /** Background colour of translucent UI over the room (dock, editor). */
  color: string;
  /** Light room: light overlay, dark ink. */
  light: boolean;
  /** Ink colour that reads on `color`. */
  ink: string;
}

/**
 * The overlay tint for UI drawn over the room (Shawn: light room, light
 * overlay; dark room, darker overlay), blended across a time crossfade.
 * `sampled` is the renderer's measured average of the room, used when the
 * manifest names no overlay for a time.
 */
export function roomOverlay(
  manifest: Pick<RoomPresetManifest, 'overlay'>,
  mix: RoomTimeMix,
  sampled?: Partial<Record<RoomTime, string>>,
): RoomOverlay {
  const pick = (t: RoomTime): [number, number, number] =>
    hexRgb(manifest.overlay?.[t] ?? sampled?.[t] ?? FALLBACK_OVERLAY[t]) ?? hexRgb(FALLBACK_OVERLAY[t])!;
  const a = pick(mix.from);
  const b = pick(mix.to);
  const t = Math.max(0, Math.min(1, mix.t));
  const color = rgbHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  const light = luminance(color) > 0.4;
  return { color, light, ink: light ? '#1d1b22' : '#f4f1ee' };
}

// ── Viewport ────────────────────────────────────────────────────────────────

export type RoomFit = 'cover' | 'contain';

/**
 * Where the room canvas lands in a box of `w` x `h` CSS px. `cover` fills the
 * box and crops (a wallpaper), `contain` letterboxes (a preview). Canvas px
 * to box px is `x * scale + left`.
 */
export interface RoomViewport {
  scale: number;
  left: number;
  top: number;
  /** Drawn size of the whole room canvas, CSS px. */
  width: number;
  height: number;
}

export function roomViewport(canvas: readonly [number, number], w: number, h: number, fit: RoomFit = 'cover'): RoomViewport {
  const [cw, ch] = canvas;
  if (!(w > 0 && h > 0 && cw > 0 && ch > 0)) return { scale: 0, left: 0, top: 0, width: 0, height: 0 };
  const scale = fit === 'cover' ? Math.max(w / cw, h / ch) : Math.min(w / cw, h / ch);
  const width = cw * scale;
  const height = ch * scale;
  return { scale, left: (w - width) / 2, top: (h - height) / 2, width, height };
}

/** A box point (CSS px, e.g. a pointer) to canvas px. */
export function viewportToCanvas(vp: RoomViewport, x: number, y: number): [number, number] {
  return vp.scale > 0 ? [(x - vp.left) / vp.scale, (y - vp.top) / vp.scale] : [0, 0];
}

// ── Glow effects ────────────────────────────────────────────────────────────

/**
 * Opacity of an animated glow at `ms` (any monotonic clock). 'pulse' breathes
 * slowly (monitor, lamp); 'flicker' is a campfire: a sum of incommensurate
 * sines so it never visibly loops. `seed` desyncs two glows of one kind.
 */
export function glowAlpha(effect: RoomGlowEffect | null, ms: number, seed = 0): number {
  if (effect === 'pulse') return 0.86 + 0.14 * Math.sin((ms / 1000) * 1.6 + seed);
  if (effect === 'flicker') {
    const s = ms / 1000 + seed * 7.13;
    const n = Math.sin(s * 9.1) * 0.5 + Math.sin(s * 14.7 + 1.3) * 0.3 + Math.sin(s * 23.3 + 2.1) * 0.2;
    return 0.8 + 0.2 * n;
  }
  return 1;
}
