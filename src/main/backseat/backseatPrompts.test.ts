import { describe, it, expect } from 'vitest';
import { stripDashes, tickNote } from './backseatPrompts';

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

/**
 * The opening look (260803). Worth pinning rather than eyeballing because it is
 * the one branch with no history behind it, so nothing else in the prompt
 * carries the context, and because it is the only note that may talk about the
 * ACT of sharing. Every later look must not, and that is easy to break by
 * copying wording between branches.
 */
describe('tickNote start branch', () => {
  const base = { secondsSinceLastLine: null, sourceName: 'Chrome' } as const;

  it('says they just shared, which no other branch may claim', () => {
    const note = tickNote({ ...base, kind: 'start' });
    expect(note).toContain('just shared their screen');
    for (const kind of ['user', 'jolt', 'idle'] as const) {
      expect(tickNote({ ...base, kind })).not.toContain('just shared their screen');
    }
  });

  it('carries the window title, which is most of what the first look has', () => {
    // The frame ring is START_LOOK_MS old here, so the grid is thin and the
    // title is doing more work on this tick than on any other.
    const note = tickNote({ ...base, kind: 'start', shareLabel: 'Instagram' });
    expect(note).toContain('"Instagram"');
  });

  it('does not ask for thanks or for the picture described back', () => {
    const note = tickNote({ ...base, kind: 'start' });
    expect(note).toContain('do not thank them for sharing');
    expect(note).toContain('Do not describe the picture back to them');
  });

  it('reports the frame ages it was given, however few', () => {
    const note = tickNote({ ...base, kind: 'start', frameAges: [0.75, 0.375, 0] });
    expect(note).toContain('3 frames');
    expect(note).toContain('now');
  });

  it('says so plainly when the opening grid collapsed to one frame', () => {
    const note = tickNote({ ...base, kind: 'start', frameAges: [0] });
    expect(note).toContain('Only one frame');
  });
});
