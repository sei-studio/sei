/**
 * SenseVoice English casing repair (260907).
 *
 * SenseVoice emits English as ALL CAPS (its inverse text normalization does
 * not lowercase), which lands shouty transcripts in chat and on calls. This
 * module fixes exactly that shape and nothing else: when a transcript's Latin
 * letters are overwhelmingly uppercase, rewrite it to sentence case
 * (capitalize the first letter of each sentence, keep standalone "I" and its
 * contractions capitalized, lowercase the rest). Mixed-case text — i.e. any
 * output from a healthy caser (Whisper, Scribe), or a deliberate acronym in
 * otherwise-normal text — passes through untouched. Non-Latin characters
 * (zh/ja/ko) are unaffected by the transform, so a mixed zh+EN line only has
 * its Latin runs repaired.
 *
 * Pure function; applied at the transcribeLocal choke point (engine.ts) so
 * every SenseVoice consumer gets it.
 */

/** Minimum Latin letters before the heuristic may fire (a lone "OK" or an
 * acronym-only utterance is not evidence of the ALL-CAPS failure mode). */
const MIN_LATIN_LETTERS = 4;

/** Fraction of cased Latin letters that must be uppercase to count as the
 * SenseVoice ALL-CAPS shape. 0.9 keeps normal prose with several acronyms
 * safely below the bar while catching the constant-caps output. */
const UPPER_RATIO = 0.9;

/** True when the text's Latin letters are overwhelmingly uppercase. */
export function isMostlyUppercaseLatin(text: string): boolean {
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  const lower = (text.match(/[a-z]/g) ?? []).length;
  const total = upper + lower;
  return total >= MIN_LATIN_LETTERS && upper / total >= UPPER_RATIO;
}

/** Sentence-ending punctuation (Latin + CJK forms). */
const SENTENCE_END = /[.!?…。！？]/;

/**
 * Rewrite an overwhelmingly-uppercase transcript to sentence case. Returns the
 * input unchanged when the heuristic says the casing is already healthy.
 */
export function sentenceCaseSttText(raw: string): string {
  if (!isMostlyUppercaseLatin(raw)) return raw;
  const lowered = raw.toLowerCase();
  let out = '';
  // Capitalize the first Latin letter of the string and of every sentence.
  // Any letter or digit "occupies" the sentence-start slot (so a CJK char
  // right after a period keeps a later mid-sentence Latin letter lowercase).
  let atSentenceStart = true;
  for (const ch of lowered) {
    if (atSentenceStart && /[a-z]/.test(ch)) {
      out += ch.toUpperCase();
      atSentenceStart = false;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) atSentenceStart = false;
    if (SENTENCE_END.test(ch)) atSentenceStart = true;
    out += ch;
  }
  // English "I" survives as a capital: standalone i, and its contractions
  // (i'm / i'll / i've / i'd — the \b covers them, the apostrophe is a
  // non-word char). "wi-fi" style words have no standalone i and are safe.
  return out.replace(/\bi\b/g, 'I');
}
