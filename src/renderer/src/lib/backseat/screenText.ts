/**
 * Backseat screen text (260802, reworked 260803) — turning raw OCR output into
 * a reading the companion can be told.
 *
 * Pure functions over plain data, same convention as signals.ts and
 * transcriptRing.ts: the engine owns the pixels, this owns what survives and
 * how much of it. That split is what lets the offline sim run the SAME shaping
 * over recorded footage, so what the review video shows under the image grid is
 * byte-for-byte what a live tick would have carried. It is also what lets two
 * different engines (macOS Vision, tesseract.js everywhere else) produce the
 * same shape of reading.
 *
 * Why any of this exists: the grid tells the model what the screen LOOKS like,
 * and a 602x336 cell is nowhere near enough to read text off. Anything the
 * player is actually reading, a quest log, a chat box, subtitles, a menu, a
 * browser, is invisible to the companion no matter how good the vision model is
 * at the resolution we can afford to send. OCR on the full-resolution frame
 * recovers it as text for a hundred-odd tokens.
 *
 * 260803: the unit is now the LINE, not the word. Both engines report lines,
 * and a screen is a layout rather than a sentence: "SPIKE PLANTED" and a credit
 * count that happen to sit at the same height are two different things, and
 * flattening them into one space-separated run invented phrases that were never
 * on screen. Lines are joined with ' / ' so the model can see where one ends.
 *
 * Two things this deliberately does NOT try to be. It is not a signal: no wake
 * fires on text appearing, because "words changed" is true continuously in
 * every game with a HUD. And it is not trusted: the prompt quotes it as a
 * reading that is mostly right rather than as fact.
 */

/**
 * Per-line confidence floor, 0..100.
 *
 * Measured over 94 frames of the Valorant test clip (1035 lines), Vision's
 * confidence is effectively trinary and the split is clean: 959 lines came back
 * at 100 and were real text, and every one of the 76 lines below 60 was
 * garbage ("PREPE DNHEADY", "кL02 4", "25tIl75"). Tesseract's per-word scores
 * are noisier but sit either side of the same bar. Noise in the prompt is worse
 * than a shorter reading, because the model has no way to tell an OCR artefact
 * from a word that was really there.
 */
export const SCREEN_TEXT_MIN_CONFIDENCE = 60;

/** How lines are separated in the reading handed to the model. */
export const SCREEN_TEXT_LINE_SEP = ' / ';

// The line type is shared rather than declared here: it crosses a process
// boundary on the Vision path (main reads the frame, the renderer shapes the
// result), and both engines have to produce the same thing.
import type { OcrLine } from '../../../../shared/backseatIpc';

export type { OcrLine };

/**
 * Tokens that clear the confidence bar and still mean nothing: punctuation
 * soup, box-drawing artefacts picked off HUD borders, and stray single
 * characters. A lone letter is almost always a misread edge; a lone digit
 * usually is not (ammo, health, a score, a price), so digits are kept.
 */
function isJunk(token: string): boolean {
  if (!/[a-z0-9]/i.test(token)) return true;
  if (token.length === 1 && !/[0-9aiAI]/.test(token)) return true;
  return false;
}

/** Strip the junk tokens out of one line, returning '' if nothing is left. */
function cleanLine(text: string): string {
  return text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !isJunk(t))
    .join(' ');
}

/**
 * Shape raw OCR lines into the string a tick carries, or '' when nothing
 * survived.
 *
 * The cap keeps the FIRST `maxWords` in reading order, which is the opposite of
 * the transcript's rule (that one keeps the tail, closest to the moment). Text
 * on screen has no such ordering in time: it is laid out top-left to
 * bottom-right, so the front is the headline and the tail is the fine print.
 * When a page of prose is on screen this keeps the opening and says so.
 *
 * Truncation prefers whole lines and only cuts inside one when a single line is
 * longer than the whole budget, so the model is never handed half a menu item.
 */
export function shapeScreenText(lines: OcrLine[], maxWords: number): string {
  const kept: string[] = [];
  for (const line of lines) {
    if (line.confidence < SCREEN_TEXT_MIN_CONFIDENCE) continue;
    const text = cleanLine(line.text);
    if (!text) continue;
    // Consecutive repeats are an OCR artefact far more often than a real
    // doubled line, and a stuttering HUD element can otherwise fill the cap on
    // its own.
    if (kept.length && kept[kept.length - 1].toLowerCase() === text.toLowerCase()) continue;
    kept.push(text);
  }
  if (!kept.length) return '';

  const total = kept.reduce((n, l) => n + l.split(' ').length, 0);
  if (total <= maxWords) return kept.join(SCREEN_TEXT_LINE_SEP);

  const out: string[] = [];
  let budget = maxWords;
  for (const line of kept) {
    const words = line.split(' ');
    if (words.length <= budget) {
      out.push(line);
      budget -= words.length;
      if (budget === 0) break;
      continue;
    }
    // Only reachable for a line longer than the remaining budget. Taking a
    // partial one beats dropping it whole when it is the first thing on screen.
    if (out.length === 0) {
      out.push(words.slice(0, budget).join(' '));
      budget = 0;
    }
    break;
  }
  // The marker is not cosmetic: without it the model reads a truncated page as
  // the whole of what was on screen.
  return `${out.join(SCREEN_TEXT_LINE_SEP)} [...${total - (maxWords - budget)} more words on screen]`;
}
