/**
 * Pure transforms behind CodeInput (260804).
 *
 * The segmented code field looks like six inputs but is ONE string, and every
 * edit is "produce the next string, and say which cell should hold focus".
 * Splitting that out is what makes it testable: the renderer has no DOM test
 * harness (no jsdom, no @testing-library — see IconRail.test.tsx), so logic
 * left inside the component can only ever be asserted by grepping its source.
 *
 * The value is always a prefix with no holes. A hole is not representable in a
 * string, and pretending otherwise (an array of six slots) would mean deciding
 * what a code with a gap in the middle submits.
 */

/** Codes are pasted out of mail clients as "123 456" or "123-456". */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

export interface CodeEdit {
  /** The new value. */
  next: string;
  /** Cell that should take focus, already clamped to [0, length - 1]. */
  focus: number;
}

function clamp(i: number, length: number): number {
  return Math.max(0, Math.min(length - 1, i));
}

/**
 * Write `digits` starting at cell `at`, discarding anything that was at or
 * after it. Overwriting rather than inserting is what makes a paste onto a
 * half-typed code do the obvious thing, and it is also correct for the
 * one-digit case: typing over a filled cell replaces it.
 */
export function writeAt(value: string, at: number, digits: string, length: number): CodeEdit {
  const clean = digitsOnly(digits);
  if (clean.length === 0) return { next: value, focus: clamp(at, length) };
  const next = (value.slice(0, at) + clean).slice(0, length);
  return { next, focus: clamp(at + clean.length, length) };
}

/**
 * Backspace at cell `at`. A filled cell clears itself and keeps focus; an empty
 * one deletes the character before it and steps back. This is the behaviour of
 * a single text input, which is what the field is pretending to be.
 */
export function backspaceAt(value: string, at: number, length: number): CodeEdit {
  if (value[at]) {
    return { next: value.slice(0, at) + value.slice(at + 1), focus: clamp(at, length) };
  }
  return {
    next: value.slice(0, Math.max(0, at - 1)) + value.slice(at),
    focus: clamp(at - 1, length),
  };
}

/**
 * A cell already holding a digit hands back "old+new" on change, because the
 * browser appends to the existing value before firing. Take what was just
 * typed. A cell that was empty passes its input through, so a real multi-digit
 * arrival (autofill, some IMEs) still fills forward.
 */
export function typedInto(cellValue: string | undefined, raw: string): string {
  const clean = digitsOnly(raw);
  return clean.length > 1 && cellValue ? clean.slice(-1) : clean;
}
