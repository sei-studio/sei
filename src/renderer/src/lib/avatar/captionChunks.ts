/**
 * Caption chunking (260806) — pure text/geometry math for the caption overlay
 * window.
 *
 * The caption font size is FIXED (a user choice); the box is a fixed size (a
 * user choice). So a line that does not fit is never scaled down — it is
 * broken into sequential CHUNKS that each fit the box, paged at reading
 * speed by the component. A bigger font or a smaller box just means more,
 * shorter chunks.
 *
 * Fit is estimated, not measured: an average glyph width per font size, with
 * CJK counted double (a han glyph is ~1em against ~0.5em for latin). The CSS
 * keeps `overflow: hidden` as the backstop for the estimate being generous.
 */

/** Average latin glyph width as a fraction of the font size. */
const GLYPH_EM = 0.52;
/** Line height multiplier (must match the caption CSS line-height). */
export const CAPTION_LINE_HEIGHT = 1.35;

/** CJK and fullwidth ranges count as two latin units of width. */
function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) || // hangul jamo
    (c >= 0x2e80 && c <= 0xa4cf) || // CJK radicals .. yi
    (c >= 0xac00 && c <= 0xd7a3) || // hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compat ideographs
    (c >= 0xfe30 && c <= 0xfe4f) || // CJK compat forms
    (c >= 0xff00 && c <= 0xff60) || // fullwidth forms
    (c >= 0x20000 && c <= 0x3fffd) // CJK extension planes
  );
}

/** Width of a string in latin units (CJK doubled). */
export function visualUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += isWide(ch) ? 2 : 1;
  return units;
}

/**
 * How many latin units fit per line, and lines per box, for a given content
 * area (px, AFTER padding) and font size.
 */
export function captionCapacity(
  contentWidthPx: number,
  contentHeightPx: number,
  fontSize: number,
): { unitsPerLine: number; lines: number; unitsPerChunk: number } {
  const unitsPerLine = Math.max(4, Math.floor(contentWidthPx / (fontSize * GLYPH_EM)));
  const lines = Math.max(1, Math.floor(contentHeightPx / (fontSize * CAPTION_LINE_HEIGHT)));
  return { unitsPerLine, lines, unitsPerChunk: unitsPerLine * lines };
}

/** Split into sentences, keeping terminal punctuation. CJK terminators need
 * no following whitespace to count. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (/[.!?。！？…]/.test(ch)) {
      out.push(current);
      current = '';
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Break one overlong sentence on word boundaries (hard-slicing a single run
 * that exceeds the capacity on its own, e.g. unspaced CJK). */
function breakSentence(sentence: string, unitsPerChunk: number): string[] {
  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim().length > 0) pieces.push(current.trim());
    current = '';
  };
  for (const word of sentence.split(/\s+/)) {
    if (visualUnits(word) > unitsPerChunk) {
      // A single run longer than the whole box: hard-slice by units.
      flush();
      let slice = '';
      for (const ch of word) {
        if (visualUnits(slice + ch) > unitsPerChunk) {
          pieces.push(slice);
          slice = ch;
        } else {
          slice += ch;
        }
      }
      if (slice.length > 0) pieces.push(slice);
      continue;
    }
    const next = current.length > 0 ? `${current} ${word}` : word;
    if (visualUnits(next) > unitsPerChunk) {
      flush();
      current = word;
    } else {
      current = next;
    }
  }
  flush();
  return pieces;
}

/**
 * Chunk a spoken line for the caption box: sentences packed greedily into
 * chunks of at most `unitsPerChunk` units, an overlong sentence broken on
 * word boundaries. Never returns an empty array for non-blank input.
 */
export function chunkCaption(text: string, unitsPerChunk: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };
  for (const sentence of splitSentences(trimmed)) {
    const parts =
      visualUnits(sentence) > unitsPerChunk ? breakSentence(sentence, unitsPerChunk) : [sentence];
    for (const part of parts) {
      const next = current.length > 0 ? `${current} ${part}` : part;
      if (current.length > 0 && visualUnits(next) > unitsPerChunk) {
        flush();
        current = part;
      } else {
        current = next;
      }
    }
  }
  flush();
  return chunks;
}
