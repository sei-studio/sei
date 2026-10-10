import { describe, it, expect, vi } from 'vitest';
import { createStaleGate } from './staleGate';
import { BUFFER_MS, STALE_LINE_AGE_MS, STALE_SCENE_DELTA, staleLineVerdict } from '../../../../shared/backseatIpc';

describe('staleLineVerdict (261010)', () => {
  it('always plays a young line, however much the screen moved', () => {
    expect(staleLineVerdict(STALE_LINE_AGE_MS - 1, 1)).toBe(false);
  });
  it('drops an old line only when the screen moved a lot', () => {
    expect(staleLineVerdict(STALE_LINE_AGE_MS, STALE_SCENE_DELTA)).toBe(true);
    expect(staleLineVerdict(STALE_LINE_AGE_MS + 3000, STALE_SCENE_DELTA - 0.01)).toBe(false);
  });
  it('with nothing to compare, drops only a line older than the whole history', () => {
    expect(staleLineVerdict(STALE_LINE_AGE_MS + 1000, null)).toBe(false);
    expect(staleLineVerdict(BUFFER_MS, null)).toBe(true);
  });
  it('sits above what normal play does in five seconds (replay p50 0.19-0.26)', () => {
    expect(STALE_SCENE_DELTA).toBeGreaterThan(0.3);
  });
});

describe('createStaleGate (261010)', () => {
  it('compares against the line frame and logs each drop', () => {
    const log = vi.fn();
    const sceneChangeSince = vi.fn(() => 0.5);
    let now = 10_000;
    const gate = createStaleGate('that ladder looks fun', 4_000, { sceneChangeSince, now: () => now, log });
    expect(gate('arrival')).toBe(true);
    expect(sceneChangeSince).toHaveBeenCalledWith(4_000);
    expect(log.mock.calls[0][0]).toMatch(/stale line dropped at arrival: 6\.0s after its frame, scene change 0\.50/);
    now = 6_000;
    expect(gate('playhead')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
