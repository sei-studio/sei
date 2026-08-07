/** The switch dwell (260806): fire once, dwellMs after the LAST change. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSwitchDwell } from './switchDwell';

describe('createSwitchDwell', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once, dwellMs after a single change', () => {
    const fired: number[] = [];
    const d = createSwitchDwell({ dwellMs: 6000, onFire: (ms) => fired.push(ms) });
    d.change();
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(5999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([6000]);
    expect(d.pending()).toBe(false);
  });

  it('a change inside the window restarts the clock (a fast scroll never fires)', () => {
    const fired: number[] = [];
    const d = createSwitchDwell({ dwellMs: 6000, onFire: (ms) => fired.push(ms) });
    // Swipe, swipe, swipe: 3 s apart, each restarting the dwell.
    d.change();
    vi.advanceTimersByTime(3000);
    d.change();
    vi.advanceTimersByTime(3000);
    d.change();
    // 6 s after the FIRST change: nothing, the clock restarted twice.
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(6000);
    expect(fired).toEqual([6000]);
  });

  it('cancel drops the pending fire and the next change re-arms', () => {
    const fired: number[] = [];
    const d = createSwitchDwell({ dwellMs: 6000, onFire: (ms) => fired.push(ms) });
    d.change();
    d.cancel();
    expect(d.pending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
    d.change();
    vi.advanceTimersByTime(6000);
    expect(fired).toEqual([6000]);
  });

  it('fires again for a later, separate change', () => {
    const fired: number[] = [];
    const d = createSwitchDwell({ dwellMs: 6000, onFire: (ms) => fired.push(ms) });
    d.change();
    vi.advanceTimersByTime(6000);
    d.change();
    vi.advanceTimersByTime(6000);
    expect(fired).toEqual([6000, 6000]);
  });
});
