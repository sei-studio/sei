/**
 * Guess matching (260727).
 *
 * The rule the game runs on: a guess is correct when the guesser sends the
 * word in ANY sentence during the turn. "wait is that a lighthouse" counts;
 * so does "LIGHTHOUSE!!". So this is whole-word containment, not equality.
 *
 * Three forgivenesses, and deliberately no more:
 *
 *   - punctuation and case are irrelevant ("Lighthouse?!" == "lighthouse");
 *   - a trailing plural on either side is accepted, by comparing token
 *     VARIANTS rather than stemming. Stemming is lossy in exactly the way
 *     that breaks this: a stemmer that turns "grapes" into "grap" no longer
 *     matches the bank entry "grapes" against a player typing "grape";
 *   - a two-word answer may be typed closed up ("hotdog" for "hot dog"),
 *     which is only checked for multi-token answers so a short answer like
 *     "ant" can never match inside "want".
 *
 * Everything else is a miss on purpose. Fuzzy or semantic matching would make
 * the moment of getting it right feel arbitrary, and the guesser cannot tell
 * why a near-miss counted.
 */

/* ── CJK path (260730) ────────────────────────────────────────────────────
   Chinese has no spaces and no plurals, so the token walk below cannot see it
   (normalize() deletes every Han character). A CJK answer instead matches by
   CONTIGUOUS CONTAINMENT over a normalized string that keeps Han characters
   and alphanumerics only: "是不是灯塔？？" contains "灯塔". The same three
   values hold: literal, case/punctuation-forgiving, nothing fuzzy. */

const HAN_RE = /[㐀-䶿一-鿿]/;

function hasCjk(s: string): boolean {
  return HAN_RE.test(s);
}

/** Keep Han + lowercase alphanumerics, drop everything else, no spaces. */
function normalizeCjk(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    if (HAN_RE.test(ch) || /[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

/** Lowercase, strip diacritics, reduce every separator to a single space. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    // Combining diacritical marks, written as escapes so the source stays ASCII.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(' ');
}

/** Equal, or equal once a trailing plural is allowed on either side. */
function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === `${b}s` || b === `${a}s`) return true;
  if (a === `${b}es` || b === `${a}es`) return true;
  return false;
}

/**
 * True when `message` contains `word` as a whole word (or whole phrase, in
 * order and adjacent, for two-word answers).
 */
export function matchesWord(message: string, word: string): boolean {
  if (hasCjk(word)) {
    const target = normalizeCjk(word);
    return target.length > 0 && normalizeCjk(message).includes(target);
  }
  const target = tokenize(word);
  if (target.length === 0) return false;
  const said = tokenize(message);
  if (said.length < target.length) {
    // A closed-up two-word answer collapses to one token, so it can still
    // match a shorter token list. Fall through to the joined check below.
    if (target.length < 2) return false;
  }

  for (let i = 0; i + target.length <= said.length; i++) {
    let hit = true;
    for (let j = 0; j < target.length; j++) {
      if (!tokensEqual(said[i + j], target[j])) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }

  // "hotdog" for "hot dog". Multi-token answers only.
  if (target.length >= 2) {
    const joined = target.join('');
    for (const t of said) {
      if (tokensEqual(t, joined)) return true;
    }
  }

  return false;
}

/** A token plus the raw-text range [start, end) it was read from. */
interface TokenSpan {
  tok: string;
  start: number;
  end: number;
}

/**
 * tokenize(), but keeping the raw-text range each token came from, so a match
 * found in normalized space can be pointed back at the original sentence.
 * Normalization is applied per character; each raw character contributes its
 * normalized alphanumerics to the current token, so diacritics and punctuation
 * never shift the recorded indices.
 */
function tokenizeWithSpans(s: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let tok = '';
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const kept = s[i]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (kept) {
      if (start < 0) start = i;
      tok += kept;
    } else if (start >= 0) {
      spans.push({ tok, start, end: i });
      tok = '';
      start = -1;
    }
  }
  if (start >= 0) spans.push({ tok, start, end: s.length });
  return spans;
}

/**
 * Where `word` sits inside `message`, as a raw-index range [start, end), or
 * null when it is not there. The same matching walk as matchesWord over
 * position-carrying tokens, so on any line matchesWord accepts this finds the
 * span it accepted it for. Exists so the renderer can highlight the winning
 * word rather than the whole winning sentence (260728).
 */
export function findWordMatch(
  message: string,
  word: string,
): { start: number; end: number } | null {
  if (hasCjk(word)) {
    // CJK: walk the raw text keeping normalized characters with their source
    // index, find the contiguous target, map back to a raw [start, end).
    const target = normalizeCjk(word);
    if (target.length === 0) return null;
    const kept: { ch: string; idx: number }[] = [];
    let i = 0;
    for (const ch of message) {
      const low = ch.toLowerCase();
      if (HAN_RE.test(low) || /[a-z0-9]/.test(low)) kept.push({ ch: low, idx: i });
      i += ch.length; // supplementary-plane characters occupy two UTF-16 units
    }
    const hay = kept.map((k) => k.ch).join('');
    const at = hay.indexOf(target);
    if (at < 0) return null;
    const last = kept[at + target.length - 1];
    return { start: kept[at].idx, end: last.idx + last.ch.length };
  }
  const target = tokenize(word);
  if (target.length === 0) return null;
  const spans = tokenizeWithSpans(message);

  for (let i = 0; i + target.length <= spans.length; i++) {
    let hit = true;
    for (let j = 0; j < target.length; j++) {
      if (!tokensEqual(spans[i + j].tok, target[j])) {
        hit = false;
        break;
      }
    }
    if (hit) return { start: spans[i].start, end: spans[i + target.length - 1].end };
  }

  // "hotdog" for "hot dog". Multi-token answers only, mirroring matchesWord.
  if (target.length >= 2) {
    const joined = target.join('');
    for (const sp of spans) {
      if (tokensEqual(sp.tok, joined)) return { start: sp.start, end: sp.end };
    }
  }

  return null;
}

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * The tolerant pattern that finds `word` inside a raw line, or null when the
 * word carries nothing matchable. A FRESH RegExp every call: the pattern is
 * /g, and a shared instance would carry `lastIndex` between .test() calls and
 * answer differently on alternating lines.
 *
 * Shared by redactWord and saysWord (260731) so the two can never disagree
 * about what counts as saying the word. saysWord used to derive its answer
 * from redactWord's RETURN VALUE instead, which conflated "said the word"
 * with "nothing salvageable left" — see hasContent below for what that cost.
 */
function wordPattern(word: string): RegExp | null {
  if (hasCjk(word)) {
    // CJK: no word boundaries exist, so match every contiguous occurrence
    // (tolerating separators between the characters, mirroring the Latin
    // pattern's tolerance). Chars are regex-escaped individually.
    const chars = [...normalizeCjk(word)];
    if (chars.length === 0) return null;
    const esc = (c: string): string => c.replace(REGEX_ESCAPE_RE, '\\$&');
    return new RegExp(chars.map(esc).join('[^㐀-䶿一-鿿a-z0-9]*'), 'gi');
  }
  const target = tokenize(word);
  if (target.length === 0) return null;
  // Tolerant: plurals on either side, any separator between the two words of a
  // two-word answer.
  const esc = (t: string): string => t.replace(REGEX_ESCAPE_RE, '\\$&');
  const wordPat = target.map((t) => `${esc(t)}(?:es|s)?`).join('[^a-z0-9]*');
  return new RegExp(`\\b${wordPat}\\b`, 'gi');
}

/**
 * Whether a redacted line still carries something worth sending: any LETTER OR
 * DIGIT IN ANY SCRIPT, once the redaction markers are removed.
 *
 * 260731: this test used to be `.replace(/[^a-z0-9]/gi, '').length === 0` (and,
 * on the CJK branch, the same with Han added). Both read every line written
 * outside their own alphabet as EMPTY, so a player typing Chinese, Korean,
 * Japanese, or nothing but emoji while DRAWING had their line dropped and was
 * told "You can't type this word! You're drawing it, not guessing it." — the
 * word never appeared and the pattern never matched; the line simply had no
 * ASCII letters in it. The same misfire hit the character's own lines mid
 * drawing turn (drawService's word-slip guard), so a character that drifted
 * into another language was silently muted and then corrected for something it
 * had not done. Unicode property escapes are the whole fix: `\p{L}` covers
 * every script this game will ever see.
 */
function hasContent(redacted: string): boolean {
  return /[\p{L}\p{N}]/u.test(redacted.replace(/\[\.\.\.\]/g, ''));
}

/**
 * Redact the answer from a line the DRAWER is about to say, so a slip never
 * hands the round away. Returns null when the line is nothing but the answer
 * (there is no salvageable message left, so it should not be sent at all).
 *
 * This is a backstop for the prompt rule, not a replacement for it: the
 * character is told plainly never to say the word.
 */
export function redactWord(text: string, word: string): string | null {
  const re = wordPattern(word);
  if (!re) return text;
  const out = text.replace(re, '[...]').trim();
  // Nothing left but the redaction marker and punctuation: drop the line.
  if (!hasContent(out)) return null;
  return out;
}

/**
 * True when a line spoken by the DRAWER contains their own word (260728).
 *
 * Same tolerant pattern as redactWord, asked as a question instead of an edit,
 * because the line is now dropped whole rather than patched: a "[...]" in the
 * middle of a sentence still told the guesser exactly where the answer went,
 * and it read as a bug rather than as the game protecting itself.
 *
 * 260731: asks the PATTERN, not redactWord's return value. A line that leaves
 * nothing salvageable is a different condition from a line that says the word,
 * and only the second one deserves the word-slip notice.
 */
export function saysWord(text: string, word: string): boolean {
  const re = wordPattern(word);
  return re ? re.test(text) : false;
}
