/**
 * Face expressions for the desktop companion (261028, facepack pilot).
 *
 * ONE closed vocabulary shared by every process: main reads a leading
 * `[expression]` tag off chat and call lines (chatService splitReplyParts),
 * the bot offers it as the optional `expression` parameter of say(), and the
 * renderer drives FacepackView with it. Plain JS so the bot (raw ESM in the
 * utilityProcess) can import it; faceExpressions.d.ts types it for main and
 * the renderer.
 *
 * Source of truth for names, descriptions, aliases and blink flags is the
 * face-set bake's expressions.json (~/suisei/work/face-sets, 2026-10-27),
 * plus four aliases the tag probe saw Haiku invent (261028): worried and
 * concerned -> sad, relieved -> happy, nervous -> embarrassed.
 * Each baked pack also carries its own per-expression `blink` flag, which is
 * what the player actually reads; the copy here is informational.
 *
 * One shared list (261028, Shawn msg 991): every character is offered the
 * same faces, the base 12 plus FACE_EXTRA_EXPRESSIONS (deadpan, resigned,
 * smirk, worried); there is no per-character filter. A pack declares which
 * faces it draws (`palette`) and may map others onto them (`aliases`); the
 * tag reader maps a face the pack lacks to its nearest (pack alias, then the
 * extra's base fallback). With no pack every tag lands on one of the 12.
 *
 * Production safety: nothing here is active unless the facepack dev flag is
 * on (main/facepack/facepackDev.ts). The parser is read-only: it never edits
 * the line, because stripAudioTags already removes every bracket tag of this
 * shape before a line is shown or spoken.
 */

/** @type {ReadonlyArray<{name: string, description: string, aliases: string[], blink: boolean}>} */
export const FACE_EXPRESSIONS = Object.freeze([
  { name: 'neutral', description: 'Calm, attentive default. Ordinary talk, listening, explaining.', aliases: ['calm', 'default', 'normal', 'listening'], blink: true },
  { name: 'happy', description: 'Warm smile. Pleased, friendly, agreeing, glad to see them.', aliases: ['smile', 'glad', 'pleased', 'warm', 'giggles', 'relieved'], blink: true },
  { name: 'laugh', description: 'Eyes squeezed shut, big open grin. Something is genuinely funny.', aliases: ['laughing', 'lol', 'laughs', 'snorts'], blink: false },
  { name: 'excited', description: "Wide bright eyes, open smile. Hyped, eager, can't wait, big news.", aliases: ['hyped', 'eager', 'thrilled', 'delighted'], blink: true },
  { name: 'smug', description: 'Half-lidded eyes, one-sided smirk. Teasing, told-you-so, playful mischief.', aliases: ['teasing', 'mischievous', 'proud', 'cocky'], blink: true },
  { name: 'pout', description: 'Pursed lips, brows knit. Mock-offended, sulking, playful protest.', aliases: ['sulk', 'hmph', 'huff', 'pouting'], blink: true },
  { name: 'sad', description: 'Brows tilted up in the middle, mouth down. Disappointed, sympathetic, hurt.', aliases: ['upset', 'disappointed', 'sorry', 'hurt'], blink: true },
  { name: 'surprised', description: 'Eyes wide, brows high, small open mouth. Caught off guard, shocked, wait what.', aliases: ['shocked', 'shock', 'gasp', 'gasps', 'wow'], blink: true },
  { name: 'embarrassed', description: 'Blushing, eyes darting away, wobbly mouth. Complimented, flustered, caught out, shy.', aliases: ['blush', 'blushing', 'flustered', 'shy', 'awkward', 'nervous'], blink: true },
  { name: 'thinking', description: 'Glancing up and aside, mouth pressed. Considering, unsure, trying to remember.', aliases: ['hmm', 'pondering', 'unsure', 'curious', 'confused'], blink: true },
  { name: 'sleepy', description: 'Heavy lids, slack calm face. Tired, late at night, winding down, cozy.', aliases: ['tired', 'drowsy', 'yawn', 'exhales'], blink: true },
  { name: 'annoyed', description: 'Brows down, narrowed eyes, flat frown. Irritated, grumpy, mock anger.', aliases: ['angry', 'irritated', 'grumpy', 'mad', 'ugh'], blink: true },
]);

/** The 12 names, in vocabulary order (the say() enum and the prompt list). */
export const FACE_EXPRESSION_NAMES = Object.freeze(FACE_EXPRESSIONS.map((e) => e.name));

/**
 * Names a pack palette can offer beyond the base 12 (261028). `fallback` is
 * the base face a tag lands on when the character's pack does not have this
 * one (or when there is no palette at all, which keeps the pre-palette
 * mapping: smirk -> smug, sighs/worried/concerned -> sad).
 * @type {ReadonlyArray<{name: string, description: string, aliases: string[], blink: boolean, fallback: string}>}
 */
export const FACE_EXTRA_EXPRESSIONS = Object.freeze([
  { name: 'deadpan', description: 'Flat, blank face. Dry remarks, stating the obvious, unimpressed.', aliases: ['flat', 'blank', 'expressionless', 'unimpressed'], blink: true, fallback: 'neutral' },
  { name: 'resigned', description: 'Drooping eyes, flat mouth. Sighing, giving in, doing it anyway.', aliases: ['sighs', 'sigh', 'sighing', 'weary', 'defeated', 'glum'], blink: true, fallback: 'sad' },
  { name: 'smirk', description: 'A faint lopsided smile. Dry amusement, quietly pleased.', aliases: ['wry', 'amused'], blink: true, fallback: 'smug' },
  { name: 'worried', description: 'Brows raised in the middle, slight frown. Anxious, concerned for them, unsure it will go well.', aliases: ['concerned', 'anxious', 'uneasy'], blink: true, fallback: 'sad' },
]);

/** Every expression the reader knows: the base 12, then the extras. */
export const FACE_ALL_EXPRESSIONS = Object.freeze([...FACE_EXPRESSIONS, ...FACE_EXTRA_EXPRESSIONS]);

/** The resting face every strong expression decays back to. */
export const FACE_NEUTRAL = 'neutral';

/**
 * Strong expressions decay to neutral after the line ends plus this hold
 * (EXPRESSIONS_SPEC.md). Every other expression persists until the next tag.
 */
export const FACE_DECAY_MS = Object.freeze({
  laugh: 1_500,
  surprised: 2_000,
  excited: 4_000,
  embarrassed: 6_000,
});

/** After this long with no speech the face falls back to neutral. */
export const FACE_IDLE_NEUTRAL_MS = 60_000;

const BY_WORD = new Map();
for (const e of FACE_ALL_EXPRESSIONS) BY_WORD.set(e.name, e.name);
// Names win over aliases: set aliases only where the word is still free.
for (const e of FACE_ALL_EXPRESSIONS) for (const a of e.aliases) if (!BY_WORD.has(a)) BY_WORD.set(a, e.name);
/** extra name -> base name */
const FALLBACK = new Map(FACE_EXTRA_EXPRESSIONS.map((e) => [e.name, e.fallback]));

const WORD_RE = /^[a-z]+$/;

function normWord(word) {
  if (typeof word !== 'string') return '';
  return word.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A pack's palette (facepack.json `palette` + `aliases`), cleaned: names are
 * single lowercase words, deduped, in pack order; an alias must point at a
 * palette name. `drawable` (the pack's expression keys) drops names the pack
 * cannot draw. Returns null when there is no usable list, which means "use
 * the base 12" everywhere.
 * @param {unknown} expressions
 * @param {unknown} [aliases]
 * @param {Iterable<string>} [drawable]
 * @returns {{ expressions: string[], aliases: Record<string, string> } | null}
 */
export function normalizePalette(expressions, aliases, drawable) {
  if (!Array.isArray(expressions)) return null;
  const can = drawable ? new Set(drawable) : null;
  const names = [];
  for (const raw of expressions) {
    const n = normWord(raw);
    if (!WORD_RE.test(n) || names.includes(n) || (can && !can.has(n))) continue;
    names.push(n);
  }
  if (names.length === 0) return null;
  const map = {};
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    for (const [k, v] of Object.entries(aliases)) {
      const from = normWord(k);
      const to = normWord(v);
      if (from && names.includes(to) && !names.includes(from)) map[from] = to;
    }
  }
  return { expressions: names, aliases: map };
}

/**
 * Map a tag body or a say() `expression` value onto an expression name.
 * Case and surrounding whitespace are ignored; inner runs of whitespace
 * collapse. Unknown, empty or non-string input returns null ("keep the
 * current face").
 *
 * Without a palette the result is always one of the base 12 (an extra name
 * lands on its fallback). With a palette (normalizePalette) the result is
 * always one of the palette's names: the word itself, a pack alias, the
 * vocabulary name or alias, then that name's base fallback, each checked
 * against the pack (and its aliases) in that order. A tag the pack cannot
 * show and does not alias returns null.
 * @param {unknown} word
 * @param {{ expressions: string[], aliases: Record<string, string> } | null} [palette]
 * @returns {string | null}
 */
export function resolveExpression(word, palette) {
  const key = normWord(word);
  if (!key) return null;
  let name = BY_WORD.get(key) ?? null;
  if (!palette) return name ? (FALLBACK.get(name) ?? name) : null;
  const has = new Set(palette.expressions);
  const pick = (n) => (has.has(n) ? n : has.has(palette.aliases[n]) ? palette.aliases[n] : null);
  const direct = pick(key);
  if (direct) return direct;
  while (name) {
    const hit = pick(name);
    if (hit) return hit;
    name = FALLBACK.get(name) ?? null;
  }
  return null;
}

/** Same shape as audioTags.ts TAG_RE: one to three plain words in brackets. */
const TAG_RE = /\[[ ]*([a-z]+(?:[ ]+[a-z]+){0,2})[ ]*\]/gi;
const SPOKEN_RE = /[\p{L}\p{N}]/u;

/**
 * Read the face cues in one line (a chat bubble, or one spoken sentence on a
 * call). Read-only: the caller strips the tags as before.
 *
 *  - `lead`: the last valid tag before the first spoken word. Applies when
 *    this line starts (its TTS clip becomes audible, or on arrival in text).
 *  - `trail`: the last valid tag after spoken words. Applies at the end of
 *    this line, i.e. the next clip boundary.
 *
 * Unknown tags (`[leans in]`, `[flibberflop]`) are ignored for the face, and
 * so are tags the character's palette cannot show (resolveExpression).
 * @param {unknown} line
 * @param {{ expressions: string[], aliases: Record<string, string> } | null} [palette]
 * @returns {{ lead: string | null, trail: string | null }}
 */
export function readFaceTags(line, palette) {
  const text = String(line ?? '');
  let lead = null;
  let trail = null;
  let spoken = false;
  let cursor = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (!spoken && SPOKEN_RE.test(text.slice(cursor, m.index))) spoken = true;
    cursor = m.index + m[0].length;
    const name = resolveExpression(m[1], palette);
    if (!name) continue;
    if (spoken) trail = name;
    else lead = name;
  }
  return { lead, trail };
}

/**
 * The faces every character is offered (261028, Shawn msg 991): the same
 * list for everyone, the base 12 plus the extras. There is no per-character
 * filter; a pack that does not draw a face maps it to the nearest one it
 * has (pack aliases, then the extra's fallback, see resolveExpression).
 */
export const FACE_OFFERED_NAMES = Object.freeze(FACE_ALL_EXPRESSIONS.map((e) => e.name));

/**
 * The FACE block for the chat and voice-call prompts (persona block), only
 * while the facepack dev flag is on. One general instruction for every
 * character; nothing in it names a character or a persona trait.
 *
 * Wording (scripts/facepack-tag-probe.ts, 261028, Haiku 5.5, Sui/Lyra/Marv,
 * chat + call, 3 reps, Opus judge rating fit to the line AND the character):
 * "then reply as you normally would" keeps replies at the no-face length
 * (output minus the tag within noise of no-face). With the full shared list
 * the dry character pulls a warm face (laugh/excited/happy/smug) on 2 of 45
 * dry lines. Eleven general "stay in character" rewrites (e.g. "your face as
 * you say it, in your own manner", "how you say it, not how the news feels")
 * moved that to 0-10% in screening, the best one judged no better on fit
 * (1.52-1.73 vs 1.56-1.80) and cut the tag rate (Marv 83% -> 63%), so this
 * wording stays.
 */
export const FACE_PROMPT =
  '# FACE\n' +
  'People can see your face. Begin each reply with a face tag in square brackets, one of: ' +
  FACE_OFFERED_NAMES.map((n) => `[${n}]`).join(' ') +
  ', then reply as you normally would. Put a new tag before a later sentence if your mood changes. Tags are not spoken or shown.';

/** The say() `expression` enum: the shared list. */
export const FACE_EXPRESSION_ENUM = FACE_OFFERED_NAMES;

/** say() `expression` parameter description (game surface). */
export const SAY_EXPRESSION_DESCRIPTION = 'Your face while you say this. Omit to keep the current one.';
