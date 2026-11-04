/**
 * SeiLink room editor logic (261104, editor pass). Pure: no DOM, no Node, so
 * the rules are unit-tested and the editor screen (renderer
 * components/seilink/RoomEditor.tsx) stays a thin view over them.
 *
 *  - Placement: where an item's bottom centre may go. Floor items stay on
 *    `manifest.floor`; wall items stay on the wall (the canvas above the
 *    floor's top edge); surface items snap onto the `surfaces` the room's
 *    slot components list (shelf tops), or move freely when there are none.
 *    A drag is clamped to the nearest point of the allowed area.
 *  - Edit ops: small reducers that return a NEW RoomState (never mutate), so
 *    the history can keep every step by reference.
 *  - History: an undo stack with gesture coalescing (one colour drag or one
 *    item drag is one undo step), capped, with a saved marker for "dirty".
 */
import {
  defaultRoomState,
  resolveSlots,
  type RoomBox,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPresetManifest,
  type RoomSlotId,
  type RoomState,
} from './seilinkRoom';

// ── Placement ───────────────────────────────────────────────────────────────

/** Item scale range in the editor (Shawn: a small range). */
export const ITEM_SCALE_MIN = 0.6;
export const ITEM_SCALE_MAX = 1.5;
export const ITEM_SCALE_STEP = 0.1;

/** Fraction of the canvas height treated as floor when a manifest names no floor. */
const DEFAULT_FLOOR_TOP = 0.78;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  const s = Math.round(scale * 100) / 100;
  return Math.max(ITEM_SCALE_MIN, Math.min(ITEM_SCALE_MAX, s));
}

function floorBox(manifest: RoomPresetManifest): RoomBox {
  const [w, h] = manifest.canvas;
  if (manifest.floor) return manifest.floor;
  const top = Math.round(h * DEFAULT_FLOOR_TOP);
  return [0, top, w, h - top];
}

/** Surfaces of the slot components currently in the room (shelf tops). */
export function roomSurfaces(manifest: RoomPresetManifest, state: RoomState): RoomBox[] {
  const out: RoomBox[] = [];
  for (const { component } of resolveSlots(manifest, state)) {
    if (component.surfaces) out.push(...component.surfaces);
  }
  return out;
}

/**
 * Where an item's bottom centre may rest, as boxes (canvas px). Never empty:
 * a surface item in a room with no surfaces gets the whole canvas.
 */
export function placementAreas(manifest: RoomPresetManifest, state: RoomState, component: Pick<RoomComponent, 'placement'>): RoomBox[] {
  const [w, h] = manifest.canvas;
  const where = component.placement ?? 'floor';
  if (where === 'floor') return [floorBox(manifest)];
  if (where === 'wall') {
    const top = floorBox(manifest)[1];
    return [[0, 0, w, Math.max(1, top)]];
  }
  const surfaces = roomSurfaces(manifest, state);
  return surfaces.length ? surfaces : [[0, 0, w, h]];
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

/** Clamp a placement for `component` in this room. */
export function clampPlacement(manifest: RoomPresetManifest, state: RoomState, component: RoomComponent, x: number, y: number): [number, number] {
  return clampToAreas(placementAreas(manifest, state, component), x, y);
}

/**
 * Where a freshly added item lands. A component with a box is drawn there by
 * the pack (the box's bottom centre is the artist's spot), else the middle of
 * its placement area, nudged per copy so two adds do not stack exactly.
 */
export function defaultSpot(manifest: RoomPresetManifest, state: RoomState, component: RoomComponent): [number, number] {
  const copies = state.items.filter((i) => i.id === component.id).length;
  const nudge = copies * 48;
  if (component.box) {
    const [x, y, w, h] = component.box;
    if (copies === 0) return [Math.round(x + w / 2), Math.round(y + h)];
    return clampPlacement(manifest, state, component, x + w / 2 - nudge, y + h);
  }
  const [a] = placementAreas(manifest, state, component);
  return clampToAreas([a], a[0] + a[2] / 2 - nudge, a[1] + a[3] * (component.placement === 'floor' || !component.placement ? 0.6 : 0.5));
}

// ── Edit ops (each returns a new state) ─────────────────────────────────────

function withSlot(state: RoomState, slot: RoomSlotId, entry: { id: string | null; tint?: string }): RoomState {
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
  const entry: { id: string | null; tint?: string } = { id };
  if (prev?.tint && next?.tintable) entry.tint = prev.tint;
  return withSlot(state, slot, entry);
}

export function setSlotTint(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId, tint: string): RoomState {
  const id = slotChoice(manifest, state, slot);
  if (!id || !/^#[0-9a-f]{6}$/i.test(tint)) return state;
  return withSlot(state, slot, { id, tint: tint.toLowerCase() });
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
export function addItem(manifest: RoomPresetManifest, state: RoomState, id: string): { state: RoomState; index: number } {
  const c = manifest.components.find((x) => x.id === id);
  if (!c || c.slot !== 'item') return { state, index: -1 };
  const [x, y] = defaultSpot(manifest, state, c);
  return { state: withItems(state, [...state.items, { id, x, y }]), index: state.items.length };
}

/** Move an item, clamped to where it may sit. */
export function moveItem(manifest: RoomPresetManifest, state: RoomState, index: number, x: number, y: number): RoomState {
  const it = state.items[index];
  const c = it && manifest.components.find((x2) => x2.id === it.id);
  if (!c) return state;
  const [cx, cy] = clampPlacement(manifest, state, c, x, y);
  return updateItem(state, index, (p) => ({ ...p, x: cx, y: cy }));
}

export function scaleItem(state: RoomState, index: number, scale: number): RoomState {
  const s = clampScale(scale);
  return updateItem(state, index, (p) => {
    const { scale: _old, ...rest } = p;
    return s === 1 ? rest : { ...rest, scale: s };
  });
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

/** Soft colours offered when a component lists no swatches of its own. */
export const DEFAULT_SWATCHES: readonly string[] = ['#f2ece2', '#e3b7b0', '#c9b6d8', '#a9bfd9', '#a9c7b4', '#e3cf9a', '#5a5f73'];

/** Swatches for a tintable component: its default tint first, then its own or the house set, deduped, at most 7 (the custom picker is the 8th). */
export function swatchesFor(component: RoomComponent): string[] {
  const out: string[] = [];
  const add = (h: string | undefined): void => {
    if (!h || !/^#[0-9a-f]{6}$/i.test(h)) return;
    const v = h.toLowerCase();
    // Two swatches that look the same are one choice.
    if (!out.some((o) => colourDistance(o, v) < 22)) out.push(v);
  };
  add(component.defaultTint);
  for (const s of component.swatches ?? DEFAULT_SWATCHES) add(s);
  return out.slice(0, 7);
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
