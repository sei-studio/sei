import { describe, it, expect } from 'vitest';
import { BACKSEAT_CONTRACT, stripDashes, tickNote } from './backseatPrompts';

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

/**
 * The switch wake (260806). Pinned because its whole reason to exist is the
 * one-reel-behind failure: the note must claim the content for NOW, name the
 * old thing as gone, and forbid remarking on the switch — lose any of those in
 * a rewording and the live failure comes straight back.
 */
describe('tickNote switch branch', () => {
  const base = { secondsSinceLastLine: 10, sourceName: 'Chrome' } as const;

  it('says the new content has held, and the old thing is gone', () => {
    const note = tickNote({ ...base, kind: 'jolt', joltReason: 'switch', sinceSwitchS: 6.2 });
    expect(note).toContain('changed to something new about 6 seconds ago');
    expect(note).toContain('stayed on it since');
    expect(note).toContain('Do not mention the old thing');
    expect(note).toContain('do not remark on the switch itself');
  });

  it('degrades to "a few seconds ago" without a switch age', () => {
    const note = tickNote({ ...base, kind: 'jolt', joltReason: 'switch' });
    expect(note).toContain('a few seconds ago');
  });

  it('does not disturb the plain jolt wordings', () => {
    expect(tickNote({ ...base, kind: 'jolt', joltReason: 'gain' })).toContain(
      'the sound just jumped',
    );
    expect(tickNote({ ...base, kind: 'jolt', joltReason: 'color' })).toContain(
      'a big part of the picture just changed',
    );
  });
});

/**
 * The feed rules (260806), from the live Reels session: the companion called
 * the feed "your feed"/"that guy's feed", treated clips as related, and
 * remarked on the scrolling itself. The contract now states what a feed is and
 * bans feed-meta commentary outright.
 */
describe('BACKSEAT_CONTRACT feed rules', () => {
  it('states the clips are unrelated and by different creators', () => {
    expect(BACKSEAT_CONTRACT).toContain('each one is by a different, unrelated creator');
    expect(BACKSEAT_CONTRACT).toContain('no clip is a reply to the one before it');
  });

  it('bans talking about the feed itself', () => {
    expect(BACKSEAT_CONTRACT).toContain('Never talk about the feed itself');
    expect(BACKSEAT_CONTRACT).toContain('The clip in front of you is the whole subject');
  });

  // 260806: the BAD/GOOD contrast pairs are gone by user direction — Haiku
  // imitated the GOOD lines' register across whole sessions (the same stock
  // quips, every session), so the contract must carry bans as explanations
  // that name the sentence shape, never as modeled dialogue to copy.
  it('carries no modeled example dialogue', () => {
    expect(BACKSEAT_CONTRACT).not.toContain('BAD:');
    expect(BACKSEAT_CONTRACT).not.toContain('GOOD:');
  });
});

/**
 * The identity rule (260807), from the two speakers-at-max-volume Instagram
 * sessions: reel audio leaking into the mic arrived labeled as the player (the
 * echo gate in the renderer is the real fix), and the companion concluded the
 * player was the person in the reel — "is this you? this is you". Nothing in
 * the contract said the share carries no camera and no player voice, so the
 * inference was never contradicted. This is the prompt-side backstop.
 */
describe('BACKSEAT_CONTRACT identity rule', () => {
  it('states the player is never on screen or in the audio', () => {
    expect(BACKSEAT_CONTRACT).toContain('a person on screen is never the player');
    expect(BACKSEAT_CONTRACT).toContain('no camera points at them');
  });
});
