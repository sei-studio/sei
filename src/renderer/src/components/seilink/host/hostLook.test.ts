import { describe, expect, it } from 'vitest';
import { bubbleMs, speakMs } from './HostDock';
import { lineFaceHoldMs, mouthLevel, NEUTRAL_LOOK, toNeutral, VOICE_LEVEL_FRESH_MS } from './hostLook';

describe('hostLook (261105)', () => {
  it('her face holds while the bubble is up and at least half the line past its end', () => {
    for (const text of ['hi', 'haha you found me. I was just rearranging the shelf again', 'x'.repeat(300)]) {
      const hold = lineFaceHoldMs(text);
      expect(hold).toBeGreaterThanOrEqual(bubbleMs(text));
      expect(hold).toBeGreaterThanOrEqual(speakMs(text) * 1.5);
    }
  });

  it('goes back to neutral once, and leaves a never-set face alone', () => {
    expect(toNeutral(NEUTRAL_LOOK)).toBe(NEUTRAL_LOOK);
    const happy = { emotion: 'happy' as const, face: 'happy', seq: 3 };
    const back = toNeutral(happy);
    expect(back).toEqual({ emotion: null, face: 'neutral', seq: 4 });
    expect(toNeutral(back)).toBe(back);
    // A Live2D-only look (no face set word) clears its emotion.
    expect(toNeutral({ emotion: 'sad', face: null, seq: 1 })).toEqual({ emotion: null, face: null, seq: 2 });
  });
});

describe('mouthLevel (261110, call voice on the desktop)', () => {
  it('a fresh call level drives her mouth', () => {
    expect(mouthLevel({ level: 0.6, at: 1000 }, 0.3, 1100)).toBe(0.6);
    expect(mouthLevel({ level: 0, at: 1000 }, 0.3, 1100)).toBe(0);
  });

  it('a stale or missing level falls back to the syllable envelope', () => {
    expect(mouthLevel({ level: 0.6, at: 1000 }, 0.3, 1000 + VOICE_LEVEL_FRESH_MS)).toBe(0.3);
    expect(mouthLevel({ level: 0.6, at: 0 }, 0.3, 50)).toBe(0.3);
    expect(mouthLevel(undefined, 0.3, 50)).toBe(0.3);
  });

  it('clamps to 0..1', () => {
    expect(mouthLevel({ level: 3, at: 10 }, 0, 20)).toBe(1);
  });
});
