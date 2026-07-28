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

/**
 * Redact the answer from a line the DRAWER is about to say, so a slip never
 * hands the round away. Returns null when the line is nothing but the answer
 * (there is no salvageable message left, so it should not be sent at all).
 *
 * This is a backstop for the prompt rule, not a replacement for it: the
 * character is told plainly never to say the word.
 */
export function redactWord(text: string, word: string): string | null {
  const target = tokenize(word);
  if (target.length === 0) return text;

  // Operate on the raw text so the player's line keeps its own punctuation:
  // build a tolerant pattern (plurals, any separator between the two words)
  // and blank out what it hits.
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordPat = target.map((t) => `${esc(t)}(?:es|s)?`).join('[^a-z0-9]*');
  const re = new RegExp(`\\b${wordPat}\\b`, 'gi');

  const out = text.replace(re, '[...]').trim();
  // Nothing left but the redaction marker and punctuation: drop the line.
  if (out.replace(/\[\.\.\.\]/g, '').replace(/[^a-z0-9]/gi, '').length === 0) return null;
  return out;
}
