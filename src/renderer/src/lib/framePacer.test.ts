import { describe, expect, it } from 'vitest';
import { FramePacer } from './framePacer';

describe('FramePacer (261110)', () => {
  /** Drives rAF at `hz` with +-`jitter` ms of seeded noise; returns the vsync gaps between drawn frames. */
  function run(hz: number, cap: number, frames = 600, jitter = 0.6): number[] {
    const pacer = new FramePacer();
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const period = 1000 / hz;
    const gaps: number[] = [];
    let lastDrawn = -1;
    for (let i = 0; i < frames; i++) {
      const t = 1000 + i * period + rnd() * jitter;
      if (pacer.due(t, cap)) {
        if (lastDrawn >= 0 && i > 120) gaps.push(i - lastDrawn);
        lastDrawn = i;
      }
    }
    return gaps;
  }

  it('draws every 2nd vsync at 30 fps on 60 Hz, even with timing jitter', () => {
    const gaps = run(60, 30, 600, 1.5);
    expect(new Set(gaps)).toEqual(new Set([2]));
  });

  it('draws every vsync at 60 fps on 60 Hz', () => {
    expect(new Set(run(60, 60))).toEqual(new Set([1]));
  });

  it('keeps an even whole-vsync rhythm on 75 and 144 Hz', () => {
    // 75 Hz / 30 fps is 2.5 vsyncs: either 2 or 3 is fine, but only one of them.
    expect(new Set(run(75, 30)).size).toBe(1);
    expect(new Set(run(144, 30))).toEqual(new Set([5]));
    expect(new Set(run(144, 60))).toEqual(new Set([2]));
  });

  it('the old fixed check is uneven at 30 fps on a jittery 60 Hz display (the bug)', () => {
    let last = 0;
    const gaps: number[] = [];
    let lastDrawn = -1;
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 600; i++) {
      const t = 1000 + i * (1000 / 60) + rnd() * 1.5;
      if (t - last >= 1000 / 30 - 1) {
        last = t;
        if (lastDrawn >= 0) gaps.push(i - lastDrawn);
        lastDrawn = i;
      }
    }
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it('holds still at cap 0 and picks the rhythm back up after', () => {
    const p = new FramePacer();
    expect(p.due(0, 30)).toBe(true);
    expect(p.due(16.7, 0)).toBe(false);
    expect(p.due(33.4, 0)).toBe(false);
    expect(p.due(50, 30)).toBe(true);
    expect(p.due(66.7, 30)).toBe(false);
    expect(p.due(83.4, 30)).toBe(true);
  });

  it('restarts after a stall instead of drawing a burst to catch up', () => {
    const p = new FramePacer();
    for (let i = 0; i < 60; i++) p.due(i * 16.667, 30);
    const after = [2000, 2016.7, 2033.3, 2050, 2066.7].map((t) => p.due(t, 30));
    expect(after).toEqual([true, false, true, false, true]);
  });
});
