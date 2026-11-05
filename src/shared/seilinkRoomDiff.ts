/**
 * What changed in her room (261105, T335): a plain list from the room before
 * an editor session to the room after it, for her reaction line and for the
 * next chat or call turn (main/seilink/roomReaction.ts).
 *
 * Both states are sanitized against their pack manifest (roomStore), so every
 * id here is one the manifest knows. Names come from the manifest the same way
 * look() names things (component.name, tintName, the pattern adjective), so
 * she calls a thing by the name she already knows it by. Colours, patterns and
 * light cycles are compared as she would see them (resolveSlots: a slot saved
 * with its default tint is not a change). An undo back to the start is no
 * change at all.
 *
 * Pure and shape-free: the list is model-facing text and never goes to
 * analytics (only its length, bucketed).
 */
import {
  resolvePattern,
  resolveSlots,
  tintName,
  type ResolvedSlot,
  type RoomComponent,
  type RoomItemPlacement,
  type RoomPresetManifest,
  type RoomSlotId,
  type RoomState,
} from './seilinkRoom';

export type RoomChangeKind =
  | 'preset'
  | 'add_part'
  | 'remove_part'
  | 'swap_part'
  | 'view'
  | 'add_item'
  | 'remove_item'
  | 'recolour'
  | 'pattern'
  | 'accent'
  | 'light_cycle'
  | 'move'
  | 'scale'
  | 'flip'
  | 'layer'
  | 'time'
  | 'avatar';

export interface RoomChange {
  kind: RoomChangeKind;
  /** One plain clause, past tense, the player as the subject: "moved the floor cushion to the left". */
  text: string;
}

/** Bigger, more visible changes first, so the capped list keeps them. */
const WEIGHT: Readonly<Record<RoomChangeKind, number>> = {
  preset: 100,
  swap_part: 80,
  add_part: 80,
  remove_part: 80,
  view: 75,
  add_item: 70,
  remove_item: 70,
  recolour: 60,
  pattern: 60,
  light_cycle: 58,
  move: 50,
  time: 45,
  scale: 40,
  accent: 35,
  flip: 30,
  avatar: 25,
  layer: 20,
};

/** A move shorter than this fraction of the canvas width is a slip of the mouse, not a move. */
export const MOVE_MIN_FRACTION = 0.01;
/** A scale change smaller than this ratio reads as no change. */
const SCALE_MIN_RATIO = 1.08;

const TIME_WORDS: Readonly<Record<string, string>> = { day: 'daytime', dusk: 'dusk', night: 'night' };

/** Pack text into a clause: one line, no control characters, bounded. */
function plain(raw: string, max = 40): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

function nameOf(c: RoomComponent): string {
  return plain(c.name) || 'thing';
}

/** "a stack of books", "an old lamp", "some little mushrooms". */
export function withArticle(name: string): string {
  const first = name.split(' ')[0].toLowerCase();
  const plural = /[^s]s$/i.test(name) && !/^(stack|can|pair|set|pile|bunch|box|jar|bag)$/.test(first) && !/\b(of|on|with)\b/.test(name);
  if (plural) return `some ${name}`;
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
}

function sameAvatar(a: RoomState['avatar'], b: RoomState['avatar']): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'sei' || (b.kind === 'live2d' && a.modelPath === b.modelPath);
}

/** The look of one part (a slot or an item) as she would see it. */
interface Look {
  tint: string | undefined;
  pattern: string | null;
  patternWord: string | null;
  accent: string | null;
  cycle: boolean;
}

function slotLook(r: ResolvedSlot): Look {
  return {
    tint: r.component.tintable ? r.tint : undefined,
    pattern: r.pattern?.def.id ?? null,
    patternWord: r.pattern ? plain(r.pattern.def.adjective, 24) : null,
    accent: r.pattern ? r.pattern.accent.toLowerCase() : null,
    cycle: r.cycle === true,
  };
}

function itemLook(manifest: RoomPresetManifest, c: RoomComponent, it: RoomItemPlacement): Look {
  const tint = c.tintable ? (it.tint ?? c.defaultTint) : undefined;
  const p = resolvePattern(manifest, c, tint, it.pattern, it.accent);
  return { tint, pattern: p?.def.id ?? null, patternWord: p ? plain(p.def.adjective, 24) : null, accent: p ? p.accent.toLowerCase() : null, cycle: false };
}

/** Colour, pattern and light-cycle changes of one part. */
function lookChanges(name: string, a: Look, b: Look, out: RoomChange[]): void {
  if (a.cycle !== b.cycle) {
    out.push({ kind: 'light_cycle', text: b.cycle ? `set the ${name} to cycle through colours` : `stopped the ${name} cycling through colours` });
  }
  // A cycling light shows every colour, so its base colour is not news.
  if (!b.cycle && (a.tint ?? '').toLowerCase() !== (b.tint ?? '').toLowerCase()) {
    const from = tintName(a.tint);
    const to = tintName(b.tint);
    if (from && to && from !== to) out.push({ kind: 'recolour', text: `changed the ${name} from ${from} to ${to}` });
    else if (to) out.push({ kind: 'recolour', text: `changed the ${name} to a different shade of ${to}` });
    else out.push({ kind: 'recolour', text: `changed the colour of the ${name}` });
  }
  if (a.pattern !== b.pattern) {
    if (!b.pattern) out.push({ kind: 'pattern', text: `took the pattern off the ${name}` });
    else if (!a.pattern) out.push({ kind: 'pattern', text: `gave the ${name} a ${b.patternWord || 'new'} pattern` });
    else out.push({ kind: 'pattern', text: `changed the pattern on the ${name} to ${b.patternWord || 'a new one'}` });
  } else if (a.pattern && a.accent !== b.accent) {
    const to = tintName(b.accent ?? undefined);
    out.push({ kind: 'accent', text: to ? `changed the second colour in the ${name} pattern to ${to}` : `changed the second colour in the ${name} pattern` });
  }
}

function direction(c: RoomComponent, dx: number, dy: number): string {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'to the left' : 'to the right';
  if (c.placement === 'floor') return dy < 0 ? 'further back' : 'closer to the front';
  return dy < 0 ? 'higher up' : 'lower down';
}

/** Pair the placements of one item id before and after, nearest first. */
function pairItems(a: RoomItemPlacement[], b: RoomItemPlacement[]): { pairs: Array<[RoomItemPlacement, RoomItemPlacement]>; added: RoomItemPlacement[]; removed: RoomItemPlacement[] } {
  const cand: Array<{ i: number; j: number; d: number }> = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) cand.push({ i, j, d: Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y) });
  cand.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Array<[RoomItemPlacement, RoomItemPlacement]> = [];
  for (const { i, j } of cand) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    pairs.push([a[i], b[j]]);
  }
  return { pairs, added: b.filter((_, j) => !usedB.has(j)), removed: a.filter((_, i) => !usedA.has(i)) };
}

/**
 * Every change from `before` to `after`, biggest first. `beforeManifest` is
 * the pack the before state was sanitized against; it differs from
 * `afterManifest` only when the preset changed (then that is the one change).
 */
export function roomChanges(beforeManifest: RoomPresetManifest, before: RoomState, afterManifest: RoomPresetManifest, after: RoomState): RoomChange[] {
  if (before.preset !== after.preset || beforeManifest.id !== afterManifest.id) {
    return [{ kind: 'preset', text: `moved you to ${plain(afterManifest.place, 60) || 'a different room'}` }];
  }
  const manifest = afterManifest;
  const out: RoomChange[] = [];

  if (before.time !== after.time) {
    out.push({
      kind: 'time',
      text: after.time === 'auto' ? 'set your room to follow the real time of day again' : `set your room to always look like ${TIME_WORDS[after.time] ?? after.time}`,
    });
  }
  if (!sameAvatar(before.avatar, after.avatar)) out.push({ kind: 'avatar', text: 'changed how you look in your room' });

  const slotsA = new Map(resolveSlots(manifest, before).map((r) => [r.slot, r]));
  const slotsB = new Map(resolveSlots(manifest, after).map((r) => [r.slot, r]));
  for (const slot of Object.keys(manifest.slots) as RoomSlotId[]) {
    const a = slotsA.get(slot);
    const b = slotsB.get(slot);
    if (!a && !b) continue;
    if (!a && b) out.push({ kind: 'add_part', text: `added ${withArticle(nameOf(b.component))}` });
    else if (a && !b) out.push({ kind: 'remove_part', text: `took away the ${nameOf(a.component)}` });
    else if (a && b && a.component.id !== b.component.id) {
      if (slot === 'view') out.push({ kind: 'view', text: `changed the view outside to ${withArticle(nameOf(b.component))}` });
      else out.push({ kind: 'swap_part', text: `swapped the ${nameOf(a.component)} for ${withArticle(nameOf(b.component))}` });
    } else if (a && b) lookChanges(nameOf(b.component), slotLook(a), slotLook(b), out);
  }

  const byId = new Map(manifest.components.map((c) => [c.id, c]));
  const ids = [...new Set([...before.items.map((i) => i.id), ...after.items.map((i) => i.id)])];
  const minMove = MOVE_MIN_FRACTION * (manifest.canvas[0] || 1);
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const name = nameOf(c);
    const { pairs, added, removed } = pairItems(
      before.items.filter((i) => i.id === id),
      after.items.filter((i) => i.id === id),
    );
    for (let k = 0; k < added.length; k++) out.push({ kind: 'add_item', text: `added ${withArticle(name)}` });
    for (let k = 0; k < removed.length; k++) out.push({ kind: 'remove_item', text: `took away the ${name}` });
    for (const [a, b] of pairs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) >= minMove) out.push({ kind: 'move', text: `moved the ${name} ${direction(c, dx, dy)}` });
      const ratio = (b.scale ?? 1) / (a.scale ?? 1);
      if (ratio >= SCALE_MIN_RATIO) out.push({ kind: 'scale', text: `made the ${name} bigger` });
      else if (ratio <= 1 / SCALE_MIN_RATIO) out.push({ kind: 'scale', text: `made the ${name} smaller` });
      if ((a.flip ?? false) !== (b.flip ?? false)) out.push({ kind: 'flip', text: `turned the ${name} around` });
      if ((a.z ?? null) !== (b.z ?? null)) {
        out.push({ kind: 'layer', text: (b.z ?? 0) > (a.z ?? 0) ? `brought the ${name} in front of other things` : `put the ${name} behind other things` });
      }
      lookChanges(name, itemLook(manifest, c, a), itemLook(manifest, c, b), out);
    }
  }
  // Stable: equal weights keep the order above (room parts, then items).
  return out.map((ch, i) => ({ ch, i })).sort((p, q) => WEIGHT[q.ch.kind] - WEIGHT[p.ch.kind] || p.i - q.i).map((p) => p.ch);
}

/** How many changes the reaction and the chat note name at most. */
export const ROOM_CHANGE_LIST_MAX = 5;

/**
 * The list as one plain line: "moved the floor cushion to the left; changed
 * the curtains from blue to pink". Repeats fold into one ("added a little
 * succulent, twice"); past the cap, "and 3 smaller changes".
 */
export function roomChangeLine(changes: RoomChange[], max = ROOM_CHANGE_LIST_MAX): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.text, (counts.get(c.text) ?? 0) + 1);
  const unique = [...counts.entries()];
  const shown = unique.slice(0, max).map(([text, n]) => (n === 1 ? text : n === 2 ? `${text}, twice` : `${text}, ${n} times`));
  const rest = unique.length - shown.length;
  if (rest > 0) shown.push(rest === 1 ? 'and one smaller change' : `and ${rest} smaller changes`);
  return shown.join('; ');
}

/** Analytics bucket for the number of changes (never the list itself). */
export function roomChangeBucket(n: number): '0' | '1' | '2' | '3-5' | '6-10' | '11+' {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n <= 5) return '3-5';
  if (n <= 10) return '6-10';
  return '11+';
}
