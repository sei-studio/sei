/**
 * SeiLink room editor logic (261104, editor pass). Pure: no DOM, no Node, so
 * the rules are unit-tested and the editor screen (renderer
 * components/seilink/RoomEditor.tsx) stays a thin view over them.
 *
 *  - Placement: where an item's bottom centre may go, by the physics-aware
 *    rules in seilinkPlace.ts (floor areas, surface lines, wall areas, the
 *    parts' blocks). A drag snaps to the nearest valid spot; swapping or
 *    removing a part settles the items it held (books fall off a removed
 *    shelf onto the floor).
 *  - Edit ops: small reducers that return a NEW RoomState (never mutate), so
 *    the history can keep every step by reference.
 *  - History: an undo stack with gesture coalescing (one colour drag or one
 *    item drag is one undo step), capped, with a saved marker for "dirty".
 */
import {
  defaultRoomState,
  type RoomBox,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPresetManifest,
  type RoomSlotChoice,
  type RoomSlotId,
  type RoomState,
  PLAIN_PATTERN,
  patternsFor,
} from './seilinkRoom';
import {
  placementOf,
  placementRegions,
  polygonBounds,
  scaleRangeAt,
  settleItems,
  settlePlacement,
  snapSpot,
  spriteFit,
  type PlacementRegions,
  type Snap,
} from './seilinkPlace';

// ── Placement ───────────────────────────────────────────────────────────────
// The rules live in seilinkPlace.ts (floor areas, surface lines, wall areas,
// blocks, depth); these wrap them for the edit ops.

/** Item scale range in the editor (Shawn: a small range). Per class: SCALE_RANGE. */
export const ITEM_SCALE_MIN = 0.6;
export const ITEM_SCALE_MAX = 1.5;
export const ITEM_SCALE_STEP = 0.1;

export function clampScale(scale: number, range: readonly [number, number] = [ITEM_SCALE_MIN, ITEM_SCALE_MAX]): number {
  if (!Number.isFinite(scale)) return 1;
  const s = Math.round(scale * 100) / 100;
  return Math.max(range[0], Math.min(range[1], s));
}

/** What a placement call may know about the sprite: its natural size (when it has no box) and its manual scale. */
export interface PlaceOpts {
  natural?: [number, number] | null;
  scale?: number;
  /** The surface it was on (kept while a drag stays near it). */
  prefer?: number;
}

function clampToBox([bx, by, bw, bh]: RoomBox, x: number, y: number): [number, number] {
  return [Math.max(bx, Math.min(bx + bw, x)), Math.max(by, Math.min(by + bh, y))];
}

/** The nearest allowed point to (x, y): inside one of `areas`. */
export function clampToAreas(areas: readonly RoomBox[], x: number, y: number): [number, number] {
  let best: [number, number] = [x, y];
  let bestD = Infinity;
  for (const a of areas) {
    const p = clampToBox(a, x, y);
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return [Math.round(best[0]), Math.round(best[1])];
}

/** The nearest spot where `component` may stand in this room (its anchor). */
export function snapPlacement(manifest: RoomPresetManifest, state: RoomState, component: RoomComponent, x: number, y: number, opts: PlaceOpts = {}): Snap {
  const r = placementRegions(manifest, state);
  return snapSpot(r, component, x, y, { fit: spriteFit(r, component, opts.scale ?? 1, opts.natural), prefer: opts.prefer });
}

/** Clamp a placement for `component` in this room. */
export function clampPlacement(manifest: RoomPresetManifest, state: RoomState, component: RoomComponent, x: number, y: number, opts: PlaceOpts = {}): [number, number] {
  const s = snapPlacement(manifest, state, component, x, y, opts);
  return [s.x, s.y];
}

/** A point in the middle of where `component` may stand, before snapping. */
function middleSpot(r: PlacementRegions, component: RoomComponent): [number, number] {
  const cls = placementOf(component);
  if (cls === 'surface' && r.surfaces.length) {
    const s = r.surfaces[0];
    if (s.kind === 'line') return [(s.seg[0] + s.seg[2]) / 2, (s.seg[1] + s.seg[3]) / 2];
    const [x, y, w, h] = polygonBounds(s.poly);
    return [x + w / 2, y + h / 2];
  }
  const areas = cls === 'wall' ? r.wall : r.floor;
  // The biggest area, so a new item lands somewhere roomy.
  let best = areas[0];
  let bestA = -1;
  for (const a of areas) {
    const [, , w, h] = polygonBounds(a);
    if (w * h > bestA) {
      bestA = w * h;
      best = a;
    }
  }
  const [x, y, w, h] = polygonBounds(best);
  return [x + w / 2, y + h * (cls === 'wall' ? 0.5 : 0.6)];
}

/**
 * Where a freshly added item lands. A component with a box is drawn there by
 * the pack (the box's bottom centre is the artist's spot), else the middle of
 * its placement area, nudged per copy so two adds do not stack exactly; then
 * snapped to a real surface.
 */
export function defaultSpot(manifest: RoomPresetManifest, state: RoomState, component: RoomComponent, opts: PlaceOpts = {}): [number, number] {
  const copies = state.items.filter((i) => i.id === component.id).length;
  const nudge = copies * 48;
  const r = placementRegions(manifest, state);
  const [x, y] = component.box ? [component.box[0] + component.box[2] / 2, component.box[1] + component.box[3]] : middleSpot(r, component);
  const s = snapSpot(r, component, x - nudge, y, { fit: spriteFit(r, component, opts.scale ?? 1, opts.natural) });
  return [s.x, s.y];
}

// ── Edit ops (each returns a new state) ─────────────────────────────────────

function withSlot(state: RoomState, slot: RoomSlotId, entry: RoomSlotChoice): RoomState {
  return { ...state, slots: { ...state.slots, [slot]: entry } };
}

/** The id in a slot after defaults (null = empty). */
export function slotChoice(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId): string | null {
  const def = manifest.slots[slot];
  if (!def) return null;
  const chosen = state.slots[slot];
  return chosen && chosen.id !== undefined ? chosen.id : def.options[0];
}

/** Swap a slot's component (null empties an optional slot). The slot's tint is kept when the new part is tintable. */
export function setSlotComponent(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, id: string | null): RoomState {
  const def = manifest.slots[slot];
  if (!def) return state;
  if (id === null && !def.optional) return state;
  if (id !== null && !def.options.includes(id)) return state;
  const prev = state.slots[slot];
  const next = manifest.components.find((c) => c.id === id);
  const entry: RoomSlotChoice = { id };
  if (prev?.tint && next?.tintable) entry.tint = prev.tint;
  // The pattern and second colour carry over when the new part offers that pattern (261105).
  if (next && prev?.pattern && (prev.pattern === PLAIN_PATTERN ? next.defaultPattern : patternsFor(manifest, next).some((p) => p.id === prev.pattern))) {
    entry.pattern = prev.pattern;
  }
  if (next?.tintable && prev?.accent) entry.accent = prev.accent;
  if (next?.cycle && prev?.cycle) entry.cycle = true;
  // A part that held items or covered floor changes where things can stand.
  return settleItems(manifest, withSlot(state, slot, entry));
}

/** A slot's colour. Picking a colour stops a cycling light (it becomes that colour). Pattern and accent stay. */
export function setSlotTint(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, tint: string): RoomState {
  const id = slotChoice(manifest, state, slot);
  if (!id || !/^#[0-9a-f]{6}$/i.test(tint)) return state;
  const { cycle: _cycle, ...rest } = state.slots[slot] ?? { id };
  return withSlot(state, slot, { ...rest, id, tint: tint.toLowerCase() });
}

const HEX = /^#[0-9a-f]{6}$/i;

function slotComponent(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId): RoomComponent | undefined {
  const id = slotChoice(manifest, state, slot);
  return id ? manifest.components.find((c) => c.id === id) : undefined;
}

/** The pattern a part shows by the state (its default when none is set), or PLAIN_PATTERN. */
export function currentPattern(component: RoomComponent | undefined, own: string | undefined): string {
  if (!component?.tintable) return PLAIN_PATTERN;
  return own ?? component.defaultPattern ?? PLAIN_PATTERN;
}

/**
 * A slot's pattern (261105): an offered id or PLAIN_PATTERN. Plain is stored
 * only over a default pattern (else the key is dropped), so an untouched
 * room stays byte-for-byte the same.
 */
export function setSlotPattern(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, pattern: string): RoomState {
  const c = slotComponent(manifest, state, slot);
  if (!c?.tintable) return state;
  const prev = state.slots[slot] ?? { id: c.id };
  const { pattern: _p, ...rest } = prev;
  if (pattern === PLAIN_PATTERN) return withSlot(state, slot, c.defaultPattern ? { ...rest, id: c.id, pattern: PLAIN_PATTERN } : { ...rest, id: c.id });
  if (!patternsFor(manifest, c).some((p) => p.id === pattern)) return state;
  return withSlot(state, slot, { ...rest, id: c.id, pattern });
}

/** A slot's second pattern colour (261105). null goes back to the tone-on-tone default. */
export function setSlotAccent(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, accent: string | null): RoomState {
  const c = slotComponent(manifest, state, slot);
  if (!c?.tintable) return state;
  const { accent: _a, ...rest } = state.slots[slot] ?? { id: c.id };
  if (accent === null) return withSlot(state, slot, { ...rest, id: c.id });
  if (!HEX.test(accent)) return state;
  return withSlot(state, slot, { ...rest, id: c.id, accent: accent.toLowerCase() });
}

/** A light running through the colours, or not (261105). Only parts that offer it. */
export function setSlotCycle(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, on: boolean): RoomState {
  const c = slotComponent(manifest, state, slot);
  if (!c?.tintable || !c.cycle) return state;
  const { cycle: _c, ...rest } = state.slots[slot] ?? { id: c.id };
  return withSlot(state, slot, on ? { ...rest, id: c.id, cycle: true } : { ...rest, id: c.id });
}

function withItems(state: RoomState, items: RoomItemPlacement[]): RoomState {
  return { ...state, items };
}

function updateItem(state: RoomState, index: number, patch: (it: RoomItemPlacement) => RoomItemPlacement): RoomState {
  if (index < 0 || index >= state.items.length) return state;
  const items = state.items.slice();
  items[index] = patch(items[index]);
  return withItems(state, items);
}

/** Add an item at its default spot. Returns the state and the new item's index. */
export function addItem(manifest: RoomPresetManifest, state: RoomState, id: string, opts: PlaceOpts = {}): { state: RoomState; index: number } {
  const c = manifest.components.find((x) => x.id === id);
  if (!c || c.slot !== 'item') return { state, index: -1 };
  const [x, y] = defaultSpot(manifest, state, c, opts);
  return { state: withItems(state, [...state.items, { id, x, y }]), index: state.items.length };
}

/** Move an item, snapped to where it may stand. */
export function moveItem(manifest: RoomPresetManifest, state: RoomState, index: number, x: number, y: number, opts: PlaceOpts = {}): RoomState {
  const it = state.items[index];
  const c = it && manifest.components.find((x2) => x2.id === it.id);
  if (!c) return state;
  const [cx, cy] = clampPlacement(manifest, state, c, x, y, { ...opts, scale: it.scale ?? 1 });
  return updateItem(state, index, (p) => (p.x === cx && p.y === cy ? p : { ...p, x: cx, y: cy }));
}

/** The manual scale range of a placed item where it stands (its class, and for decor the surface it is on). */
export function itemScaleRange(manifest: RoomPresetManifest, state: RoomState, index: number, natural?: [number, number] | null): [number, number] {
  const it = state.items[index];
  const c = it && manifest.components.find((x) => x.id === it.id);
  if (!c) return [ITEM_SCALE_MIN, ITEM_SCALE_MAX];
  return scaleRangeAt(placementRegions(manifest, state), c, it, natural);
}

/**
 * Resize an item. With the manifest, the scale is held to the item's range
 * where it stands and the item is settled again at its new size (a bigger
 * poster may need to move off a shelf edge).
 */
export function scaleItem(state: RoomState, index: number, scale: number, manifest?: RoomPresetManifest, natural?: [number, number] | null): RoomState {
  const s = clampScale(scale, manifest ? itemScaleRange(manifest, state, index, natural) : undefined);
  const next = updateItem(state, index, (p) => {
    const { scale: _old, ...rest } = p;
    return s === 1 ? rest : { ...rest, scale: s };
  });
  if (!manifest || next === state) return next;
  const it = next.items[index];
  const c = manifest.components.find((x) => x.id === it.id);
  if (!c) return next;
  const settled = settlePlacement(placementRegions(manifest, next), c, it, natural);
  return settled === it ? next : updateItem(next, index, () => settled);
}

export function flipItem(state: RoomState, index: number): RoomState {
  return updateItem(state, index, (p) => {
    const { flip, ...rest } = p;
    return flip ? rest : { ...rest, flip: true };
  });
}

export function setItemTint(manifest: RoomPresetManifest, state: RoomState, index: number, tint: string): RoomState {
  const it = state.items[index];
  const c = it && manifest.components.find((x) => x.id === it.id);
  if (!c?.tintable || !/^#[0-9a-f]{6}$/i.test(tint)) return state;
  return updateItem(state, index, (p) => ({ ...p, tint: tint.toLowerCase() }));
}

/** An item's pattern (261105), like setSlotPattern. */
export function setItemPattern(manifest: RoomPresetManifest, state: RoomState, index: number, pattern: string): RoomState {
  const it = state.items[index];
  const c = it && manifest.components.find((x) => x.id === it.id);
  if (!c?.tintable) return state;
  if (pattern === PLAIN_PATTERN) {
    return updateItem(state, index, ({ pattern: _p, ...rest }) => (c.defaultPattern ? { ...rest, pattern: PLAIN_PATTERN } : rest));
  }
  if (!patternsFor(manifest, c).some((p) => p.id === pattern)) return state;
  return updateItem(state, index, (p) => ({ ...p, pattern }));
}

/** An item's second pattern colour (261105). null = tone-on-tone. */
export function setItemAccent(manifest: RoomPresetManifest, state: RoomState, index: number, accent: string | null): RoomState {
  const it = state.items[index];
  const c = it && manifest.components.find((x) => x.id === it.id);
  if (!c?.tintable) return state;
  if (accent === null) return updateItem(state, index, ({ accent: _a, ...rest }) => rest);
  if (!HEX.test(accent)) return state;
  return updateItem(state, index, (p) => ({ ...p, accent: accent.toLowerCase() }));
}

export function removeItem(state: RoomState, index: number): RoomState {
  if (index < 0 || index >= state.items.length) return state;
  return withItems(state, state.items.filter((_, i) => i !== index));
}

export function setRoomTime(state: RoomState, time: RoomState['time']): RoomState {
  return state.time === time ? state : { ...state, time };
}

export function setRoomAvatar(state: RoomState, avatar: RoomState['avatar']): RoomState {
  return { ...state, avatar };
}

/** Move to another preset: its default room, keeping her avatar and the time setting. */
export function switchPreset(state: RoomState, preset: RoomPresetManifest['id']): RoomState {
  if (state.preset === preset) return state;
  return { ...defaultRoomState(preset), time: state.time, avatar: state.avatar };
}

/** The tint a slot or item shows now (its own, else the component default). */
export function currentTint(component: RoomComponent | undefined, own: string | undefined): string | null {
  if (!component?.tintable) return null;
  return own ?? component.defaultTint ?? null;
}

function colourDistance(a: string, b: string): number {
  const p = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Preset swatches per colour row (the custom picker is always the next cell). */
export const PALETTE_SIZE = 8;

/**
 * The house palette for a part whose pack lists no swatches of its own
 * (261105 colour pass): warm interior tones, light to dark, that sit well
 * in a painted room (linen, oatmeal, dusty rose, sage, mustard, terracotta,
 * slate blue, navy).
 */
export const DEFAULT_SWATCHES: readonly string[] = ['#f2ece2', '#dccdb4', '#dfb0a6', '#a7b591', '#d3a64d', '#bd6b4e', '#6b82a0', '#38425e'];

/** The house second-colour palette: a light, a neutral, warm and cool accents and a deep one. */
export const DEFAULT_ACCENT_SWATCHES: readonly string[] = ['#f6f1e7', '#a39b90', '#d3a64d', '#bd6b4e', '#8fa27e', '#6b82a0', '#33343b'];

/**
 * Swatches for a tintable component's main colour: its default tint first
 * (so a room keeps its shipped look), then its own palette or the house set,
 * deduped. PALETTE_SIZE cells in all; a light that offers a colour cycle
 * gives one cell to the cycle swatch.
 */
export function swatchesFor(component: RoomComponent): string[] {
  const out = paletteOf([component.defaultTint, ...(component.swatches ?? DEFAULT_SWATCHES)]);
  return out.slice(0, component.cycle ? PALETTE_SIZE - 1 : PALETTE_SIZE);
}

/** Swatches for the second pattern colour: the row's first cell is the automatic tone-on-tone, then these. */
export function accentSwatchesFor(component: RoomComponent): string[] {
  return paletteOf(component.accentSwatches ?? DEFAULT_ACCENT_SWATCHES).slice(0, PALETTE_SIZE - 1);
}

/** Valid hex colours, lower-cased, with near-duplicates dropped (two swatches that look the same are one choice). */
function paletteOf(list: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const h of list) {
    if (!h || !/^#[0-9a-f]{6}$/i.test(h)) continue;
    const v = h.toLowerCase();
    if (!out.some((o) => colourDistance(o, v) < 22)) out.push(v);
  }
  return out;
}

/** Whether a colour is one of a row's preset swatches (else the editor shows it as the custom colour). */
export function isPresetColour(swatches: readonly string[], hex: string | null | undefined): boolean {
  return !!hex && swatches.includes(hex.toLowerCase());
}

// ── History ─────────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 60;

export interface EditHistory {
  /** Older states, oldest first. */
  past: RoomState[];
  present: RoomState;
  /** What is on disk (null = never saved this session and nothing loaded). */
  saved: RoomState | null;
  /** Gesture key of the last edit while a gesture is open (a colour drag). */
  gesture: string | null;
}

export function createHistory(state: RoomState, saved: RoomState | null = state): EditHistory {
  return { past: [], present: state, saved, gesture: null };
}

/** JSON with sorted keys, so two equal states compare equal whatever order their keys were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function sameState(a: RoomState | null, b: RoomState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}

/**
 * Apply an edit. With a `gesture` key, edits under the same key replace the
 * present instead of stacking (one undo step per drag) until endGesture().
 * A no-op edit changes nothing.
 */
export function commitEdit(h: EditHistory, next: RoomState, gesture: string | null = null): EditHistory {
  if (next === h.present || sameState(next, h.present)) return gesture === h.gesture ? h : { ...h, gesture };
  if (gesture !== null && gesture === h.gesture) return { ...h, present: next };
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { ...h, past, present: next, gesture };
}

export function endGesture(h: EditHistory): EditHistory {
  return h.gesture === null ? h : { ...h, gesture: null };
}

export function canUndo(h: EditHistory): boolean {
  return h.past.length > 0;
}

export function undo(h: EditHistory): EditHistory {
  if (!h.past.length) return h;
  const past = h.past.slice(0, -1);
  return { ...h, past, present: h.past[h.past.length - 1], gesture: null };
}

/**
 * After a save: the sanitized state main wrote is the clean point. `sent` is
 * the state that was saved; when the present is still that state it becomes
 * main's copy (same content, maybe cleaned), and when edits landed during the
 * save they are kept (and stay dirty).
 */
export function markSaved(h: EditHistory, saved: RoomState, sent: RoomState = h.present): EditHistory {
  if (h.present !== sent) return { ...h, saved };
  const present = sameState(saved, h.present) ? h.present : saved;
  return { ...h, present, saved: present, gesture: null };
}

export function isDirty(h: EditHistory): boolean {
  return !sameState(h.present, h.saved);
}
