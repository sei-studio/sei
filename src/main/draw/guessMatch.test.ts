import { describe, expect, it } from 'vitest';
import { matchesWord, redactWord } from './guessMatch';

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
