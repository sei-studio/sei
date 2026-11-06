/**
 * She decorates too (261105, T336). The room edit tool she gets while the
 * player has her room editor open, and the edit ops it turns into.
 *
 *  - The ops are the editor's own (shared/seilinkEdit.ts: addItem, moveItem,
 *    removeItem, setSlotComponent, setSlotTint, setItemTint, setSlotPattern,
 *    setItemPattern, setRoomTime), so a change she makes lands exactly where
 *    and how the same click in the editor would land it: placement snaps by
 *    seilinkPlace.ts, swatches and patterns are the part's own.
 *  - resolveDecorate() checks her tool input against the pack (parts, slots,
 *    palettes, patterns, placement) and turns it into ops, applied in order to
 *    the room as it is now. Anything that does not exist is refused with a
 *    short reason and the real options, never guessed.
 *  - Main runs it to answer the tool; the editor runs applyRoomOps() on its
 *    own present with the same ops and commits the result as ONE undo step.
 *    Ops that point at an item carry its id as well as its index, so an op
 *    whose item moved or went away in the meantime is skipped, not misapplied.
 *  - The tool's schema is small; the room's own catalog (names, colours,
 *    patterns) goes into its description, so it rides in the cached prefix
 *    and only on editor turns.
 *
 * Pure: no DOM, no Node.
 */
import {
  describeRoom,
  patternsFor,
  PLAIN_PATTERN,
  slotLabel,
  withoutPlain,
  type RoomComponent,
  type RoomPresetManifest,
  type RoomSlotId,
  type RoomState,
} from './seilinkRoom';
import {
  addItem,
  moveItem,
  removeItem,
  sameState,
  setItemPattern,
  setItemTint,
  setRoomTime,
  setSlotComponent,
  setSlotPattern,
  setSlotTint,
  slotChoice,
  swatchesFor,
} from './seilinkEdit';
import { roomChanges, type RoomChange } from './seilinkRoomDiff';

export const DECORATE_TOOL_NAME = 'decorate';
/** Changes she may make for one request (one tool call, and one turn in all). */
export const DECORATE_MAX_CHANGES = 5;

export type DecorateSide = 'left' | 'right' | 'middle';
export type DecorateMode = 'apply' | 'suggest';

/** One edit, as the editor would make it. Item ops name the item by index AND id (see applyRoomOp). */
export type RoomEditOp =
  | { op: 'add'; id: string; side?: DecorateSide }
  | { op: 'remove'; index: number; id: string }
  | { op: 'move'; index: number; id: string; side: DecorateSide }
  | { op: 'slot_tint'; slot: RoomSlotId; tint: string }
  | { op: 'item_tint'; index: number; id: string; tint: string }
  | { op: 'slot_pattern'; slot: RoomSlotId; pattern: string }
  | { op: 'item_pattern'; index: number; id: string; pattern: string }
  | { op: 'swap'; slot: RoomSlotId; id: string | null }
  | { op: 'time'; time: RoomState['time'] };

const SIDE_X: Readonly<Record<DecorateSide, number>> = { left: 0.22, middle: 0.5, right: 0.78 };

function itemAt(state: RoomState, index: number, id: string): boolean {
  return state.items[index]?.id === id;
}

function moveToSide(manifest: RoomPresetManifest, state: RoomState, index: number, side: DecorateSide): RoomState {
  const it = state.items[index];
  if (!it) return state;
  return moveItem(manifest, state, index, Math.round(manifest.canvas[0] * SIDE_X[side]), it.y);
}

/** One op on a room (the editor's own reducer). An op that no longer fits the room returns the room unchanged. */
export function applyRoomOp(manifest: RoomPresetManifest, state: RoomState, op: RoomEditOp): RoomState {
  switch (op.op) {
    case 'add': {
      const r = addItem(manifest, state, op.id);
      if (r.index < 0) return state;
      return op.side ? moveToSide(manifest, r.state, r.index, op.side) : r.state;
    }
    case 'remove':
      return itemAt(state, op.index, op.id) ? removeItem(state, op.index) : state;
    case 'move':
      return itemAt(state, op.index, op.id) ? moveToSide(manifest, state, op.index, op.side) : state;
    case 'slot_tint':
      return setSlotTint(manifest, state, op.slot, op.tint);
    case 'item_tint':
      return itemAt(state, op.index, op.id) ? setItemTint(manifest, state, op.index, op.tint) : state;
    case 'slot_pattern':
      return setSlotPattern(manifest, state, op.slot, op.pattern);
    case 'item_pattern':
      return itemAt(state, op.index, op.id) ? setItemPattern(manifest, state, op.index, op.pattern) : state;
    case 'swap':
      return setSlotComponent(manifest, state, op.slot, op.id);
    case 'time':
      return setRoomTime(state, op.time);
    default:
      return state;
  }
}

/** Apply ops in order. `applied` = the ops that changed something. */
export function applyRoomOps(manifest: RoomPresetManifest, state: RoomState, ops: readonly RoomEditOp[]): { state: RoomState; applied: RoomEditOp[] } {
  let s = state;
  const applied: RoomEditOp[] = [];
  for (const op of ops) {
    const next = applyRoomOp(manifest, s, op);
    if (!sameState(next, s)) applied.push(op);
    s = next;
  }
  // 261106: on the plain first state her changes set the (bare) room up, so they show.
  if (applied.length && s.plain) s = withoutPlain(s);
  return { state: s, applied };
}

// ── Colour words ────────────────────────────────────────────────────────────

/** Names she can use for a swatch: plain interior colour words. */
const NAMED: ReadonlyArray<[string, string]> = [
  ['white', '#f6f3ec'],
  ['cream', '#eee4cf'],
  ['beige', '#d8c6a6'],
  ['tan', '#c2a27a'],
  ['brown', '#7a5638'],
  ['peach', '#f0c4a8'],
  ['coral', '#e8836b'],
  ['terracotta', '#bd6b4e'],
  ['rust', '#a5502e'],
  ['red', '#c8383c'],
  ['burgundy', '#7d2a3c'],
  ['pink', '#e8a6b4'],
  ['dusty rose', '#c99594'],
  ['hot pink', '#f05fa8'],
  ['mauve', '#a07a96'],
  ['plum', '#6a3d5e'],
  ['lavender', '#b8a8d8'],
  ['purple', '#7a52a8'],
  ['navy', '#2f3a5e'],
  ['slate blue', '#6b82a0'],
  ['blue', '#4a78c8'],
  ['sky blue', '#9cc4ff'],
  ['teal', '#2f7f84'],
  ['turquoise', '#3cd6e6'],
  ['mint', '#8fdcb4'],
  ['sage', '#a7b591'],
  ['olive', '#7f875c'],
  ['green', '#4f9a5a'],
  ['forest green', '#3f5a3c'],
  ['mustard', '#d3a64d'],
  ['yellow', '#f2d65c'],
  ['orange', '#f08a3c'],
  ['gray', '#9a9ca2'],
  ['charcoal', '#3b3e48'],
  ['black', '#1b1d24'],
];

function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(n >> 16);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const NAMED_LAB = NAMED.map(([name, hex]) => ({ name, lab: lab(hex) }));

/** The nearest colour word for a hex. */
export function colourWord(hex: string): string {
  const p = lab(hex.toLowerCase());
  let best = NAMED_LAB[0];
  let bestD = Infinity;
  for (const c of NAMED_LAB) {
    const d = (c.lab[0] - p[0]) ** 2 + (c.lab[1] - p[1]) ** 2 + (c.lab[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.name;
}

/** A word for every swatch of a row, unique in the row ("light sage", "sage", "dark sage" when they share one). */
export function paletteWords(hexes: readonly string[]): Array<{ hex: string; word: string }> {
  const out = hexes.map((hex) => ({ hex, word: colourWord(hex) }));
  const groups = new Map<string, Array<{ hex: string; word: string }>>();
  for (const o of out) groups.set(o.word, [...(groups.get(o.word) ?? []), o]);
  for (const [word, g] of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => lab(b.hex)[0] - lab(a.hex)[0]);
    g.forEach((o, i) => {
      if (g.length === 2) o.word = i === 0 ? `light ${word}` : `dark ${word}`;
      else if (i === 0) o.word = `light ${word}`;
      else if (i === g.length - 1) o.word = `dark ${word}`;
      else o.word = i === 1 ? word : `${word} ${i}`;
    });
  }
  return out;
}

// ── Names ───────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|some|my|your|her|his)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does `asked` name `name`? Exact, or one contains the other (whole words). */
function names(asked: string, name: string): boolean {
  const a = norm(asked);
  const n = norm(name);
  if (!a || !n) return false;
  if (a === n) return true;
  const singular = (s: string): string => s.replace(/s\b/g, '');
  if (singular(a) === singular(n)) return true;
  return ` ${n} `.includes(` ${a} `) || ` ${a} `.includes(` ${n} `);
}

function plainName(c: RoomComponent): string {
  return c.name.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** The slot a target names: its label ("Curtains"), its id, or the name of the part in it now. */
function findSlot(manifest: RoomPresetManifest, state: RoomState, target: string): RoomSlotId | null {
  const slots = Object.keys(manifest.slots) as RoomSlotId[];
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  for (const s of slots) if (names(target, slotLabel(manifest, s)) || names(target, s)) return s;
  for (const s of slots) {
    const id = slotChoice(manifest, state, s);
    const c = id ? byId.get(id) : undefined;
    if (c && names(target, c.name)) return s;
  }
  // A part that is not in the room now (an empty optional slot, another option).
  for (const s of slots) {
    for (const id of manifest.slots[s]?.options ?? []) {
      const c = byId.get(id);
      if (c && names(target, c.name)) return s;
    }
  }
  return null;
}

function findItemComponent(manifest: RoomPresetManifest, target: string): RoomComponent | null {
  const items = manifest.components.filter((c) => c.slot === 'item');
  return items.find((c) => norm(c.name) === norm(target)) ?? items.find((c) => names(target, c.name)) ?? null;
}

/** A placed item the target names (the first one when there are several). */
function findPlaced(manifest: RoomPresetManifest, state: RoomState, target: string): { index: number; component: RoomComponent } | null {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  for (let i = 0; i < state.items.length; i++) {
    const c = byId.get(state.items[i].id);
    if (c && names(target, c.name)) return { index: i, component: c };
  }
  return null;
}

function slotComponent(manifest: RoomPresetManifest, state: RoomState, slot: RoomSlotId): RoomComponent | null {
  const id = slotChoice(manifest, state, slot);
  return (id && manifest.components.find((c) => c.id === id)) || null;
}

function pickColour(component: RoomComponent, value: string): string | null {
  const v = value.trim().toLowerCase();
  const words = paletteWords(swatchesFor(component));
  if (/^#[0-9a-f]{6}$/.test(v)) return words.some((w) => w.hex === v) ? v : null;
  return (words.find((w) => w.word === norm(v)) ?? words.find((w) => names(v, w.word)))?.hex ?? null;
}

function colourList(component: RoomComponent): string {
  return paletteWords(swatchesFor(component))
    .map((w) => w.word)
    .join(', ');
}

function pickPattern(manifest: RoomPresetManifest, component: RoomComponent, value: string): string | null {
  const v = norm(value);
  if (/^(plain|none|no pattern|solid)$/.test(v)) return PLAIN_PATTERN;
  const defs = patternsFor(manifest, component);
  return (defs.find((d) => norm(d.adjective) === v || norm(d.name) === v || d.id === v) ?? defs.find((d) => names(v, d.adjective) || names(v, d.name)))?.id ?? null;
}

function patternList(manifest: RoomPresetManifest, component: RoomComponent): string {
  return [...new Set(patternsFor(manifest, component).map((d) => d.adjective))].join(', ');
}

function parseSide(value: string | undefined): DecorateSide | null {
  const v = norm(value ?? '');
  if (/\bleft\b/.test(v)) return 'left';
  if (/\bright\b/.test(v)) return 'right';
  if (/\b(middle|center|centre)\b/.test(v)) return 'middle';
  return null;
}

const TIMES: Readonly<Record<string, RoomState['time']>> = { auto: 'auto', clock: 'auto', real: 'auto', day: 'day', daytime: 'day', dusk: 'dusk', evening: 'dusk', sunset: 'dusk', night: 'night' };

// ── The tool ────────────────────────────────────────────────────────────────

export interface DecorateChange {
  do?: unknown;
  target?: unknown;
  value?: unknown;
}

export interface DecorateInput {
  mode?: unknown;
  changes?: unknown;
}

export interface DecorateResult {
  mode: DecorateMode;
  /** The ops, in order, as applied to `before` (suggest: what would be applied). */
  ops: RoomEditOp[];
  /** The room after the ops (suggest: the room it would become). */
  state: RoomState;
  /** What changed, in the change list's words (shared/seilinkRoomDiff). */
  done: RoomChange[];
  /** Refused changes, one short reason each (model-facing). */
  rejected: string[];
}

/** Would the player see a difference? (A tint set to the part's own default is no change.) */
function visible(manifest: RoomPresetManifest, a: RoomState, b: RoomState): boolean {
  try {
    return roomChanges(manifest, a, manifest, b).length > 0;
  } catch {
    return true;
  }
}

function str(v: unknown, max = 60): string {
  return typeof v === 'string' ? v.slice(0, max).trim() : '';
}

/**
 * Turn one change into an op against `state`, or a refusal. Exported for tests.
 * Nothing outside the pack gets through: a part, colour, pattern or spot that
 * does not exist here is refused with what there is instead.
 */
export function resolveChange(manifest: RoomPresetManifest, state: RoomState, ch: DecorateChange): RoomEditOp | string {
  const what = str(ch.do, 12).toLowerCase();
  const target = str(ch.target);
  const value = str(ch.value);
  const label = target || value || what || 'that';
  switch (what) {
    case 'time': {
      const t = TIMES[norm(value || target)];
      return t ? { op: 'time', time: t } : `"${label}": the time of day can be auto, day, dusk or night`;
    }
    case 'add': {
      const name = target || value;
      const c = findItemComponent(manifest, name);
      if (c) {
        const side = parseSide(value === name ? '' : value);
        return side ? { op: 'add', id: c.id, side } : { op: 'add', id: c.id };
      }
      // An optional part that is not in the room now ("add the curtains back").
      const slot = findSlot(manifest, state, name);
      if (slot) {
        const def = manifest.slots[slot]!;
        const want = def.options.map((id) => manifest.components.find((x) => x.id === id)).find((x) => x && names(name, x.name));
        const id = want?.id ?? def.options[0];
        if (slotChoice(manifest, state, slot) === id) return `"${label}" is already in the room`;
        return { op: 'swap', slot, id };
      }
      return `"${label}" is not something this room has`;
    }
    case 'remove': {
      const placed = findPlaced(manifest, state, target || value);
      if (placed) return { op: 'remove', index: placed.index, id: placed.component.id };
      const slot = findSlot(manifest, state, target || value);
      if (slot) {
        if (!manifest.slots[slot]?.optional) return `the ${slotLabel(manifest, slot).toLowerCase()} cannot be taken out of this room`;
        if (slotChoice(manifest, state, slot) === null) return `"${label}" is not in the room now`;
        return { op: 'swap', slot, id: null };
      }
      return `"${label}" is not in the room now`;
    }
    case 'move': {
      const placed = findPlaced(manifest, state, target);
      if (!placed) return `"${label}" is not an item in the room now (only items can be moved, not room parts)`;
      const side = parseSide(value);
      if (!side) return `"${value || 'there'}": items can be moved to the left, right or middle`;
      return { op: 'move', index: placed.index, id: placed.component.id, side };
    }
    case 'color':
    case 'colour': {
      const placed = findPlaced(manifest, state, target);
      const slot = placed ? null : findSlot(manifest, state, target);
      const comp = placed?.component ?? (slot ? slotComponent(manifest, state, slot) : null);
      if (!comp) return `"${label}" is not in the room now`;
      if (!comp.tintable) return `the ${plainName(comp)} only comes in one colour`;
      const hex = pickColour(comp, value);
      if (!hex) return `no "${value || 'such'}" colour for the ${plainName(comp)}; its colours are ${colourList(comp)}`;
      return placed ? { op: 'item_tint', index: placed.index, id: comp.id, tint: hex } : { op: 'slot_tint', slot: slot!, tint: hex };
    }
    case 'pattern': {
      const placed = findPlaced(manifest, state, target);
      const slot = placed ? null : findSlot(manifest, state, target);
      const comp = placed?.component ?? (slot ? slotComponent(manifest, state, slot) : null);
      if (!comp) return `"${label}" is not in the room now`;
      const offered = patternList(manifest, comp);
      if (!offered) return `the ${plainName(comp)} takes no patterns`;
      const id = pickPattern(manifest, comp, value);
      if (!id) return `no "${value || 'such'}" pattern for the ${plainName(comp)}; it can be plain or ${offered}`;
      return placed ? { op: 'item_pattern', index: placed.index, id: comp.id, pattern: id } : { op: 'slot_pattern', slot: slot!, pattern: id };
    }
    case 'swap': {
      const slot = findSlot(manifest, state, target) ?? findSlot(manifest, state, value);
      if (!slot) return `"${label}" is not a part of this room`;
      const def = manifest.slots[slot]!;
      const options = def.options.map((id) => manifest.components.find((x) => x.id === id)).filter((x): x is RoomComponent => Boolean(x));
      if (/^(none|nothing|remove)$/.test(norm(value))) {
        return def.optional ? { op: 'swap', slot, id: null } : `the ${slotLabel(manifest, slot).toLowerCase()} cannot be taken out of this room`;
      }
      const want = options.find((c) => names(value, c.name)) ?? (value ? null : options.find((c) => c.id !== slotChoice(manifest, state, slot)));
      if (!want) return `the ${slotLabel(manifest, slot).toLowerCase()} can be ${options.map(plainName).join(', ')}${def.optional ? ', or none' : ''}`;
      return { op: 'swap', slot, id: want.id };
    }
    default:
      return `"${what || 'that'}" is not a change you can make (use add, remove, move, color, pattern, swap or time)`;
  }
}

/**
 * Her decorate() input against the room as it is now. Changes are resolved
 * and applied one after another (a later change sees the earlier ones), at
 * most `max` of them; the rest are refused. `suggest` resolves the same way
 * but is not applied by anyone until the player taps to try it.
 */
export function resolveDecorate(manifest: RoomPresetManifest, before: RoomState, input: DecorateInput, max = DECORATE_MAX_CHANGES): DecorateResult {
  const mode: DecorateMode = input.mode === 'suggest' ? 'suggest' : 'apply';
  const list = Array.isArray(input.changes) ? (input.changes as unknown[]) : [];
  const ops: RoomEditOp[] = [];
  const rejected: string[] = [];
  // 261106: on the plain first state her changes are made to the bare room underneath (applyRoomOps sets it up the same way).
  const base = withoutPlain(before);
  let state = base;
  for (const raw of list) {
    if (ops.length >= max) {
      rejected.push(`only ${max} changes at a time, so the rest were left out`);
      break;
    }
    const r = resolveChange(manifest, state, (raw && typeof raw === 'object' ? raw : {}) as DecorateChange);
    if (typeof r === 'string') {
      rejected.push(r);
      continue;
    }
    const next = applyRoomOp(manifest, state, r);
    if (sameState(next, state) || !visible(manifest, state, next)) {
      rejected.push(`${str((raw as DecorateChange)?.target) || 'one change'} was already like that`);
      continue;
    }
    ops.push(r);
    state = next;
  }
  if (!list.length) rejected.push('no changes were given');
  if (!ops.length) state = before;
  let done: RoomChange[] = [];
  try {
    done = ops.length ? roomChanges(manifest, base, manifest, state) : [];
  } catch {
    done = [];
  }
  return { mode, ops, state, done, rejected };
}

/** The tool_result text for her (plain, short). */
export function decorateResultText(r: DecorateResult): string {
  const did = r.done
    .slice(0, DECORATE_MAX_CHANGES + 1)
    .map((c) => c.text.replace(/\bmoved you to\b/, 'moved the room to'))
    .join('; ');
  const parts: string[] = [];
  if (r.mode === 'suggest') {
    parts.push(r.ops.length ? `Your idea (${did}) is shown to the player with a button to try it. Nothing has changed yet.` : 'Nothing could be shown.');
  } else {
    parts.push(r.ops.length ? `Done, the room changed: ${did}. The player sees it now and can undo it.` : 'Nothing changed.');
  }
  if (r.rejected.length) parts.push(`Not possible: ${r.rejected.slice(0, 4).join('. ')}.`);
  parts.push('Now say your line to the player.');
  return parts.join(' ');
}

/** The pack's catalog in plain words, for the tool description (stable per pack: no room state). */
export function decorateCatalog(manifest: RoomPresetManifest): string {
  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const parts: string[] = [];
  const slots = (Object.entries(manifest.slots) as Array<[RoomSlotId, NonNullable<RoomPresetManifest['slots'][RoomSlotId]>]>).sort((a, b) => a[1].z - b[1].z);
  for (const [slot, def] of slots) {
    const options = def.options.map((id) => byId.get(id)).filter((c): c is RoomComponent => Boolean(c));
    const tintable = options.filter((c) => c.tintable);
    if (options.length < 2 && !def.optional && !tintable.length) continue;
    const bits: string[] = [];
    if (options.length > 1) bits.push(`options ${options.map(plainName).join(', ')}`);
    else if (options[0] && norm(options[0].name) !== norm(slotLabel(manifest, slot))) bits.push(plainName(options[0]));
    for (const c of tintable) {
      bits.push(`colours ${colourList(c)}`);
      const pats = patternList(manifest, c);
      if (pats) bits.push(`patterns ${pats}`);
    }
    if (def.optional) bits.push('can be removed');
    parts.push(`${slotLabel(manifest, slot)}: ${bits.join('; ')}.`);
  }
  const items = manifest.components.filter((c) => c.slot === 'item');
  const itemText = items
    .map((c) => {
      const bits = [c.placement === 'wall' ? 'wall' : c.placement === 'surface' ? 'shelf' : 'floor'];
      if (c.tintable) {
        bits.push(`colours ${colourList(c)}`);
        const pats = patternList(manifest, c);
        if (pats) bits.push(`patterns ${pats}`);
      }
      return `${plainName(c)} (${bits.join('; ')})`;
    })
    .join(', ');
  if (itemText) parts.push(`Items to add, move left, right or middle, or remove: ${itemText}.`);
  parts.push('Time of day: auto, day, dusk or night.');
  return parts.join(' ');
}

/** The tool definition for this pack. Offered only while the player has her room editor open. */
export function decorateTool(manifest: RoomPresetManifest): { name: string; description: string; input_schema: Record<string, unknown> } {
  return {
    name: DECORATE_TOOL_NAME,
    description:
      'Change your room, which you and the player are decorating together right now. Use it only when they ask you to change something or to have a go yourself. ' +
      `At most ${DECORATE_MAX_CHANGES} changes. Use mode "suggest" when you are not sure they want it: they get a button to try your idea. ` +
      `Use only these names. ${decorateCatalog(manifest)}`,
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['apply', 'suggest'] },
        changes: {
          type: 'array',
          maxItems: DECORATE_MAX_CHANGES,
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['add', 'remove', 'move', 'color', 'pattern', 'swap', 'time'] },
              target: { type: 'string', description: 'part or item name' },
              value: { type: 'string', description: 'colour, pattern, option, left/right/middle, or time' },
            },
            required: ['do'],
          },
        },
      },
      required: ['changes'],
    },
  };
}

/** "In the room now: ..." for her editor turns (what describeRoom says look() sees). */
export function roomNowLine(manifest: RoomPresetManifest, state: RoomState, now = new Date()): string {
  if (state.plain) return 'no room yet, only a plain background around you';
  const things = describeRoom(manifest, state, now).things.slice(0, 16);
  return things.length ? things.join(', ') : 'nothing much yet';
}

/** Which items (indices after the ops) and slots her ops touched, for the editor's highlight. */
export function opTargets(manifest: RoomPresetManifest, before: RoomState, ops: readonly RoomEditOp[]): { items: number[]; slots: RoomSlotId[] } {
  let s = before;
  let items: number[] = [];
  const slots = new Set<RoomSlotId>();
  for (const op of ops) {
    const next = applyRoomOp(manifest, s, op);
    if (sameState(next, s)) continue;
    if (op.op === 'add') items.push(next.items.length - 1);
    else if (op.op === 'move' || op.op === 'item_tint' || op.op === 'item_pattern') items.push(op.index);
    else if (op.op === 'remove') items = items.filter((i) => i !== op.index).map((i) => (i > op.index ? i - 1 : i));
    else if (op.op === 'slot_tint' || op.op === 'slot_pattern' || op.op === 'swap') slots.add(op.slot);
    s = next;
  }
  return { items: [...new Set(items)].filter((i) => i < s.items.length), slots: [...slots] };
}

/** Cheap structural check for ops that crossed IPC (main sent them; the editor re-validates by applying). */
export function isRoomEditOp(v: unknown): v is RoomEditOp {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.op !== 'string') return false;
  const idx = (x: unknown): boolean => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1000;
  const id = (x: unknown): boolean => typeof x === 'string' && x.length > 0 && x.length <= 80;
  const side = (x: unknown): boolean => x === 'left' || x === 'right' || x === 'middle';
  switch (o.op) {
    case 'add':
      return id(o.id) && (o.side === undefined || side(o.side));
    case 'remove':
      return idx(o.index) && id(o.id);
    case 'move':
      return idx(o.index) && id(o.id) && side(o.side);
    case 'slot_tint':
      return id(o.slot) && typeof o.tint === 'string' && /^#[0-9a-f]{6}$/i.test(o.tint);
    case 'item_tint':
      return idx(o.index) && id(o.id) && typeof o.tint === 'string' && /^#[0-9a-f]{6}$/i.test(o.tint);
    case 'slot_pattern':
      return id(o.slot) && id(o.pattern);
    case 'item_pattern':
      return idx(o.index) && id(o.id) && id(o.pattern);
    case 'swap':
      return id(o.slot) && (o.id === null || id(o.id));
    case 'time':
      return o.time === 'auto' || o.time === 'day' || o.time === 'dusk' || o.time === 'night';
    default:
      return false;
  }
}
