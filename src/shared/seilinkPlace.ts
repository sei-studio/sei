/**
 * SeiLink physics-aware placement (261105, Shawn: "make it somewhat physics
 * aware... the bottom of furniture pics has to touch" the ground or a shelf).
 * Pure: no DOM, no Node. The editor snaps with it, the draw plan takes depth
 * scale and z from it, and sanitizeRoomState settles stored rooms with it, so
 * the wallpaper, the editor and look() always agree on where things stand.
 *
 * An item's anchor is the bottom centre of its sprite (seilinkRoom.ts). Its
 * CONTACT is where the object itself touches what it stands on: the anchor
 * raised by `foot` (the soft contact shadow under the object, sprite px,
 * times its scale). The rules are about the contact:
 *  - floor: the contact stands inside a floor area and outside every part's
 *    floor block (bed footprint, lamp base, her chair), and so does the back
 *    of its base (half a foot further up), so a pot pushed against the back
 *    wall never climbs it. Further back = smaller (depth scale from
 *    `horizon`) and drawn behind nearer floor items (z by y).
 *  - surface: the contact sits ON a surface line (a plank top) or inside a
 *    surface area (a bed top) of a part that is in the room, and the item
 *    takes that part's z. With no surface left in the room it falls to the
 *    floor.
 *  - wall: the whole sprite hangs inside the wall areas, clear of the window
 *    glass (not in any area) and of the parts' wall blocks.
 * A pack that labels none of this (no floorAreas, wallAreas or surfaces)
 * places as before: the legacy floor box, the wall above it, surface items
 * free.
 *
 * Snapping finds the nearest valid spot to where the pointer puts the anchor:
 * the spot itself when valid, else the nearest point on the edges of the
 * areas and blocks (projected for each sampled point of the sprite), else a
 * widening ring search. Surface snaps lean a little downward (an item held
 * between two shelves drops onto the lower one) and keep the surface they are
 * on until another is clearly nearer, so a drag does not flicker between
 * planks.
 */
import {
  ITEM_Z,
  resolveSlots,
  type RoomBox,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPolygon,
  type RoomPresetManifest,
  type RoomSegment,
  type RoomSlotId,
  type RoomState,
} from './seilinkRoom';

export type PlacementClass = 'floor' | 'wall' | 'surface';

export function placementOf(c: Pick<RoomComponent, 'placement'>): PlacementClass {
  return c.placement ?? 'floor';
}

/** Manual scale range per class. Surface decor stays small so it never outgrows a plank. */
export const SCALE_RANGE: Readonly<Record<PlacementClass, readonly [number, number]>> = {
  floor: [0.6, 1.5],
  wall: [0.6, 1.5],
  surface: [0.6, 1.25],
};

/** Depth scale bounds, so a hostile horizon cannot make an item vanish or fill the screen. */
const DEPTH_MIN = 0.3;
const DEPTH_MAX = 1.3;
/** Fraction of the canvas height treated as floor when a legacy manifest names no floor. */
const DEFAULT_FLOOR_TOP = 0.78;
/** A guessed eye level sits this many floor-depths above the back of the floor. */
const HORIZON_GUESS = 1.4;
/** Within this many px of a surface line the anchor is on it. */
const ON_LINE = 1.5;
/** Surface snapping: a surface below the anchor counts this much nearer (things fall down). */
const DOWN_BIAS = 0.8;
/** Surface snapping: the current surface is kept until another is this much nearer. */
const KEEP_SURFACE = 14;

// ── Geometry ────────────────────────────────────────────────────────────────

/** Even-odd containment. A point exactly on an edge may go either way; callers nudge. */
export function pointInPolygon(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest point of a segment to (x, y): the point, its parameter t in [0, 1] and the distance. */
export function nearestOnSegment(seg: RoomSegment, x: number, y: number): { x: number; y: number; t: number; d: number } {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return { x: px, y: py, t, d: Math.hypot(px - x, py - y) };
}

/** y of a line at x (its end when x is past it). */
export function lineYAt(seg: RoomSegment, x: number): number {
  const [x1, y1, x2, y2] = seg;
  if (x2 === x1) return Math.min(y1, y2);
  const t = Math.max(0, Math.min(1, (x - x1) / (x2 - x1)));
  return y1 + t * (y2 - y1);
}

export function boxPolygon([x, y, w, h]: RoomBox): RoomPolygon {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

export function polygonBounds(poly: RoomPolygon): RoomBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function edges(poly: RoomPolygon): RoomSegment[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return [p[0], p[1], q[0], q[1]] as RoomSegment;
  });
}

/** Whether (x, y) lies on an edge of the polygon (within eps px). */
export function onPolygonEdge(poly: RoomPolygon, x: number, y: number, eps = 0.05): boolean {
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    if (nearestOnSegment([poly[i][0], poly[i][1], q[0], q[1]], x, y).d <= eps) return true;
  }
  return false;
}

/** Areas include their edges; blocks do not (an item may stand right against a bed). */
const inArea = (poly: RoomPolygon, x: number, y: number): boolean => pointInPolygon(poly, x, y) || onPolygonEdge(poly, x, y);
const inBlock = (poly: RoomPolygon, x: number, y: number): boolean => pointInPolygon(poly, x, y) && !onPolygonEdge(poly, x, y);
const inAnyArea = (polys: readonly RoomPolygon[], x: number, y: number): boolean => polys.some((p) => inArea(p, x, y));
const inAnyBlock = (polys: readonly RoomPolygon[], x: number, y: number): boolean => polys.some((p) => inBlock(p, x, y));

// ── Regions in this room ────────────────────────────────────────────────────

export type RoomSurface =
  | { kind: 'line'; seg: RoomSegment; slot: RoomSlotId; z: number }
  | { kind: 'area'; poly: RoomPolygon; slot: RoomSlotId; z: number };

export interface PlacementRegions {
  canvas: [number, number];
  /** The pack labels its regions (any floorAreas, wallAreas or surfaces). */
  labelled: boolean;
  /** The pack has floorAreas (perspective and depth z apply). */
  perspective: boolean;
  floor: RoomPolygon[];
  floorBlocks: RoomPolygon[];
  wall: RoomPolygon[];
  wallBlocks: RoomPolygon[];
  /** Surfaces of the parts in the room now. */
  surfaces: RoomSurface[];
  /** Back (min y) and front (max y) of the floor. */
  floorTop: number;
  floorFront: number;
  horizon: number;
}

function hasSurfaceLabels(c: RoomComponent): boolean {
  return Boolean(c.surfaceLines?.length || c.surfaceAreas?.length || c.surfaces?.length);
}

/** Everything placement needs to know about this room (the parts in it now). */
export function placementRegions(manifest: RoomPresetManifest, state: RoomState): PlacementRegions {
  const [w, h] = manifest.canvas;
  let floor: RoomPolygon[];
  if (manifest.floorAreas?.length) floor = manifest.floorAreas;
  else if (manifest.floor) floor = [boxPolygon(manifest.floor)];
  else {
    const top = Math.round(h * DEFAULT_FLOOR_TOP);
    floor = [boxPolygon([0, top, w, h - top])];
  }
  let floorTop = Infinity;
  let floorFront = -Infinity;
  for (const p of floor) {
    const [, y, , bh] = polygonBounds(p);
    floorTop = Math.min(floorTop, y);
    floorFront = Math.max(floorFront, y + bh);
  }
  const wall = manifest.wallAreas?.length ? manifest.wallAreas : [boxPolygon([0, 0, w, Math.max(1, floorTop)])];
  const floorBlocks: RoomPolygon[] = [];
  const wallBlocks: RoomPolygon[] = [];
  const surfaces: RoomSurface[] = [];
  for (const { slot, component } of resolveSlots(manifest, state)) {
    const z = manifest.slots[slot]!.z;
    if (component.blocks?.floor) floorBlocks.push(...component.blocks.floor);
    if (component.blocks?.wall) wallBlocks.push(...component.blocks.wall);
    for (const seg of component.surfaceLines ?? []) surfaces.push({ kind: 'line', seg, slot, z });
    for (const poly of component.surfaceAreas ?? []) surfaces.push({ kind: 'area', poly, slot, z });
    for (const b of component.surfaces ?? []) {
      // A legacy box surface; a flat one (h = 0) is a line.
      if (b[3] <= 0) surfaces.push({ kind: 'line', seg: [b[0], b[1], b[0] + b[2], b[1]], slot, z });
      else surfaces.push({ kind: 'area', poly: boxPolygon(b), slot, z });
    }
  }
  const perspective = Boolean(manifest.floorAreas?.length);
  const labelled = perspective || Boolean(manifest.wallAreas?.length) || manifest.components.some(hasSurfaceLabels);
  const guess = floorTop - HORIZON_GUESS * (floorFront - floorTop);
  const horizon = typeof manifest.horizon === 'number' && manifest.horizon < floorTop ? manifest.horizon : guess;
  return { canvas: [w, h], labelled, perspective, floor, floorBlocks, wall, wallBlocks, surfaces, floorTop, floorFront, horizon };
}

// ── Depth: scale and z ──────────────────────────────────────────────────────

/** Perspective factor for a floor item whose anchor is at y (1 at its artist spot). Other classes: 1. */
export function depthScale(r: PlacementRegions, component: RoomComponent, y: number): number {
  if (!r.perspective || placementOf(component) !== 'floor') return 1;
  const ref = component.box ? component.box[1] + component.box[3] : r.floorFront;
  const span = ref - r.horizon;
  if (!(span > 1)) return 1;
  return Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, (y - r.horizon) / span));
}

/** The surface a contact point rests on (index into r.surfaces), or -1. */
export function surfaceAt(r: PlacementRegions, x: number, y: number): number {
  let best = -1;
  let bestD = ON_LINE;
  r.surfaces.forEach((s, i) => {
    if (s.kind === 'line') {
      const d = nearestOnSegment(s.seg, x, y).d;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    } else if (best < 0 && inArea(s.poly, x, y)) {
      best = i;
    }
  });
  return best;
}

/**
 * Draw z of a placed item. The placement's own z wins. A floor item: its base
 * (component z, else ITEM_Z.floor) plus a fraction growing with y, so nearer
 * floor items draw over further ones. A surface item on a part: that part's
 * z plus a half (plus a little by y, for a deep top like a bed). Otherwise
 * the component's z or the class default.
 */
export function placedItemZ(r: PlacementRegions, component: RoomComponent, it: Pick<RoomItemPlacement, 'x' | 'y' | 'z'>): number {
  if (typeof it.z === 'number' && Number.isFinite(it.z)) return it.z;
  const cls = placementOf(component);
  const h = r.canvas[1];
  if (cls === 'floor' && r.perspective) {
    const base = typeof component.z === 'number' ? component.z : ITEM_Z.floor;
    return base + Math.min(0.99, Math.max(0, it.y) / (h * 1.2));
  }
  if (cls === 'surface') {
    const i = surfaceAt(r, it.x, contactY(r, component, it));
    if (i >= 0) return r.surfaces[i].z + 0.5 + Math.min(0.49, Math.max(0, it.y) / (h * 2.5));
  }
  if (typeof component.z === 'number') return component.z;
  return ITEM_Z[cls];
}

/** Canvas y of the item's contact: its anchor raised by its foot at its scale. */
export function contactY(r: PlacementRegions, component: RoomComponent, it: Pick<RoomItemPlacement, 'y' | 'scale'>): number {
  const foot = component.foot ?? 0;
  if (!(foot > 0)) return it.y;
  return it.y - foot * (it.scale ?? 1) * depthScale(r, component, it.y);
}

// ── Validity ────────────────────────────────────────────────────────────────

/** The sprite at an anchor y, canvas px: its size and the depth of its contact shadow. */
export type SpriteFit = (y: number) => { w: number; h: number; foot: number } | null;

/**
 * The fit for an item: its sprite size (box, else `natural`) times its manual
 * scale times the depth scale at y. null = size unknown (anchor-only checks).
 */
export function spriteFit(r: PlacementRegions, component: RoomComponent, scale: number, natural?: [number, number] | null): SpriteFit {
  const size = component.box ? ([component.box[2], component.box[3]] as [number, number]) : (natural ?? null);
  const foot = Math.max(0, component.foot ?? 0);
  return (y) => {
    const s = scale * depthScale(r, component, y);
    if (!size) return foot ? { w: 0, h: 0, foot: foot * s } : null;
    return { w: size[0] * s, h: size[1] * s, foot: foot * s };
  };
}

function floorOk(r: PlacementRegions, x: number, y: number): boolean {
  return inAnyArea(r.floor, x, y) && !inAnyBlock(r.floorBlocks, x, y);
}

function wallOk(r: PlacementRegions, x: number, y: number): boolean {
  return inAnyArea(r.wall, x, y) && !inAnyBlock(r.wallBlocks, x, y);
}

/** Points of a wall sprite (offsets from its anchor) that must all be on bare wall. */
function wallSamples(f: { w: number; h: number } | null): Array<[number, number]> {
  if (!f || f.w <= 0 || f.h <= 0) return [[0, 0]];
  const hw = f.w / 2 - 1;
  const top = -f.h + 1;
  const out: Array<[number, number]> = [];
  for (const fx of [-hw, 0, hw]) for (const fy of [-1, top / 2, top]) out.push([fx, fy]);
  return out;
}

/** Points (offsets from the anchor) that must be on floor: the contact, and the back of the base. */
function floorSamples(f: { foot: number } | null): Array<[number, number]> {
  return f && f.foot > 0 ? [[0, -f.foot], [0, -1.5 * f.foot]] : [[0, 0]];
}

/** Whether an item of class `cls` may have its anchor at (x, y). */
export function spotValid(r: PlacementRegions, cls: PlacementClass, x: number, y: number, fit?: SpriteFit | null): boolean {
  const f = fit ? fit(y) : null;
  if (cls === 'surface') {
    if (r.surfaces.length) return surfaceAt(r, x, y - (f?.foot ?? 0)) >= 0;
    if (!r.labelled) return true;
    cls = 'floor';
  }
  if (cls === 'floor') return floorSamples(f).every(([dx, dy]) => floorOk(r, x + dx, y + dy));
  return wallSamples(f).every(([dx, dy]) => wallOk(r, x + dx, y + dy));
}

// ── Snapping ────────────────────────────────────────────────────────────────

export interface Snap {
  x: number;
  y: number;
  /** The surface it rests on (index into the regions' surfaces), or -1. */
  surface: number;
}

function nearestSpot(valid: (x: number, y: number) => boolean, x: number, y: number, candidates: Array<[number, number]>, bounds: RoomBox): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  const consider = (px: number, py: number): void => {
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD && valid(px, py)) {
      bestD = d;
      best = [px, py];
    }
  };
  for (const [px, py] of candidates) consider(px, py);
  if (best) return best;
  // Nothing on an edge fits (a big sprite in a narrow corner): widen a ring around the point.
  const [bx, by, bw, bh] = bounds;
  const step = 24;
  const maxR = Math.max(bw, bh) + Math.hypot(x - (bx + bw / 2), y - (by + bh / 2));
  for (let rr = step; rr <= maxR; rr += step) {
    if (best && rr - step > Math.sqrt(bestD)) break;
    for (let i = -rr; i <= rr; i += step) {
      for (const [px, py] of [
        [x + i, y - rr],
        [x + i, y + rr],
        [x - rr, y + i],
        [x + rr, y + i],
      ] as Array<[number, number]>) {
        if (px < bx || px > bx + bw || py < by || py > by + bh) continue;
        consider(px, py);
      }
    }
  }
  if (!best) return null;
  // Refine: walk toward the pointer in small steps while it stays valid.
  let [cx, cy] = best as [number, number];
  for (let s = step / 2; s >= 1; s /= 2) {
    for (const [dx, dy] of [
      [s, 0],
      [-s, 0],
      [0, s],
      [0, -s],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if ((nx - x) ** 2 + (ny - y) ** 2 < (cx - x) ** 2 + (cy - y) ** 2 && valid(nx, ny)) {
        cx = nx;
        cy = ny;
      }
    }
  }
  return [cx, cy];
}

/**
 * Edge projections of the anchor (and of each sampled sprite point), also
 * nudged 1 px off the edge both ways. The samples can depend on the anchor y
 * (a floor item's foot grows with depth), so each projection is iterated to
 * the anchor whose own samples land on the edge.
 */
function edgeCandidates(
  polys: readonly RoomPolygon[],
  x: number,
  y: number,
  samplesAt: (y: number) => Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = samplesAt(y).length;
  for (const poly of polys) {
    for (const e of edges(poly)) {
      const len = Math.hypot(e[2] - e[0], e[3] - e[1]) || 1;
      const nx = -(e[3] - e[1]) / len;
      const ny = (e[2] - e[0]) / len;
      for (let k = 0; k < n; k++) {
        let ax = x;
        let ay = y;
        for (let pass = 0; pass < 4; pass++) {
          const [ox, oy] = samplesAt(ay)[k] ?? [0, 0];
          const q = nearestOnSegment(e, x + ox, y + oy);
          const bx = q.x - ox;
          const by = q.y - oy;
          const moved = Math.abs(by - ay) + Math.abs(bx - ax);
          ax = bx;
          ay = by;
          if (pass && moved < 0.05) break;
        }
        out.push([ax, ay], [ax + nx, ay + ny], [ax - nx, ay - ny]);
      }
    }
  }
  return out;
}

function boundsOf(polys: readonly RoomPolygon[], canvas: [number, number]): RoomBox {
  if (!polys.length) return [0, 0, canvas[0], canvas[1]];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys) {
    const [bx, by, bw, bh] = polygonBounds(p);
    x0 = Math.min(x0, bx);
    y0 = Math.min(y0, by);
    x1 = Math.max(x1, bx + bw);
    y1 = Math.max(y1, by + bh);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Round to whole px when that stays valid, else to a tenth. */
function tidy(valid: (x: number, y: number) => boolean, x: number, y: number): [number, number] {
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (valid(rx, ry)) return [rx, ry];
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ]) {
    if (valid(rx + dx, ry + dy)) return [rx + dx, ry + dy];
  }
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

function snapArea(r: PlacementRegions, cls: 'floor' | 'wall', x: number, y: number, fit: SpriteFit | null): [number, number] {
  const valid = (px: number, py: number): boolean => spotValid(r, cls, px, py, fit);
  if (valid(x, y)) return tidy(valid, x, y);
  const samplesAt = (py: number): Array<[number, number]> => {
    const f = fit ? fit(py) : null;
    return cls === 'floor' ? floorSamples(f) : wallSamples(f);
  };
  const polys = cls === 'floor' ? [...r.floor, ...r.floorBlocks] : [...r.wall, ...r.wallBlocks];
  const areas = cls === 'floor' ? r.floor : r.wall;
  const spot = nearestSpot(valid, x, y, edgeCandidates(polys, x, y, samplesAt), boundsOf(areas, r.canvas));
  if (spot) return tidy(valid, spot[0], spot[1]);
  // The sprite fits nowhere whole: settle for the anchor alone.
  if (fit) return snapArea(r, cls, x, y, null);
  const [bx, by, bw, bh] = boundsOf(areas, r.canvas);
  return [Math.round(Math.max(bx, Math.min(bx + bw, x))), Math.round(Math.max(by, Math.min(by + bh, y)))];
}

/**
 * Where an item held at (x, y) lands on one surface. A line: straight down
 * (or up) onto it, x kept, clamped `inset` px in from its ends. An area: the
 * point itself when inside, else the nearest point of its edge.
 */
function onSurface(s: RoomSurface, x: number, y: number, inset: number): [number, number] {
  if (s.kind === 'line') {
    const lo = Math.min(s.seg[0], s.seg[2]);
    const hi = Math.max(s.seg[0], s.seg[2]);
    const k = Math.min(inset, (hi - lo) / 2);
    const px = Math.max(lo + k, Math.min(hi - k, x));
    return [px, lineYAt(s.seg, px)];
  }
  if (inArea(s.poly, x, y)) return [x, y];
  const c = edgeCandidates([s.poly], x, y, () => [[0, 0]]).filter(([px, py]) => inArea(s.poly, px, py));
  let best: [number, number] = s.poly[0] as [number, number];
  let bestD = Infinity;
  for (const p of c) {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Snap an anchor for a `component` item to the nearest valid spot in this
 * room. `fit` describes its sprite (spriteFit); `prefer` is the surface it
 * was on (kept unless another is clearly nearer).
 */
export function snapSpot(
  r: PlacementRegions,
  component: RoomComponent,
  x: number,
  y: number,
  opts: { fit?: SpriteFit | null; prefer?: number } = {},
): Snap {
  const cls = placementOf(component);
  const fit = opts.fit ?? null;
  if (cls === 'surface') {
    if (!r.surfaces.length) {
      if (!r.labelled) return { x: Math.round(x), y: Math.round(y), surface: -1 };
      const [fx, fy] = snapArea(r, 'floor', x, y, fit);
      return { x: fx, y: fy, surface: -1 };
    }
    const f = fit ? fit(y) : null;
    // Keep most of the sprite on the plank: the anchor stays a third of its width in from the ends.
    const inset = f ? f.w / 3 : 0;
    // Snap the contact (the anchor raised by the foot), then hang the sprite back under it.
    const foot = f?.foot ?? 0;
    y -= foot;
    let best = -1;
    let bestD = Infinity;
    let bestP: [number, number] = [x, y];
    const dist: number[] = [];
    const pts: Array<[number, number]> = [];
    r.surfaces.forEach((s, i) => {
      const p = onSurface(s, x, y, inset);
      const d = Math.hypot(p[0] - x, p[1] - y) * (p[1] > y ? DOWN_BIAS : 1);
      dist.push(d);
      pts.push(p);
      if (d < bestD) {
        bestD = d;
        best = i;
        bestP = p;
      }
    });
    const keep = opts.prefer ?? -1;
    if (keep >= 0 && keep < r.surfaces.length && keep !== best && dist[keep] <= bestD + KEEP_SURFACE) {
      best = keep;
      bestP = pts[keep];
    }
    const s = r.surfaces[best];
    // Lines: whole px in x, y exactly on the line (rounded to a tenth so it stays on it).
    if (s.kind === 'line') {
      const px = Math.round(bestP[0]);
      return { x: px, y: Math.round((lineYAt(s.seg, px) + foot) * 10) / 10, surface: best };
    }
    const [ax, ay] = tidy((px, py) => inArea(s.poly, px, py - foot), bestP[0], bestP[1] + foot);
    return { x: ax, y: ay, surface: best };
  }
  const [sx, sy] = snapArea(r, cls, x, y, fit);
  return { x: sx, y: sy, surface: -1 };
}

/**
 * A stored item made to stand somewhere real: unchanged when its spot is
 * valid, else snapped to the nearest valid spot. Never drops it.
 */
export function settlePlacement(
  r: PlacementRegions,
  component: RoomComponent,
  it: RoomItemPlacement,
  natural?: [number, number] | null,
): RoomItemPlacement {
  const fit = spriteFit(r, component, it.scale ?? 1, natural);
  if (spotValid(r, placementOf(component), it.x, it.y, fit)) return it;
  const s = snapSpot(r, component, it.x, it.y, { fit });
  if (s.x === it.x && s.y === it.y) return it;
  return { ...it, x: s.x, y: s.y };
}

/** Every item of a room settled (see settlePlacement). Returns the same state when nothing moved. */
export function settleItems(
  manifest: RoomPresetManifest,
  state: RoomState,
  natural?: (it: RoomItemPlacement, component: RoomComponent) => [number, number] | null,
): RoomState {
  const r = placementRegions(manifest, state);
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  let changed = false;
  const items = state.items.map((it) => {
    const c = byId.get(it.id);
    if (!c || c.slot !== 'item') return it;
    const next = settlePlacement(r, c, it, natural?.(it, c) ?? null);
    if (next !== it) changed = true;
    return next;
  });
  return changed ? { ...state, items } : state;
}

/**
 * The manual scale range for an item where it stands now: its class range,
 * and for surface decor no wider than 90% of the surface it rests on.
 */
export function scaleRangeAt(
  r: PlacementRegions,
  component: RoomComponent,
  it: Pick<RoomItemPlacement, 'x' | 'y' | 'scale'>,
  natural?: [number, number] | null,
): [number, number] {
  const cls = placementOf(component);
  const [min, max] = SCALE_RANGE[cls];
  if (cls !== 'surface') return [min, max];
  const w = component.box ? component.box[2] : natural?.[0];
  const i = surfaceAt(r, it.x, contactY(r, component, it));
  if (!w || i < 0) return [min, max];
  const s = r.surfaces[i];
  const room = s.kind === 'line' ? Math.abs(s.seg[2] - s.seg[0]) : polygonBounds(s.poly)[2];
  const fitMax = Math.floor(((room * 0.9) / w) * 100) / 100;
  return [min, Math.max(min, Math.min(max, fitMax))];
}
