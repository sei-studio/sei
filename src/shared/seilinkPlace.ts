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
 *  - surface: the contact rests inside a surface top (a plank's whole top
 *    face, back edge to front lip, or a bed top) or ON a legacy surface line
 *    of a part that is in the room, with the sprite kept END_INSET of its
 *    width in from the ends of the top, and the item takes that part's z.
 *    With no surface left in the room it falls to the floor.
 *  - wall: the whole sprite hangs inside the wall areas, clear of the window
 *    glass (not in any area) and of the parts' wall blocks.
 * A pack that labels none of this (no floorAreas, wallAreas or surfaces)
 * places as before: the legacy floor box, the wall above it, surface items
 * free.
 *
 * Snapping finds the nearest valid spot to where the pointer puts the anchor:
 * the spot itself when valid, else the nearest point on the edges of the
 * areas and blocks (projected for each sampled point of the sprite), else a
 * widening ring search. Surface snaps are forgiving (261105 shelf pass,
 * Shawn: "make the thing forgiving so there's some leeway"): a contact held
 * within SURFACE_CAPTURE px of a top (a little above or below a plank, or
 * past its end) lands on that top, the top it was on is kept while it stays
 * that close, and further out they lean a little downward (an item held
 * between two shelves drops onto the lower one), so a drag never flickers
 * between planks.
 *
 * Draw order on a part (261105 shelf pass): the part's tops are ranked back
 * to front by their y, and each gets a slice of z above the part. Items on a
 * top draw in its slice (further back on the top first), its lip (the
 * part's frame cut to the top's lip polygon) at the top of the slice, so the
 * lip covers the base of the items on that top and nothing else, and items
 * on the next top down draw over it.
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
/** Surface snapping, beyond capture: the current surface is kept until another is this much nearer. */
const KEEP_SURFACE = 14;
/**
 * Surface snapping: a contact within this many canvas px of a top (above,
 * below or past its end) lands on it, and the top it is on is kept while it
 * stays this close. About 25-30 screen px at a typical window size.
 */
export const SURFACE_CAPTURE = 48;
/** A surface item's anchor stays this fraction of its sprite width in from the ends of a top. */
export const END_INSET = 0.45;
/** The back of a surface item's base is this many of its feet behind its contact (kept on the top). */
export const BACK_OF_BASE = 1;
/** Part z slice the items on its tops (and their lips) draw in: part z + [lo, hi). */
const TOP_Z_LO = 0.5;
const TOP_Z_HI = 0.95;

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

interface SurfaceBase {
  slot: RoomSlotId;
  /** The part's z. */
  z: number;
  /** z slice of the items resting here, [lo, hi). Its lip draws at hi. */
  band: [number, number];
}

export interface LineSurface extends SurfaceBase {
  kind: 'line';
  seg: RoomSegment;
}

export interface AreaSurface extends SurfaceBase {
  kind: 'area';
  poly: RoomPolygon;
  /** The part's front lip, drawn over the items on this top; null = none. */
  lip: RoomPolygon | null;
  /** Soft top: px (sprite scale 1) an item's base settles in. 0 = a hard top. */
  sink: number;
  /** Unit direction along the top (its longest edge), x >= 0. */
  axis: [number, number];
  /** Extent along the axis, [min, max] of the vertices' projections. */
  along: [number, number];
  /** Extent across it (back to front), [min, max] along the axis's normal (pointing down). */
  across: [number, number];
}

export type RoomSurface = LineSurface | AreaSurface;

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
  return Boolean(c.surfaceLines?.length || c.surfaceAreas?.length || c.surfaceTops?.length || c.surfaces?.length);
}

function areaSurface(poly: RoomPolygon, slot: RoomSlotId, z: number, lip: RoomPolygon | null = null, sink = 0): AreaSurface {
  // Along: the longest edge (a plank's back edge), pointing right.
  let ax = 1;
  let ay = 0;
  let longest = -1;
  for (const e of edges(poly)) {
    const len = Math.hypot(e[2] - e[0], e[3] - e[1]);
    if (len > longest) {
      longest = len;
      ax = (e[2] - e[0]) / (len || 1);
      ay = (e[3] - e[1]) / (len || 1);
    }
  }
  if (ax < 0 || (ax === 0 && ay < 0)) [ax, ay] = [-ax, -ay];
  // Normal pointing down the screen (back of the top to its front).
  const [nx, ny] = [-ay, ax];
  const along: [number, number] = [Infinity, -Infinity];
  const across: [number, number] = [Infinity, -Infinity];
  for (const [x, y] of poly) {
    const a = x * ax + y * ay;
    const c = x * nx + y * ny;
    along[0] = Math.min(along[0], a);
    along[1] = Math.max(along[1], a);
    across[0] = Math.min(across[0], c);
    across[1] = Math.max(across[1], c);
  }
  return { kind: 'area', poly, slot, z, band: [z, z], lip, sink: Math.max(0, sink), axis: [ax, ay], along, across };
}

/** Mean y of a surface, to rank a part's tops back to front. */
function surfaceMidY(s: RoomSurface): number {
  if (s.kind === 'line') return (s.seg[1] + s.seg[3]) / 2;
  const [, y, , h] = polygonBounds(s.poly);
  return y + h / 2;
}

/** Give each part's tops their z slice, ranked by y (top shelf first). */
function assignBands(surfaces: RoomSurface[]): void {
  const bySlot = new Map<RoomSlotId, RoomSurface[]>();
  for (const s of surfaces) {
    const list = bySlot.get(s.slot);
    if (list) list.push(s);
    else bySlot.set(s.slot, [s]);
  }
  for (const list of bySlot.values()) {
    const ranked = [...list].sort((a, b) => surfaceMidY(a) - surfaceMidY(b));
    const step = (TOP_Z_HI - TOP_Z_LO) / ranked.length;
    ranked.forEach((s, k) => {
      s.band = [s.z + TOP_Z_LO + k * step, s.z + TOP_Z_LO + (k + 1) * step];
    });
  }
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
    for (const top of component.surfaceTops ?? []) surfaces.push(areaSurface(top.area, slot, z, top.lip ?? null, top.sink ?? 0));
    for (const seg of component.surfaceLines ?? []) surfaces.push({ kind: 'line', seg, slot, z, band: [z, z] });
    for (const poly of component.surfaceAreas ?? []) surfaces.push(areaSurface(poly, slot, z));
    for (const b of component.surfaces ?? []) {
      // A legacy box surface; a flat one (h = 0) is a line.
      if (b[3] <= 0) surfaces.push({ kind: 'line', seg: [b[0], b[1], b[0] + b[2], b[1]], slot, z, band: [z, z] });
      else surfaces.push(areaSurface(boxPolygon(b), slot, z));
    }
  }
  assignBands(surfaces);
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

/** How far back to front a contact is on a top: 0 at its back edge, 1 at its front. Lines: 0. */
export function depthOnSurface(s: RoomSurface, x: number, y: number): number {
  if (s.kind === 'line') return 0;
  const [ax, ay] = s.axis;
  const c = -ay * x + ax * y;
  const span = s.across[1] - s.across[0];
  return span > 0 ? Math.max(0, Math.min(1, (c - s.across[0]) / span)) : 0;
}

/** z of a surface item resting on top `s` with its contact at (x, y): in the top's slice, further back first. */
export function surfaceItemZ(s: RoomSurface, x: number, y: number): number {
  const [lo, hi] = s.band;
  return lo + (hi - lo) * 0.9 * depthOnSurface(s, x, y);
}

/**
 * Draw z of a placed item. The placement's own z wins. A floor item: its base
 * (component z, else ITEM_Z.floor) plus a fraction growing with y, so nearer
 * floor items draw over further ones. A surface item on a part: in the z
 * slice of the top it rests on (surfaceItemZ), between the part and its next
 * slot, under that top's lip. Otherwise the component's z or the class
 * default.
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
    const cy = contactY(r, component, it);
    const i = surfaceAt(r, it.x, cy);
    if (i >= 0) return surfaceItemZ(r.surfaces[i], it.x, cy);
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

/**
 * What a surface item keeps on the top it rests on, canvas px: its sprite
 * `inset` in from the ends of the top (along it), and the back of its base
 * `back` behind the contact (across it), so a big base never perches on the
 * top's back edge with the rest of it up the wall.
 */
export interface TopKeep {
  inset: number;
  back: number;
}

const NO_KEEP: TopKeep = { inset: 0, back: 0 };

/** The keep for a sprite at its fit: END_INSET of its width, BACK_OF_BASE of its foot. */
export function topKeep(f: { w: number; foot: number } | null): TopKeep {
  return f ? { inset: Math.max(0, f.w * END_INSET), back: Math.max(0, f.foot * BACK_OF_BASE) } : NO_KEEP;
}

/** Points (offsets from the contact) that must be on a top: the contact, the sprite's ends along it, the back of its base. */
function topSamples(s: AreaSurface, keep: TopKeep): Array<[number, number]> {
  // Never more than leaves the top some room in the middle.
  const k = Math.max(0, Math.min(keep.inset, (s.along[1] - s.along[0]) / 2 - 1));
  const b = Math.max(0, Math.min(keep.back, s.across[1] - s.across[0] - 1));
  const [ax, ay] = s.axis;
  const out: Array<[number, number]> = [[0, 0]];
  if (k > 0) out.push([k * ax, k * ay], [-k * ax, -k * ay]);
  // Back: against the normal (which points down, to the front of the top).
  if (b > 0) out.push([ay * b, -ax * b]);
  return out;
}

/** Whether a contact at (x, y) rests on surface `s`, keeping `keep` of the sprite on it (tops only). */
export function fitsSurface(s: RoomSurface, x: number, y: number, keep: TopKeep = NO_KEEP): boolean {
  if (s.kind === 'line') return nearestOnSegment(s.seg, x, y).d <= ON_LINE;
  return topSamples(s, keep).every(([dx, dy]) => inArea(s.poly, x + dx, y + dy));
}

/** Whether an item of class `cls` may have its anchor at (x, y). */
export function spotValid(r: PlacementRegions, cls: PlacementClass, x: number, y: number, fit?: SpriteFit | null): boolean {
  const f = fit ? fit(y) : null;
  if (cls === 'surface') {
    if (r.surfaces.length) {
      const cy = y - (f?.foot ?? 0);
      const keep = topKeep(f);
      return r.surfaces.some((s) => fitsSurface(s, x, cy, keep));
    }
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

/** The nearest point of a polygon to (x, y): the point itself when inside, else on its edge. */
function nearestIn(poly: RoomPolygon, x: number, y: number): [number, number] {
  if (inArea(poly, x, y)) return [x, y];
  let best: [number, number] = [poly[0][0], poly[0][1]];
  let bestD = Infinity;
  for (const e of edges(poly)) {
    const q = nearestOnSegment(e, x, y);
    if (q.d < bestD) {
      bestD = q.d;
      best = [q.x, q.y];
    }
  }
  return best;
}

/**
 * Where a contact held at (x, y) lands on one surface. A line: straight down
 * (or up) onto it, x kept, clamped `keep.inset` px in from its ends. A top:
 * the point itself when it fits, else the nearest point that keeps the
 * contact, the sprite's ends and the back of its base on it (alternating
 * projections, exact for convex tops), else the nearest point of the top for
 * the contact alone.
 */
function onSurface(s: RoomSurface, x: number, y: number, keep: TopKeep): [number, number] {
  if (s.kind === 'line') {
    const lo = Math.min(s.seg[0], s.seg[2]);
    const hi = Math.max(s.seg[0], s.seg[2]);
    const k = Math.min(keep.inset, (hi - lo) / 2);
    const px = Math.max(lo + k, Math.min(hi - k, x));
    return [px, lineYAt(s.seg, px)];
  }
  const samples = topSamples(s, keep);
  let px = x;
  let py = y;
  for (let pass = 0; pass < 24; pass++) {
    let moved = 0;
    for (const [dx, dy] of samples) {
      const [qx, qy] = nearestIn(s.poly, px + dx, py + dy);
      const mx = qx - (px + dx);
      const my = qy - (py + dy);
      if (mx || my) {
        px += mx;
        py += my;
        moved += Math.abs(mx) + Math.abs(my);
      }
    }
    if (moved < 1e-6) break;
  }
  if (fitsSurface(s, px, py, keep)) return [px, py];
  return nearestIn(s.poly, x, y);
}

/**
 * Which surface a contact lands on, given how far it is from each (`d` the
 * raw distance to the surface, 0 when it already rests on it; `biased` with
 * things falling down). On a surface already:
 * that one (the preferred one when on several). Else a preferred surface
 * within SURFACE_CAPTURE is kept; else the nearest surface within capture;
 * else the nearest by the biased distance, the preferred one kept unless
 * another is KEEP_SURFACE nearer.
 */
export function chooseSurface(picks: ReadonlyArray<{ d: number; biased: number }>, prefer = -1): number {
  if (!picks.length) return -1;
  const has = (i: number): boolean => i >= 0 && i < picks.length;
  const on = picks.map((_, i) => i).filter((i) => picks[i].d < 0.01);
  if (on.length) return on.includes(prefer) ? prefer : on[0];
  if (has(prefer) && picks[prefer].d <= SURFACE_CAPTURE) return prefer;
  const captured = picks.map((_, i) => i).filter((i) => picks[i].d <= SURFACE_CAPTURE);
  const pool = captured.length ? captured : picks.map((_, i) => i);
  let best = pool[0];
  for (const i of pool) if (picks[i].biased < picks[best].biased) best = i;
  if (!captured.length && has(prefer) && picks[prefer].biased <= picks[best].biased + KEEP_SURFACE) best = prefer;
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
    // Keep the sprite on the plank: in from its ends, the back of its base on it too.
    const keep = topKeep(f);
    // Snap the contact (the anchor raised by the foot), then hang the sprite back under it.
    const foot = f?.foot ?? 0;
    const cy = y - foot;
    const pts = r.surfaces.map((s) => onSurface(s, x, cy, keep));
    // How far the contact is from each surface itself (not from where it would land, kept in from the ends).
    const picks = r.surfaces.map((s, i) => {
      if (fitsSurface(s, x, cy, keep)) return { d: 0, biased: 0 };
      // A line: where it lands (straight down onto it, as before). A top: its nearest point.
      const [px, py] = s.kind === 'line' ? pts[i] : nearestIn(s.poly, x, cy);
      // Inside the top but too near its end (or its back): as near as can be, short of on it.
      const d = Math.max(0.02, Math.hypot(px - x, py - cy));
      return { d, biased: d * (py > cy ? DOWN_BIAS : 1) };
    });
    const best = chooseSurface(picks, opts.prefer ?? -1);
    const s = r.surfaces[best];
    const bestP = pts[best];
    // Lines: whole px in x, y exactly on the line (rounded to a tenth so it stays on it).
    if (s.kind === 'line') {
      const px = Math.round(bestP[0]);
      return { x: px, y: Math.round((lineYAt(s.seg, px) + foot) * 10) / 10, surface: best };
    }
    const k = fitsSurface(s, bestP[0], bestP[1], keep) ? keep : NO_KEEP;
    const [ax, ay] = tidy((px, py) => fitsSurface(s, px, py - foot, k), bestP[0], bestP[1] + foot);
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
  const room = s.kind === 'line' ? Math.abs(s.seg[2] - s.seg[0]) : s.along[1] - s.along[0];
  const fitMax = Math.floor(((room * 0.9) / w) * 100) / 100;
  return [min, Math.max(min, Math.min(max, fitMax))];
}
