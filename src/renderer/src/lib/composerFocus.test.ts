import { describe, expect, it, vi } from 'vitest';
import { FOCUS_ASK_MS, onComposerFocusRequest, requestComposerFocus, takeComposerFocus } from './composerFocus';

describe('composerFocus (product call (261116): a double click on her opens her chat ready to type)', () => {
  it('an ask is taken once, by the same character, while fresh', () => {
    requestComposerFocus('a', 1000);
    expect(takeComposerFocus('b', 1100)).toBe(false);
    expect(takeComposerFocus('a', 1200)).toBe(true);
    expect(takeComposerFocus('a', 1300)).toBe(false);
  });
  it('a stale ask is dropped', () => {
    requestComposerFocus('a', 0);
    expect(takeComposerFocus('a', FOCUS_ASK_MS + 1)).toBe(false);
    expect(takeComposerFocus('a', FOCUS_ASK_MS + 2)).toBe(false);
  });
  it('tells a listening chat screen', () => {
    const cb = vi.fn();
    const off = onComposerFocusRequest(cb);
    requestComposerFocus('a');
    off();
    requestComposerFocus('a');
    expect(cb).toHaveBeenCalledTimes(1);
    takeComposerFocus('a');
  });
});




