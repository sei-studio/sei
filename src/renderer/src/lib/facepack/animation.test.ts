/**
 * FacepackView timing (261028): blink, viseme, expression decay, idle pose.
 */
import { describe, it, expect } from 'vitest';
import {
  BlinkScheduler,
  BLINK_GAP_MAX_MS,
  VisemeDriver,
  VISEME_HOLD_MS,
  pickViseme,
  ExpressionTimeline,
  TEXT_LINE_MS,
  nextPose,
  nextPoseDelay,
  POSE_GAP_MIN_MS,
  POSE_GAP_MAX_MS,
} from './animation';

/** Deterministic rand from a list (cycled). */
function seq(...xs: number[]): () => number {
  let i = 0;
  return () => xs[i++ % xs.length];
}

describe('BlinkScheduler', () => {
  it('blinks half, closed, half, then opens', () => {
    // rand 0.5 → first blink at 800 + 0.5*3500 = 2550; 0.9 → no double.
    const b = new BlinkScheduler(0, seq(0.5, 0.5, 0.9));
    expect(b.stateAt(2000, true)).toBe('open');
    expect(b.stateAt(2550, true)).toBe('half');
    expect(b.stateAt(2600, true)).toBe('closed');
    expect(b.stateAt(2650, true)).toBe('half');
    expect(b.stateAt(2700, true)).toBe('open');
  });

  it('canBlink false keeps the eyes open and cancels a blink in progress', () => {
    const b = new BlinkScheduler(0, seq(0.5, 0.5, 0.9));
    expect(b.stateAt(2600, true)).toBe('half');
    expect(b.stateAt(2610, false)).toBe('open');
    for (let t = 2620; t < 2620 + 2 * BLINK_GAP_MAX_MS; t += 16) {
      expect(b.stateAt(t, false)).toBe('open');
    }
  });

  it('eventually blinks when allowed', () => {
    const b = new BlinkScheduler(0);
    const seen = new Set<string>();
    for (let t = 0; t < 20_000; t += 10) seen.add(b.stateAt(t, true));
    expect(seen).toEqual(new Set(['open', 'half', 'closed']));
  });
});

describe('pickViseme', () => {
  const at = (level: number, tilt: number) => {
    // amplitude tilt t = hi/(lo+hi) with lo = 1 - t, hi = t (power = amp^2).
    return { level, low: (1 - tilt) ** 2, high: tilt ** 2 };
  };
  it('is rest when quiet relative to the peak', () => {
    expect(pickViseme(at(0.1, 0.09), 1)).toBe('rest');
    expect(pickViseme(at(0.0, 0.09))).toBe('rest');
  });
  it('reads tilt against the speaker baseline', () => {
    expect(pickViseme(at(0.8, 0.09), 1, 0.09)).toBe('aa');
    expect(pickViseme(at(0.8, 0.3), 1, 0.09)).toBe('ii');
    expect(pickViseme(at(0.8, 0.18), 1, 0.09)).toBe('ee');
    expect(pickViseme(at(0.8, 0.04), 1, 0.09)).toBe('oo');
    expect(pickViseme(at(0.3, 0.04), 1, 0.09)).toBe('uu');
    // The same tilt is bright for a dark voice and neutral for a bright one.
    expect(pickViseme(at(0.8, 0.13), 1, 0.055)).toBe('ee');
    expect(pickViseme(at(0.8, 0.13), 1, 0.13)).toBe('aa');
  });
  it('loudness is relative to the peak (AGC)', () => {
    expect(pickViseme(at(0.3, 0.09), 1)).toBe('ee');
    expect(pickViseme(at(0.3, 0.09), 0.3)).toBe('aa');
  });
});

describe('VisemeDriver', () => {
  const loud = { level: 0.8, low: 0.83, high: 0.0081 };
  it('rests when not speaking', () => {
    const d = new VisemeDriver();
    expect(d.update(0, false, loud)).toBe('rest');
  });
  it('holds a shape at least VISEME_HOLD_MS', () => {
    const d = new VisemeDriver();
    const first = d.update(0, true, loud);
    expect(first).not.toBe('rest');
    expect(d.update(VISEME_HOLD_MS - 10, false, null)).toBe(first);
    expect(d.update(VISEME_HOLD_MS, false, null)).toBe('rest');
  });
  it('applies substitutions (Lyra has no ii)', () => {
    const d = new VisemeDriver({ ii: 'ee' });
    const bright = { level: 0.8, low: 0.49, high: 0.09 };
    expect(d.update(0, true, bright)).toBe('ee');
  });
  it('moves the mouth without a level feed', () => {
    const d = new VisemeDriver({}, seq(0.1, 0.0, 0.2, 0.3, 0.4, 0.6));
    const shapes = new Set<string>();
    for (let t = 0; t < 2000; t += 40) shapes.add(d.update(t, true, null));
    expect(shapes.size).toBeGreaterThan(1);
  });
});

describe('ExpressionTimeline', () => {
  it('a strong expression decays to neutral after the line plus its hold', () => {
    const tl = new ExpressionTimeline(0);
    tl.setSpeaking(true, 0);
    tl.set('laugh', 100);
    tl.setSpeaking(false, 3000);
    expect(tl.tick(3000 + 1400)).toBe(false);
    expect(tl.current).toBe('laugh');
    expect(tl.tick(3000 + 1500)).toBe(true);
    expect(tl.current).toBe('neutral');
  });
  it('a typed-chat cue counts a nominal line length', () => {
    const tl = new ExpressionTimeline(0);
    tl.set('surprised', 0);
    expect(tl.tick(TEXT_LINE_MS + 1999)).toBe(false);
    expect(tl.tick(TEXT_LINE_MS + 2000)).toBe(true);
  });
  it('a plain expression persists until 60 s without speech', () => {
    const tl = new ExpressionTimeline(0);
    tl.set('smug', 0);
    expect(tl.tick(59_999)).toBe(false);
    expect(tl.current).toBe('smug');
    expect(tl.tick(60_000)).toBe(true);
    expect(tl.current).toBe('neutral');
  });
  it('never decays while speaking', () => {
    const tl = new ExpressionTimeline(0);
    tl.setSpeaking(true, 0);
    tl.set('excited', 0);
    expect(tl.tick(120_000)).toBe(false);
  });
  it('bumps seq on every set', () => {
    const tl = new ExpressionTimeline(0);
    tl.set('happy', 0);
    tl.set('happy', 1);
    expect(tl.seq).toBe(2);
  });
});

describe('nextPose', () => {
  const all = ['c', 'l1', 'l2', 'r1', 'r2', 'tl', 'tr'];
  it('only moves to a neighbour', () => {
    for (let i = 0; i < 200; i++) {
      const p = nextPose('c', all, null);
      expect(['c', 'l1', 'r1', 'tl', 'tr']).toContain(p);
      const q = nextPose('l2', all, null);
      expect(['l2', 'l1']).toContain(q);
    }
  });
  it('leans toward the cursor side', () => {
    let left = 0;
    let right = 0;
    for (let i = 0; i < 2000; i++) {
      const p = nextPose('c', all, -0.9, Math.random);
      if (p === 'l1' || p === 'tl') left++;
      if (p === 'r1' || p === 'tr') right++;
    }
    expect(left).toBeGreaterThan(right * 4);
  });
  it('a pack without the neighbour holds or goes home', () => {
    expect(nextPose('l2', ['c'], null)).toBe('c');
    expect(nextPose('c', ['c'], null)).toBe('c');
  });
  it('delays 4-10 s', () => {
    expect(nextPoseDelay(() => 0)).toBe(POSE_GAP_MIN_MS);
    expect(nextPoseDelay(() => 1)).toBe(POSE_GAP_MAX_MS);
  });
});
