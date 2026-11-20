import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_DWELL_MS, createHoverDwell } from './hoverDwell';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createHoverDwell', () => {
  it('fires once the pointer has dwelt HOVER_DWELL_MS (300-400 ms)', () => {
    expect(HOVER_DWELL_MS).toBeGreaterThanOrEqual(300);
    expect(HOVER_DWELL_MS).toBeLessThanOrEqual(400);
    const fire = vi.fn();
    const d = createHoverDwell(fire);
    d.start();
    vi.advanceTimersByTime(HOVER_DWELL_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('a brush-past (leave before the dwell) never fires: no download on a passing hover', () => {
    const fire = vi.fn();
    const d = createHoverDwell(fire);
    d.start();
    vi.advanceTimersByTime(HOVER_DWELL_MS - 50);
    d.cancel();
    vi.advanceTimersByTime(HOVER_DWELL_MS * 4);
    expect(fire).not.toHaveBeenCalled();
  });

  it('re-entering restarts the dwell; repeated enters while waiting do not stack', () => {
    const fire = vi.fn();
    const d = createHoverDwell(fire);
    d.start();
    d.start();
    d.start();
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(fire).toHaveBeenCalledTimes(1);
    d.cancel();
    d.start();
    vi.advanceTimersByTime(100);
    d.cancel();
    d.start();
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});
