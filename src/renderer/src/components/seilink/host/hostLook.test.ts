import { describe, expect, it } from 'vitest';
import { bubbleMs, speakMs } from './HostDock';
import { lineFaceHoldMs, NEUTRAL_LOOK, toNeutral } from './hostLook';

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
