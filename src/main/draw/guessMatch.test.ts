import { describe, expect, it } from 'vitest';
import { findWordMatch, matchesWord, redactWord, saysWord } from './guessMatch';

describe('matchesWord', () => {
  it('accepts the word inside any sentence', () => {
    expect(matchesWord('wait is that a lighthouse', 'lighthouse')).toBe(true);
    expect(matchesWord('LIGHTHOUSE!!!', 'lighthouse')).toBe(true);
    expect(matchesWord('lighthouse?', 'lighthouse')).toBe(true);
    expect(matchesWord('ok now i see it, lighthouse.', 'lighthouse')).toBe(true);
  });

  it('requires a whole word, never a substring', () => {
    // The failure this guards: "want" containing "ant" would hand over a round.
    expect(matchesWord('i want to say something', 'ant')).toBe(false);
    expect(matchesWord('is it an ant', 'ant')).toBe(true);
    expect(matchesWord('scatter', 'cat')).toBe(false);
  });

  it('forgives a trailing plural on either side', () => {
    expect(matchesWord('cats?', 'cat')).toBe(true);
    expect(matchesWord('is it a cat', 'cats')).toBe(true);
    expect(matchesWord('is it a grape', 'grapes')).toBe(true);
    expect(matchesWord('boxes', 'box')).toBe(true);
  });

  it('does not over-stem short words', () => {
    // A naive stemmer turns "bus" into "bu" and stops matching itself.
    expect(matchesWord('a bus', 'bus')).toBe(true);
    expect(matchesWord('gas', 'gas')).toBe(true);
  });

  it('matches a two-word answer in order and adjacent', () => {
    expect(matchesWord('is that ice cream', 'ice cream')).toBe(true);
    expect(matchesWord('ice, cream?', 'ice cream')).toBe(true);
    expect(matchesWord('cream ice', 'ice cream')).toBe(false);
    expect(matchesWord('ice cold cream', 'ice cream')).toBe(false);
  });

  it('accepts a two-word answer typed closed up', () => {
    expect(matchesWord('hotdog!', 'hot dog')).toBe(true);
    expect(matchesWord('icecream', 'ice cream')).toBe(true);
  });

  it('is case and punctuation blind', () => {
    expect(matchesWord('...HoT   DoG...', 'hot dog')).toBe(true);
  });

  it('rejects empty and unrelated input', () => {
    expect(matchesWord('', 'cat')).toBe(false);
    expect(matchesWord('no idea sorry', 'cat')).toBe(false);
    expect(matchesWord('cat', '')).toBe(false);
  });
});

// 260728 — the renderer highlights the winning WORD, not the winning line, and
// this is where it learns which characters those are. The contract that
// matters: on any line matchesWord accepts, this returns the span it was
// accepted for, in raw-text indices the renderer can slice with.
describe('findWordMatch', () => {
  const slice = (text: string, word: string): string | null => {
    const r = findWordMatch(text, word);
    return r ? text.slice(r.start, r.end) : null;
  };

  it('finds the word inside a sentence, keeping raw punctuation out', () => {
    expect(slice('wait is that a lighthouse?', 'lighthouse')).toBe('lighthouse');
    expect(slice('LIGHTHOUSE!!!', 'lighthouse')).toBe('LIGHTHOUSE');
    expect(slice('ok now i see it, lighthouse.', 'lighthouse')).toBe('lighthouse');
  });

  it('returns the span the plural forgiveness matched', () => {
    expect(slice('are those cats?', 'cat')).toBe('cats');
    expect(slice('is it a grape', 'grapes')).toBe('grape');
  });

  it('covers a two-word answer, typed apart or closed up', () => {
    expect(slice('is that ice cream', 'ice cream')).toBe('ice cream');
    expect(slice('icecream!', 'ice cream')).toBe('icecream');
    expect(slice('ice, cream?', 'ice cream')).toBe('ice, cream');
  });

  it('never matches a substring of another word', () => {
    expect(findWordMatch('i want to say something', 'ant')).toBeNull();
    expect(slice('is it an ant', 'ant')).toBe('ant');
  });

  it('returns null when the word is not there', () => {
    expect(findWordMatch('no idea sorry', 'cat')).toBeNull();
    expect(findWordMatch('', 'cat')).toBeNull();
    expect(findWordMatch('cat', '')).toBeNull();
  });

  it('agrees with matchesWord on its own accepts', () => {
    const cases: Array<[string, string]> = [
      ['wait is that a lighthouse', 'lighthouse'],
      ['cats?', 'cat'],
      ['is it a cat', 'cats'],
      ['hotdog!', 'hot dog'],
      ['...HoT   DoG...', 'hot dog'],
      ['boxes', 'box'],
    ];
    for (const [text, word] of cases) {
      expect(matchesWord(text, word)).toBe(true);
      expect(findWordMatch(text, word)).not.toBeNull();
    }
  });
});

describe('redactWord', () => {
  it('blanks the answer out of a drawer line', () => {
    expect(redactWord('it is obviously a lighthouse', 'lighthouse')).toBe('it is obviously a [...]');
    expect(redactWord('drawing a hot dog here', 'hot dog')).toBe('drawing a [...] here');
  });

  it('forgives plurals when redacting', () => {
    expect(redactWord('look at the cats', 'cat')).toBe('look at the [...]');
  });

  it('returns null when nothing survives', () => {
    expect(redactWord('lighthouse', 'lighthouse')).toBeNull();
    expect(redactWord('hot dog!!', 'hot dog')).toBeNull();
  });

  it('leaves an innocent line untouched', () => {
    expect(redactWord('almost done', 'lighthouse')).toBe('almost done');
  });
});

// 260728 — the drawer's slip is now dropped WHOLE rather than patched in
// place: "[...]" still pointed at exactly where the answer went, and read to
// the player as a bug rather than as the game stepping in. saysWord is the
// question behind that drop, and it must stay as tolerant as the redaction it
// replaces, or the line it lets through IS the leak.
describe('saysWord', () => {
  it('catches the answer however it was typed', () => {
    expect(saysWord('it is obviously a lighthouse', 'lighthouse')).toBe(true);
    expect(saysWord('LIGHTHOUSE!!', 'lighthouse')).toBe(true);
    expect(saysWord('look at the cats', 'cat')).toBe(true);
    expect(saysWord('drawing a hot dog here', 'hot dog')).toBe(true);
  });

  it('lets an innocent line through unchanged', () => {
    expect(saysWord('almost done', 'lighthouse')).toBe(false);
    expect(saysWord('guess already', 'cat')).toBe(false);
  });

  it('does not fire on the word buried inside another', () => {
    expect(saysWord('i want to finish this', 'ant')).toBe(false);
  });

  it('is not fooled by surrounding whitespace', () => {
    expect(saysWord('  almost done  ', 'lighthouse')).toBe(false);
  });
});
