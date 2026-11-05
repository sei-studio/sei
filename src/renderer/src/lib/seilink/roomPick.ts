/**
 * What is under the pointer in a room (261104, editor pass): the editor
 * selects an item, or opens a part's options, by clicking it in the room.
 *
 * Hit tests use each layer's own pixels (alpha), not its box, so a click
 * through the window glass reaches the view and a click beside a plant does
 * not grab it. Alpha maps are small (at most 256 px on the long side) and
 * built once per file; `prepare` loads them ahead so `pick` is synchronous
 * (a drag must start on pointerdown, not a frame later).
 */
import { itemRect, roomDrawPlan, type RoomLayer } from '@shared/seilinkDraw';
import { pointInPolygon } from '@shared/seilinkPlace';
import type { RoomPresetManifest, RoomSlotId, RoomState, RoomTime } from '@shared/seilinkRoom';
import type { RoomUrlResolver } from '@shared/seilinkPack';
import { ctx2d, loadRoomImage, makeCanvas } from './roomImages';

interface AlphaMap {
  /** Natural size of the source image. */
  nw: number;
  nh: number;
  w: number;
  h: number;
  data: Uint8Array;
}

const MAP_MAX = 256;
const HIT_ALPHA = 40;

export type RoomPick = { kind: 'item'; index: number } | { kind: 'slot'; slot: RoomSlotId } | { kind: 'avatar' };

export class RoomPicker {
  private maps = new Map<string, AlphaMap>();
  private pending = new Map<string, Promise<void>>();

  /** Load the alpha maps a plan needs. Resolves when all are ready (failures are skipped). */
  async prepare(manifest: RoomPresetManifest, state: RoomState, time: RoomTime, resolve: RoomUrlResolver): Promise<void> {
    const plan = roomDrawPlan(manifest, state, time);
    const jobs: Array<Promise<void>> = [];
    for (const l of plan.layers) {
      if (l.kind === 'avatar') continue;
      const url = resolve(l.frame.src);
      if (this.maps.has(url)) continue;
      let p = this.pending.get(url);
      if (!p) {
        p = buildMap(url).then(
          (m) => {
            this.maps.set(url, m);
            this.pending.delete(url);
          },
          () => {
            this.pending.delete(url);
          },
        );
        this.pending.set(url, p);
      }
      jobs.push(p);
    }
    await Promise.all(jobs);
  }

  /** Natural size of a loaded frame (items without a box need it for their rect). */
  natural(url: string): [number, number] | null {
    const m = this.maps.get(url);
    return m ? [m.nw, m.nh] : null;
  }

  /**
   * The top-most thing at canvas point (x, y). `slots` limits which slots can
   * be picked (the ones the editor offers options for); others are see-through.
   */
  pick(
    manifest: RoomPresetManifest,
    state: RoomState,
    time: RoomTime,
    resolve: RoomUrlResolver,
    x: number,
    y: number,
    slots: ReadonlySet<RoomSlotId>,
  ): RoomPick | null {
    const plan = roomDrawPlan(manifest, state, time);
    // Under a plank's lip (drawn over the items on that top) no item can be picked, even when the
    // plank itself is not pickable: you can't click an item through the plank.
    let underLip = false;
    for (let i = plan.layers.length - 1; i >= 0; i--) {
      const l: RoomLayer = plan.layers[i];
      if (l.kind === 'avatar') {
        const w = l.height * 0.5;
        if (x >= l.x - w / 2 && x <= l.x + w / 2 && y >= l.y - l.height * 0.95 && y <= l.y) return { kind: 'avatar' };
        continue;
      }
      if (l.kind === 'item' && underLip) continue;
      // A lip is its part only inside the lip; an item on a lipped top only above the plank's bottom edge.
      if (l.clip && !l.clip.some((p) => pointInPolygon(p, x, y))) continue;
      // A lip is traced to the plank's pixels: inside it is a hit (the small alpha map blurs a thin
      // plank), and blocks the items under it even when the part is not pickable.
      if (l.kind === 'slot' && l.clip) {
        if (slots.has(l.slot)) return { kind: 'slot', slot: l.slot };
        underLip = true;
        continue;
      }
      if (l.kind === 'slot' && !slots.has(l.slot)) continue;
      const map = this.maps.get(resolve(l.frame.src));
      if (!map) continue;
      const rect = l.kind === 'slot' ? (l.box ?? [0, 0, manifest.canvas[0], manifest.canvas[1]]) : itemRect(l, [map.nw, map.nh]);
      const [rx, ry, rw, rh] = rect;
      if (x < rx || y < ry || x > rx + rw || y > ry + rh) continue;
      let u = (x - rx) / rw;
      const v = (y - ry) / rh;
      if (l.kind === 'item' && l.flip) u = 1 - u;
      const px = Math.min(map.w - 1, Math.max(0, Math.floor(u * map.w)));
      const py = Math.min(map.h - 1, Math.max(0, Math.floor(v * map.h)));
      if (map.data[py * map.w + px] < HIT_ALPHA) continue;
      return l.kind === 'item' ? { kind: 'item', index: l.index } : { kind: 'slot', slot: l.slot };
    }
    return null;
  }

  /** Canvas-px rect of a placed item, or null until its frame is prepared. */
  itemRect(manifest: RoomPresetManifest, state: RoomState, time: RoomTime, resolve: RoomUrlResolver, index: number): [number, number, number, number] | null {
    const plan = roomDrawPlan(manifest, state, time);
    const l = plan.layers.find((x) => x.kind === 'item' && x.index === index);
    if (!l || l.kind !== 'item') return null;
    if (l.size) return itemRect(l, l.size);
    const n = this.natural(resolve(l.frame.src));
    return n ? itemRect(l, n) : null;
  }

  /**
   * 261105 (T336): canvas-px rect of what a slot draws (its frame's opaque
   * pixels, so curtains get a curtain-sized box, not the whole canvas), or
   * null until its frame is prepared or when the slot is empty.
   */
  slotRect(manifest: RoomPresetManifest, state: RoomState, time: RoomTime, resolve: RoomUrlResolver, slot: RoomSlotId): [number, number, number, number] | null {
    const plan = roomDrawPlan(manifest, state, time);
    let out: [number, number, number, number] | null = null;
    for (const l of plan.layers) {
      if (l.kind !== 'slot' || l.slot !== slot) continue;
      const map = this.maps.get(resolve(l.frame.src));
      if (!map) continue;
      const [rx, ry, rw, rh] = l.box ?? [0, 0, manifest.canvas[0], manifest.canvas[1]];
      const b = opaqueBounds(map);
      if (!b) continue;
      const r: [number, number, number, number] = [rx + (b[0] / map.w) * rw, ry + (b[1] / map.h) * rh, ((b[2] - b[0]) / map.w) * rw, ((b[3] - b[1]) / map.h) * rh];
      out = out ? union(out, r) : r;
    }
    return out;
  }
}

const boundsCache = new WeakMap<AlphaMap, [number, number, number, number] | null>();

/** [x0, y0, x1, y1] of the pixels at or over HIT_ALPHA, in map px; null when none. */
function opaqueBounds(map: AlphaMap): [number, number, number, number] | null {
  if (boundsCache.has(map)) return boundsCache.get(map)!;
  let x0 = map.w;
  let y0 = map.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.data[y * map.w + x] < HIT_ALPHA) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const b: [number, number, number, number] | null = x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
  boundsCache.set(map, b);
  return b;
}

function union(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

async function buildMap(url: string): Promise<AlphaMap> {
  const img = await loadRoomImage(url);
  const s = Math.min(1, MAP_MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c, { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
  return { nw: img.width, nh: img.height, w, h, data };
}
