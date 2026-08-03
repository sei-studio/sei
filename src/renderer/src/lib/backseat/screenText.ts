/**
 * Backseat screen text (260802) — turning raw OCR output into a line the
 * companion can be told.
 *
 * Pure functions over plain data, same convention as signals.ts and
 * transcriptRing.ts: ocrWorker.ts owns the engine and the pixels, this owns
 * what survives and how much of it. That split is what lets the offline sim run
 * the SAME shaping over recorded footage, so what the review video shows under
 * the image grid is byte-for-byte what a live tick would have carried.
 *
 * Why any of this exists: the grid tells the model what the screen LOOKS like,
 * and a 602x336 cell is nowhere near enough to read text off. Anything the
 * player is actually reading — a quest log, a chat box, subtitles, a menu, a
 * browser — is invisible to the companion no matter how good the vision model
 * is at the resolution we can afford to send. OCR on the full-resolution frame
 * recovers it as text for a hundred-odd tokens.
 *
 * Two things this deliberately does NOT try to be. It is not a signal: no wake
 * fires on text appearing, because "words changed" is true continuously in
 * every game with a HUD. And it is not trusted: OCR over a game frame produces
 * garbage alongside the real words, so the prompt quotes it as an unreliable
 * reading rather than as fact.
 */

/**
 * Tesseract's per-word confidence floor, 0..100.
 *
 * Game HUDs are the adversarial case for OCR: stylised fonts, text over moving
 * backgrounds, partial transparency. Everything below this is overwhelmingly
 * noise, and noise in the prompt is worse than a shorter reading, because the
 * model has no way to tell an OCR artefact from a word that was really there.
 */
export const SCREEN_TEXT_MIN_CONFIDENCE = 60;

/** One word as the OCR engine reports it. */
export interface OcrWord {
  text: string;
  /** 0..100. */
  confidence: number;
}

/**
 * Tokens that clear the confidence bar and still mean nothing: punctuation
 * soup, box-drawing artefacts picked off HUD borders, and stray single
 * characters. A lone letter is almost always a misread edge; a lone digit
 * usually is not (ammo, health, a score), so digits are kept.
 */
function isJunk(word: string): boolean {
  if (!/[a-z0-9]/i.test(word)) return true;
  if (word.length === 1 && !/[0-9aiAI]/.test(word)) return true;
  return false;
}

/**
 * Shape raw OCR words into the string a tick carries, or '' when nothing
 * survived.
 *
 * The cap keeps the FIRST `maxWords` in reading order, which is the opposite of
 * the transcript's rule (that one keeps the tail, closest to the moment). Text
 * on screen has no such ordering in time: it is laid out top-left to
 * bottom-right, so the front is the headline and the tail is the fine print.
 * When a page of prose is on screen this keeps the opening and says so.
 */
export function shapeScreenText(words: OcrWord[], maxWords: number): string {
  const kept: string[] = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text || w.confidence < SCREEN_TEXT_MIN_CONFIDENCE || isJunk(text)) continue;
    // Consecutive repeats are an OCR artefact far more often than a real
    // doubled word, and a stuttering HUD element can otherwise fill the cap on
    // its own.
    if (kept.length && kept[kept.length - 1].toLowerCase() === text.toLowerCase()) continue;
    kept.push(text);
  }
  if (!kept.length) return '';
  if (kept.length <= maxWords) return kept.join(' ');
  // The marker is not cosmetic: without it the model reads a truncated sentence
  // as the whole of what was on screen.
  return `${kept.slice(0, maxWords).join(' ')} [...${kept.length - maxWords} more words on screen]`;
}
