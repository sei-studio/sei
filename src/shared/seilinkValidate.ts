/**
 * SeiLink validation (261104, host pass). Packs come from a download or a
 * dev dir and room states from a file on disk that the editor writes, so
 * both are checked before anything draws or path-joins them. Pure.
 */
import {
  ROOM_PRESET_IDS,
  ROOM_TIMES,
  SEILINK_ROOM_FORMAT,
  SEILINK_ROOM_VERSION,
  defaultRoomState,
  type RoomComponent,
  type RoomFrame,
  type RoomPolygon,
  type RoomSurfaceTop,
  type RoomSegment,
  type RoomItemPlacement,
  type RoomPresetId,
  type RoomPresetManifest,
  type RoomSlotDef,
  type RoomSlotId,
  type RoomState,
  type RoomTime,
} from './seilinkRoom';
import { settleItems } from './seilinkPlace';

const SLOT_IDS: readonly RoomSlotId[] = ['view', 'shell', 'curtains', 'bed', 'shelf', 'chair', 'lamp', 'rug', 'campfire'];
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const HEX_RE = /^#[0-9a-f]{6}$/i;
/** Hard caps so a hostile file cannot make the renderer allocate without bound. */
export const ROOM_LIMITS = { components: 400, items: 120, canvasMax: 4096, pathLen: 200, polygons: 24, polygonPoints: 64, lines: 32 } as const;

/** A pack file path: plain relative posix, no traversal, webp/png only. */
export function isSafeRoomPackPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || !rel || rel.length > ROOM_LIMITS.pathLen) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0') || rel.includes(':')) return false;
  if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return /\.(webp|png)$/i.test(rel);
}

export function isRoomPresetId(v: unknown): v is RoomPresetId {
  return typeof v === 'string' && (ROOM_PRESET_IDS as readonly string[]).includes(v);
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBox = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(isNum) && v[2] > 0 && v[3] > 0;
/** A surface may be a line (h = 0): a shelf top. */
const isSurface = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(isNum) && v[2] > 0 && v[3] >= 0;

/** A coordinate a little past the canvas is fine (an item cut by the frame's bottom edge); far out is not. */
const isCoord = (v: unknown): v is number => isNum(v) && v >= -ROOM_LIMITS.canvasMax && v <= 2 * ROOM_LIMITS.canvasMax;

/** A polygon: 3 to 64 [x, y] points. */
function isPolygon(v: unknown): v is RoomPolygon {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    v.length <= ROOM_LIMITS.polygonPoints &&
    v.every((p) => Array.isArray(p) && p.length === 2 && isCoord(p[0]) && isCoord(p[1]))
  );
}

/** A line with some length. */
const isSegment = (v: unknown): v is RoomSegment =>
  Array.isArray(v) && v.length === 4 && v.every(isCoord) && Math.hypot(v[2] - v[0], v[3] - v[1]) >= 1;

/** The valid polygons of a list (bad ones dropped), copied, or undefined when none. */
function polygons(v: unknown): RoomPolygon[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(isPolygon).slice(0, ROOM_LIMITS.polygons).map((p) => p.map(([x, y]) => [x, y] as [number, number]));
  return out.length ? out : undefined;
}

function parseFrame(raw: unknown, tintable: boolean): RoomFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (!isSafeRoomPackPath(f.src)) return null;
  const out: RoomFrame = { src: f.src };
  if (f.mask !== undefined) {
    if (!isSafeRoomPackPath(f.mask)) return null;
    out.mask = f.mask;
  } else if (tintable) {
    return null;
  }
  if (f.glow !== undefined) {
    if (!isSafeRoomPackPath(f.glow)) return null;
    out.glow = f.glow;
  }
  if (f.effect === 'flicker' || f.effect === 'pulse') out.effect = f.effect;
  return out;
}

function parseComponent(raw: unknown): RoomComponent | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !COMPONENT_ID_RE.test(c.id)) return null;
  const slot = c.slot;
  if (slot !== 'item' && !(typeof slot === 'string' && (SLOT_IDS as readonly string[]).includes(slot))) return null;
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) return null;
  const tintable = c.tintable === true;
  if (!c.frames || typeof c.frames !== 'object') return null;
  const framesRaw = c.frames as Record<string, unknown>;
  const day = parseFrame(framesRaw.day, tintable);
  if (!day) return null;
  const frames: RoomComponent['frames'] = { day };
  for (const t of ROOM_TIMES) {
    if (t === 'day' || framesRaw[t] === undefined) continue;
    const f = parseFrame(framesRaw[t], tintable);
    if (!f) return null;
    frames[t] = f;
  }
  const out: RoomComponent = { id: c.id, slot: slot as RoomComponent['slot'], name: c.name.trim(), frames };
  if (tintable) out.tintable = true;
  if (isHexColor(c.defaultTint)) out.defaultTint = c.defaultTint;
  if (c.placement === 'floor' || c.placement === 'wall' || c.placement === 'surface') out.placement = c.placement;
  if (c.box !== undefined) {
    if (!isBox(c.box)) return null;
    out.box = c.box;
  }
  if (isNum(c.z)) out.z = c.z;
  if (Array.isArray(c.surfaces)) {
    const surfaces = c.surfaces.filter(isSurface).slice(0, 16);
    if (surfaces.length) out.surfaces = surfaces;
  }
  if (Array.isArray(c.surfaceLines)) {
    const lines = c.surfaceLines.filter(isSegment).slice(0, ROOM_LIMITS.lines).map((l) => [l[0], l[1], l[2], l[3]] as RoomSegment);
    if (lines.length) out.surfaceLines = lines;
  }
  const areas = polygons(c.surfaceAreas);
  if (areas) out.surfaceAreas = areas;
  if (Array.isArray(c.surfaceTops)) {
    const tops: RoomSurfaceTop[] = [];
    for (const t of c.surfaceTops.slice(0, ROOM_LIMITS.polygons)) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      const [area] = polygons([r.area]) ?? [];
      if (!area) continue;
      const top: RoomSurfaceTop = { area };
      const [lip] = polygons([r.lip]) ?? [];
      if (lip) top.lip = lip;
      if (isNum(r.sink) && r.sink > 0 && r.sink < 200) top.sink = r.sink;
      tops.push(top);
    }
    if (tops.length) out.surfaceTops = tops;
  }
  if (c.blocks && typeof c.blocks === 'object') {
    const b = c.blocks as Record<string, unknown>;
    const floor = polygons(b.floor);
    const wall = polygons(b.wall);
    if (floor || wall) out.blocks = { ...(floor ? { floor } : {}), ...(wall ? { wall } : {}) };
  }
  if (isNum(c.foot) && c.foot > 0 && c.foot < 1000) out.foot = c.foot;
  if (Array.isArray(c.swatches)) {
    const swatches = c.swatches.filter(isHexColor).slice(0, 12).map((h) => h.toLowerCase());
    if (swatches.length) out.swatches = swatches;
  }
  return out;
}

/** A pack's manifest.json, checked. null when anything load-bearing is wrong. */
export function parseRoomManifest(raw: unknown): RoomPresetManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.format !== SEILINK_ROOM_FORMAT || m.version !== SEILINK_ROOM_VERSION) return null;
  if (!isRoomPresetId(m.id)) return null;
  if (typeof m.place !== 'string' || !m.place.trim()) return null;
  const canvas = m.canvas;
  if (!Array.isArray(canvas) || canvas.length !== 2 || !canvas.every((v) => isNum(v) && v > 0 && v <= ROOM_LIMITS.canvasMax)) {
    return null;
  }
  const av = m.avatar as Record<string, unknown> | undefined;
  if (!av || !isNum(av.x) || !isNum(av.y) || !isNum(av.height) || av.height <= 0) return null;
  if (!Array.isArray(m.components) || m.components.length > ROOM_LIMITS.components) return null;
  const components: RoomComponent[] = [];
  const ids = new Set<string>();
  for (const rc of m.components) {
    const c = parseComponent(rc);
    if (!c || ids.has(c.id)) return null;
    ids.add(c.id);
    components.push(c);
  }
  if (!m.slots || typeof m.slots !== 'object') return null;
  const slots: RoomPresetManifest['slots'] = {};
  for (const [k, v] of Object.entries(m.slots as Record<string, unknown>)) {
    if (!(SLOT_IDS as readonly string[]).includes(k)) return null;
    const d = v as Record<string, unknown>;
    if (!d || !isNum(d.z) || !Array.isArray(d.options) || d.options.length === 0) return null;
    // Every option must exist and be a component made for THIS slot.
    const options = d.options.filter((o): o is string => typeof o === 'string' && components.some((c) => c.id === o && c.slot === k));
    if (options.length !== d.options.length) return null;
    const def: RoomSlotDef = { z: d.z, options };
    if (d.optional === true) def.optional = true;
    slots[k as RoomSlotId] = def;
  }
  const out: RoomPresetManifest = {
    format: SEILINK_ROOM_FORMAT,
    version: SEILINK_ROOM_VERSION,
    id: m.id,
    place: m.place.trim(),
    canvas: [canvas[0], canvas[1]],
    avatar: { x: av.x, y: av.y, height: av.height },
    slots,
    components,
  };
  if (m.floor !== undefined && isBox(m.floor)) out.floor = m.floor;
  const floorAreas = polygons(m.floorAreas);
  if (floorAreas) out.floorAreas = floorAreas;
  const wallAreas = polygons(m.wallAreas);
  if (wallAreas) out.wallAreas = wallAreas;
  if (isCoord(m.horizon)) out.horizon = m.horizon;
  if (m.overlay && typeof m.overlay === 'object') {
    const ov: Partial<Record<RoomTime, string>> = {};
    for (const t of ROOM_TIMES) {
      const v = (m.overlay as Record<string, unknown>)[t];
      if (isHexColor(v)) ov[t] = v;
    }
    out.overlay = ov;
  }
  return out;
}

/**
 * A stored room state made safe for `manifest`: unknown slots, components
 * that do not fit their slot, bad tints and stray items are dropped; an
 * emptied slot stays empty only when the slot is optional. Never throws.
 * A state for a different preset than the manifest comes back as that
 * preset's default (the caller loaded the wrong pack). Items at a spot that
 * is not real floor, wall or surface in this room (an older save, a part
 * since removed) are settled onto the nearest valid spot, never dropped.
 */
export function sanitizeRoomState(manifest: RoomPresetManifest, raw: unknown): RoomState {
  const base = defaultRoomState(manifest.id);
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Record<string, unknown>;
  if (s.preset !== manifest.id) return base;
  const out: RoomState = { ...base };
  if (s.time === 'auto' || (typeof s.time === 'string' && (ROOM_TIMES as readonly string[]).includes(s.time))) {
    out.time = s.time as RoomState['time'];
  }
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const slotsRaw = s.slots && typeof s.slots === 'object' ? (s.slots as Record<string, unknown>) : {};
  out.slots = {};
  for (const [slot, def] of Object.entries(manifest.slots) as Array<[RoomSlotId, RoomSlotDef]>) {
    const v = slotsRaw[slot] as Record<string, unknown> | undefined;
    if (!v || typeof v !== 'object') continue;
    const entry: { id: string | null; tint?: string } = { id: def.options[0] };
    if (v.id === null) {
      if (!def.optional) continue;
      entry.id = null;
    } else if (typeof v.id === 'string' && def.options.includes(v.id)) {
      entry.id = v.id;
    } else if (v.id !== undefined) {
      continue;
    }
    if (isHexColor(v.tint) && entry.id && byId.get(entry.id)?.tintable) entry.tint = v.tint.toLowerCase();
    out.slots[slot] = entry;
  }
  out.items = [];
  if (Array.isArray(s.items)) {
    for (const it of s.items.slice(0, ROOM_LIMITS.items)) {
      const i = it as Record<string, unknown>;
      if (!i || typeof i.id !== 'string' || byId.get(i.id)?.slot !== 'item' || !isNum(i.x) || !isNum(i.y)) continue;
      const p: RoomItemPlacement = { id: i.id, x: i.x, y: i.y };
      if (isNum(i.scale) && i.scale >= 0.25 && i.scale <= 4) p.scale = i.scale;
      if (i.flip === true) p.flip = true;
      if (isNum(i.z)) p.z = i.z;
      if (isHexColor(i.tint) && byId.get(i.id)?.tintable) p.tint = i.tint.toLowerCase();
      out.items.push(p);
    }
  }
  const av = s.avatar as Record<string, unknown> | undefined;
  if (av && av.kind === 'live2d' && typeof av.modelPath === 'string' && av.modelPath.length > 0 && av.modelPath.length < 1024) {
    out.avatar = { kind: 'live2d', modelPath: av.modelPath };
  }
  return settleItems(manifest, out);
}
