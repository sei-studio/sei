/**
 * The WorldLink status lines typed out letter by letter, like a typewriter,
 * with cycling dots (product feedback (261106), letters (261107)). Pure and
 * deterministic, so a seeked frame (the review renders) shows exactly what
 * the app plays.
 *
 * A line is split into the letters that type in (`typeUnits`: grapheme
 * clusters, so an emoji, a flag or an accented letter is one unit; CJK one
 * character each) and a trailing ellipsis, which is not typed but turns into
 * dots that cycle ".", "..", "..." once the letters are in (`splitEllipsis`:
 * "…", "...", "。。。" or "⋯", in any locale's catalog; the catalogs keep
 * their text as it is). Each letter takes 28 to 40 ms (a fixed spread from
 * the text), a little longer after a space or punctuation (`typeDelays`),
 * the whole line at most TYPE_MAX_MS, after TYPE_START_MS (the line before
 * fading out), so typing always fits inside the shortest dwell and never
 * moves the line's timing.
 */

/** Typing starts this long after the line's start (the line before has faded out by then). */
export const TYPE_START_MS = 300;
/** One letter takes this long, give or take TYPE_SPREAD_MS. */
export const TYPE_CHAR_MS = 34;
export const TYPE_SPREAD_MS = 6;
/** Added after a space (the small beat between words). */
export const TYPE_SPACE_MS = 12;
/** Added after punctuation (",", ".", "、", "。" ...). */
export const TYPE_PUNCT_MS = 45;
/** A whole line types in within this (a long translation types faster). Under the 2.8 s dwell with TYPE_START_MS. */
export const TYPE_MAX_MS = 1800;
/** A letter comes up over this (barely a fade, so it reads as typed but does not flicker). */
export const CHAR_IN_MS = 20;
/** The dots step every this long: ".", "..", "...", "." ... */
export const DOT_STEP_MS = 400;

/** A trailing ellipsis: "…", "...", "。。。", "⋯" (and repeats, like "……"). */
const ELLIPSIS_RE = /(?:…+|\.{3,}|。{3,}|⋯+)\s*$/u;

export interface SplitLine {
  /** The text before the ellipsis (the letters that type in). */
  body: string;
  /** The dot the cycling dots are made of ("." or "。"), or null: the line has no ellipsis. */
  dot: string | null;
}

export function splitEllipsis(text: string): SplitLine {
  const m = ELLIPSIS_RE.exec(text);
  if (!m) return { body: text, dot: null };
  return { body: text.slice(0, m.index), dot: m[0].trimEnd().startsWith('。') ? '。' : '.' };
}

type Segmenter = { segment(s: string): Iterable<{ segment: string }> };

let graphemes: Segmenter | null | undefined;

function segmenter(): Segmenter | null {
  if (graphemes !== undefined) return graphemes;
  try {
    const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
    graphemes = S ? new S(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    graphemes = null;
  }
  return graphemes;
}

/**
 * The letters a line types in, in order; joined they are the text exactly.
 * Grapheme clusters (Intl.Segmenter), so an emoji or a combined letter never
 * splits; without Intl.Segmenter, code points.
 */
export function typeUnits(text: string): string[] {
  if (!text) return [];
  const seg = segmenter();
  return seg ? Array.from(seg.segment(text), (p) => p.segment) : Array.from(text);
}

/** FNV-1a 32 of a string (the spread is fixed per line). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A well mixed 32 bit value from the line's seed and a letter's index. */
function mix(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

const SPACE_RE = /^\s+$/u;
const PUNCT_RE = /^\p{P}+$/u;

/**
 * Each letter's typing time (ms until the next one shows): 28 to 40, fixed
 * for the text, plus TYPE_SPACE_MS after a space and TYPE_PUNCT_MS after
 * punctuation, scaled so the whole line fits TYPE_MAX_MS.
 */
export function typeDelays(units: readonly string[]): number[] {
  const seed = hash(units.join(''));
  const raw = units.map(
    (u, i) =>
      TYPE_CHAR_MS -
      TYPE_SPREAD_MS +
      (mix(seed, i) % (2 * TYPE_SPREAD_MS + 1)) +
      (SPACE_RE.test(u) ? TYPE_SPACE_MS : PUNCT_RE.test(u) ? TYPE_PUNCT_MS : 0),
  );
  const total = raw.reduce((a, b) => a + b, 0);
  const k = total > TYPE_MAX_MS ? TYPE_MAX_MS / total : 1;
  return raw.map((d) => d * k);
}

interface Plan {
  body: string;
  dot: string | null;
  units: string[];
  /** When each letter shows, ms from the line's start. */
  at: number[];
  /** When the last letter has had its time (the dots start), ms from the line's start. */
  end: number;
}

/** The last few lines' plans (typedAt runs every frame on the same one or two lines). */
const plans = new Map<string, Plan>();

function plan(text: string): Plan {
  const hit = plans.get(text);
  if (hit) return hit;
  const { body, dot } = splitEllipsis(text);
  const units = typeUnits(body);
  const delays = typeDelays(units);
  const at: number[] = [];
  let t = TYPE_START_MS;
  for (const d of delays) {
    at.push(t);
    t += d;
  }
  const p = { body, dot, units, at, end: t };
  if (plans.size >= 8) plans.delete(plans.keys().next().value as string);
  plans.set(text, p);
  return p;
}

export interface Typed {
  /**
   * The line as three parts that always join to the body: `typed` (in),
   * `fresh` (the newest letter, coming up over CHAR_IN_MS: `freshIn` 0..1) and
   * `rest` (still to come, drawn invisible so the line keeps its full width
   * and its centre from the first frame).
   */
  typed: string;
  fresh: string;
  freshIn: number;
  rest: string;
  /** The letters are all in. */
  done: boolean;
  /** How many dots show (0 to 3; 0 until the letters are in, always 0 without an ellipsis). */
  dots: number;
  /** The dot ("." or "。"), or null: no cycling dots (no ellipsis, or reduced motion, where the line keeps its own). */
  dot: string | null;
}

/** How long the line takes to type, from its start (ms). */
export function typeLength(text: string): number {
  return plan(text).end;
}

/**
 * A line `age` ms after it started. A letter starts to show once the letter
 * before it has had its time. `reduced`: the whole line at once, its
 * ellipsis kept as written (static).
 */
export function typedAt(text: string, age: number, reduced = false): Typed {
  if (reduced) return { typed: text, fresh: '', freshIn: 1, rest: '', done: true, dots: 0, dot: null };
  const { body, dot, units, at, end } = plan(text);
  // How many letters show: the last one with at[i] <= age.
  let n = 0;
  while (n < units.length && age >= at[n]) n++;
  const done = n >= units.length && age >= end;
  const typed = units.slice(0, Math.max(0, n - 1)).join('');
  const fresh = n > 0 ? units[n - 1] : '';
  const freshIn = n > 0 ? Math.min(1, (age - at[n - 1]) / CHAR_IN_MS) : 0;
  const dots = done && dot ? 1 + (Math.floor((age - end) / DOT_STEP_MS) % 3) : 0;
  return { typed, fresh, freshIn, rest: body.slice(typed.length + fresh.length), done, dots, dot };
}
