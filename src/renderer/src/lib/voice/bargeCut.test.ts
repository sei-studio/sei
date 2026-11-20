import { describe, expect, it } from 'vitest';
import { createCutTracker, CUT_LINE_MAX_AGE_MS, CUT_LINE_MAX_CHARS } from './bargeCut';

describe('bargeCut (261112)', () => {
  it('hands the cut line to the utterance that caused it', () => {
    const t = createCutTracker();
    t.note('sui', '  ok so the cave is right over ', 1_000);
    expect(t.take(1_800, { t0: 600, t1: 1_700 })).toEqual({ speakerId: 'sui', line: 'ok so the cave is right over', at: 1_000 });
  });

  it('is consumed by the first utterance after the cut', () => {
    const t = createCutTracker();
    t.note('sui', 'hello', 1_000);
    expect(t.take(1_500)).not.toBeNull();
    expect(t.take(2_000)).toBeNull();
  });

  it('nothing audible means no cut', () => {
    const t = createCutTracker();
    t.note(null, 'hello', 1_000);
    expect(t.take(1_500)).toBeNull();
  });

  it('an utterance that began after the cut is not the cut-in', () => {
    const t = createCutTracker();
    t.note('sui', 'hello', 1_000);
    expect(t.take(3_000, { t0: 2_000, t1: 2_900 })).toBeNull();
    // and the cut is spent
    expect(t.take(3_100)).toBeNull();
  });

  it('a stale cut is dropped', () => {
    const t = createCutTracker();
    t.note('sui', 'hello', 1_000);
    expect(t.take(1_000 + CUT_LINE_MAX_AGE_MS + 1)).toBeNull();
  });

  it('clips a long line and clear() drops a pending cut', () => {
    const t = createCutTracker();
    t.note('sui', 'x'.repeat(CUT_LINE_MAX_CHARS + 50), 1_000);
    expect(t.take(1_100)?.line.length).toBe(CUT_LINE_MAX_CHARS);
    t.note('sui', 'hello', 2_000);
    t.clear();
    expect(t.take(2_100)).toBeNull();
  });
});
