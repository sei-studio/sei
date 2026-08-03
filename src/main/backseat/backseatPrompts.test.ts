import { describe, it, expect } from 'vitest';
import { stripDashes } from './backseatPrompts';

describe('stripDashes', () => {
  // These lines are SPOKEN. A dash is not a sound, so TTS renders it as a hard
  // stop with no breath; the replacement has to be punctuation a voice reads.
  it('becomes a comma mid-sentence', () => {
    expect(stripDashes('Okay that was worth the wait — do you always hold it?')).toBe(
      'Okay that was worth the wait, do you always hold it?',
    );
  });

  it('becomes a full stop when the next word starts a sentence', () => {
    expect(stripDashes('You won that round — How are you feeling?')).toBe(
      'You won that round. How are you feeling?',
    );
  });

  it('handles en dashes and unspaced dashes the same way', () => {
    expect(stripDashes('nice read–very nice')).toBe('nice read, very nice');
    expect(stripDashes('nice read—very nice')).toBe('nice read, very nice');
  });

  it('leaves hyphens alone', () => {
    // A hyphenated word is not the failure mode; only the em/en dash is.
    expect(stripDashes('that is a well-timed re-peek')).toBe('that is a well-timed re-peek');
  });

  it('trims and collapses, so a line never arrives with ragged spacing', () => {
    expect(stripDashes('  two   spaces here  ')).toBe('two spaces here');
  });

  it('passes clean text through untouched', () => {
    const line = 'Why were you out there with nothing to hide behind?';
    expect(stripDashes(line)).toBe(line);
  });
});
