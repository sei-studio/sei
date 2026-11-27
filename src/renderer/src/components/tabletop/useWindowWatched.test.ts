import { describe, expect, it, vi } from 'vitest';
import { watchWindow, windowWatched } from './useWindowWatched';

describe('windowWatched', () => {
  it('is true only for a visible, focused document', () => {
    expect(windowWatched({ hidden: false, hasFocus: () => true })).toBe(true);
    expect(windowWatched({ hidden: false, hasFocus: () => false })).toBe(false);
    expect(windowWatched({ hidden: true, hasFocus: () => true })).toBe(false);
  });
});

describe('watchWindow', () => {
  it('reports focus, blur and visibility changes until unsubscribed', () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const onChange = vi.fn();
    const stop = watchWindow(win, doc, onChange);
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
