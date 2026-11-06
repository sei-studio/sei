/**
 * The WorldLink status lines typed out word by word, with cycling dots
 * (product feedback (261106)). Pure and deterministic, so a seeked
 * frame (the review renders) shows exactly what the app plays.
 *
 * A line is split into the words that type in (`typeUnits`: a word with the
 * spaces and punctuation after it; CJK, which has no spaces, by the word
 * segments Intl.Segmenter finds) and a trailing ellipsis, which is not typed
 * but turns into dots that cycle ".", "..", "..." once the words are in
 * (`splitEllipsis`: "…", "...", "。。。" or "⋯", in any locale's catalog;
 * the catalogs keep their text as it is). Each word takes 90 to 130 ms
 * (a fixed spread from the text, `wordDelays`), the whole line at most
 * TYPE_MAX_MS, after TYPE_START_MS (the line before fading out), so typing
 * always fits inside the shortest dwell and never moves the line's timing.
 */

/** Typing starts this long after the line's start (the line before has faded out by then). */
export const TYPE_START_MS = 300;
/** One word takes this long, give or take TYPE_SPREAD_MS. */
export const TYPE_WORD_MS = 110;
export const TYPE_SPREAD_MS = 20;
/** A whole line types in within this (a long translation types faster). Under the 2.8 s dwell with TYPE_START_MS. */
export const TYPE_MAX_MS = 1800;
/** A word comes up over this (a quick fade, so it does not pop). */
export const WORD_IN_MS = 70;
/** The dots step every this long: ".", "..", "...", "." ... */
export const DOT_STEP_MS = 400;

/** A trailing ellipsis: "…", "...", "。。。", "⋯" (and repeats, like "……"). */
const ELLIPSIS_RE = /(?:…+|\.{3,}|。{3,}|⋯+)\s*$/u;

export interface SplitLine {
  /** The text before the ellipsis (the words that type in). */
  body: string;
  /** The dot the cycling dots are made of ("." or "。"), or null: the line has no ellipsis. */
  dot: string | null;
}

export function splitEllipsis(text: string): SplitLine {
  const m = ELLIPSIS_RE.exec(text);
  if (!m) return { body: text, dot: null };
  return { body: text.slice(0, m.index), dot: m[0].trimEnd().startsWith('。') ? '。' : '.' };
}

type Segmenter = { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };

function segmenter(): Segmenter | null {
  try {
    const S = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
    return S ? new S(undefined, { granularity: 'word' }) : null;
  } catch {
    return null;
  }
}

/**
 * The pieces a line types in, in order; joined they are the text exactly.
 * Each piece is one word and whatever follows it up to the next word
 * (spaces, punctuation); anything before the first word rides with it.
 */
export function typeUnits(text: string): string[] {
  if (!text) return [];
  const seg = segmenter();
  const parts: Array<{ s: string; word: boolean }> = seg
    ? Array.from(seg.segment(text), (p) => ({ s: p.segment, word: p.isWordLike !== false && /\S/u.test(p.segment) && !/^[\p{P}\p{S}]+$/u.test(p.segment) }))
    : text.split(/(\s+)/u).filter(Boolean).map((s) => ({ s, word: /\S/u.test(s) }));
  const units: string[] = [];
  let lead = '';
  for (const p of parts) {
    if (p.word) {
      units.push(lead + p.s);
      lead = '';
    } else if (units.length) units[units.length - 1] += p.s;
    else lead += p.s;
  }
  if (lead) units.length ? (units[units.length - 1] += lead) : units.push(lead);
  return units;
}

/** FNV-1a 32 of a string and a number (the spread is fixed per line and word). */
function hash(s: string, n: number): number {
  let h = 0x811c9dc5 ^ n;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  return (h ^ (h >>> 12)) >>> 0;
}

/** Each unit's typing time, ms: 90 to 130, fixed for the text, scaled so the whole line fits TYPE_MAX_MS. */
export function wordDelays(units: readonly string[]): number[] {
  const key = units.join('');
  const raw = units.map((_, i) => TYPE_WORD_MS - TYPE_SPREAD_MS + (hash(key, i) % (2 * TYPE_SPREAD_MS + 1)));
  const total = raw.reduce((a, b) => a + b, 0);
  const k = total > TYPE_MAX_MS ? TYPE_MAX_MS / total : 1;
  return raw.map((d) => d * k);
}

export interface Typed {
  /**
   * The line as three parts that always join to the body: `typed` (in),
   * `fresh` (the newest word, coming up over WORD_IN_MS: `freshIn` 0..1) and
   * `rest` (still to come, drawn invisible so the line keeps its full width
   * and its centre from the first frame).
   */
  typed: string;
  fresh: string;
  freshIn: number;
  rest: string;
  /** The words are all in. */
  done: boolean;
  /** How many dots show (0 to 3; 0 until the words are in, always 0 without an ellipsis). */
  dots: number;
  /** The dot ("." or "。"), or null: no cycling dots (no ellipsis, or reduced motion, where the line keeps its own). */
  dot: string | null;
}

/** How long the line takes to type, from its start (ms). */
export function typeLength(text: string): number {
  return TYPE_START_MS + wordDelays(typeUnits(splitEllipsis(text).body)).reduce((a, b) => a + b, 0);
}

/**
 * A line `age` ms after it started. A word starts to show once the word
 * before it has had its time. `reduced`: the whole line at once, its
 * ellipsis kept as written (static).
 */
export function typedAt(text: string, age: number, reduced = false): Typed {
  if (reduced) return { typed: text, fresh: '', freshIn: 1, rest: '', done: true, dots: 0, dot: null };
  const { body, dot } = splitEllipsis(text);
  const units = typeUnits(body);
  const delays = wordDelays(units);
  // Word i shows from at[i]; the dots start once the last word has had its time.
  let t = TYPE_START_MS;
  let n = 0;
  let shownAt = 0;
  for (; n < units.length; n++) {
    if (age < t) break;
    shownAt = t;
    t += delays[n];
  }
  const done = n >= units.length && age >= t;
  const typed = units.slice(0, Math.max(0, n - 1)).join('');
  const fresh = n > 0 ? units[n - 1] : '';
  const freshIn = n > 0 ? Math.min(1, (age - shownAt) / WORD_IN_MS) : 0;
  const dots = done && dot ? 1 + (Math.floor((age - t) / DOT_STEP_MS) % 3) : 0;
  return { typed, fresh, freshIn, rest: body.slice(typed.length + fresh.length), done, dots, dot };
}
