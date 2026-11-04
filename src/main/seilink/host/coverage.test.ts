import { describe, it, expect, vi } from 'vitest';
import { computeActivity, INITIAL_INPUTS, RoomActivity } from './coverage';

describe('seilink room activity', () => {
  it('draws at the cap while visible', () => {
    expect(computeActivity(INITIAL_INPUTS, 30)).toEqual({ covered: false, paused: false, fps: 30, reason: 'visible' });
  });

  it('is covered by a window (Windows), an occluded room or an occluded box (macOS)', () => {
    expect(computeActivity({ ...INITIAL_INPUTS, winCovered: true }, 30)).toMatchObject({ covered: true, fps: 0, reason: 'window' });
    expect(computeActivity({ ...INITIAL_INPUTS, roomVisible: false }, 30)).toMatchObject({ covered: true, fps: 0 });
    expect(computeActivity({ ...INITIAL_INPUTS, hasPanel: true, panelVisible: false }, 30)).toMatchObject({ covered: true, fps: 0, reason: 'box-occluded' });
    // No panel yet: its stale visibility does not count.
    expect(computeActivity({ ...INITIAL_INPUTS, hasPanel: false, panelVisible: false }, 30)).toMatchObject({ covered: false, fps: 30 });
  });

  it('pauses while locked, asleep or held, without calling it covered', () => {
    for (const p of [{ locked: true }, { suspended: true }, { held: true }]) {
      expect(computeActivity({ ...INITIAL_INPUTS, ...p }, 30)).toMatchObject({ covered: false, paused: true, fps: 0 });
    }
    expect(computeActivity({ ...INITIAL_INPUTS, locked: true, winCovered: true }, 30).reason).toBe('window+locked');
  });

  it('reports only real changes, and comes back to the cap when uncovered', () => {
    const onChange = vi.fn();
    const a = new RoomActivity(30, onChange);
    a.set({ roomVisible: true });
    expect(onChange).not.toHaveBeenCalled();
    a.set({ winCovered: true });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ covered: true, fps: 0 }));
    a.set({ locked: true });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ covered: true, paused: true, fps: 0 }));
    a.set({ locked: false, winCovered: false });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ covered: false, paused: false, fps: 30 }));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('applies a new cap (battery) and clamps nonsense', () => {
    const onChange = vi.fn();
    const a = new RoomActivity(30, onChange);
    a.setCap(15);
    expect(a.current.fps).toBe(15);
    a.setCap(Number.NaN);
    expect(a.current.fps).toBe(0);
    a.setCap(1000);
    expect(a.current.fps).toBe(240);
    a.set({ winCovered: true });
    a.setCap(30);
    expect(a.current.fps).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
