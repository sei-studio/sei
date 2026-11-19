import { describe, expect, it } from 'vitest';
import { BLINK_CLOSE_MS, BLINK_HOLD_MS, BLINK_MS, Blinker, GazeDriver, Wander, lidCurve, minJerk, springStep, type SpringState } from './organic';

/** Deterministic rng (mulberry32). */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('springStep', () => {
  it('settles on the target without overshoot, whatever the step size', () => {
    for (const dt of [8, 16.7, 33.3, 66.7, 250]) {
      const s: SpringState = { x: 0, v: 0 };
      let max = 0;
      for (let t = 0; t < 3000; t += dt) {
        springStep(s, 1, 4, dt);
        max = Math.max(max, s.x);
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-9);
      expect(s.x).toBeCloseTo(1, 3);
    }
  });

  it('is exact: one long step equals many short ones', () => {
    const a: SpringState = { x: 0, v: 2 };
    const b: SpringState = { x: 0, v: 2 };
    springStep(a, 1, 5, 400);
    for (let i = 0; i < 40; i++) springStep(b, 1, 5, 10);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.v).toBeCloseTo(b.v, 9);
  });

  it('starts gently (no velocity jump when the target moves)', () => {
    const s: SpringState = { x: 0, v: 0 };
    springStep(s, 1, 4, 16);
    // After one frame it has barely moved: an eased start, not a linear tween.
    expect(s.x).toBeLessThan(0.003);
  });
});

describe('minJerk', () => {
  it('runs 0..1 with flat ends', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 9);
    expect(minJerk(0.02)).toBeLessThan(0.001);
    expect(1 - minJerk(0.98)).toBeLessThan(0.001);
  });
});

describe('Wander', () => {
  it('stays within -1..1 and moves smoothly', () => {
    const w = new Wander([7000, 11000, 17000], rngOf(3));
    let prev = w.value(0);
    for (let t = 33; t < 120_000; t += 33) {
      const v = w.value(t);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.05);
      prev = v;
    }
  });
});

describe('blink', () => {
  it('closes fast, holds, opens slower', () => {
    expect(lidCurve(0)).toBe(0);
    expect(lidCurve(BLINK_CLOSE_MS / 2)).toBeCloseTo(0.25, 6); // accelerating shut
    expect(lidCurve(BLINK_CLOSE_MS + 1)).toBe(1);
    expect(lidCurve(BLINK_CLOSE_MS + BLINK_HOLD_MS - 1)).toBe(1);
    // Opening: half-way through the 105 ms the lid is mostly up already (decelerating).
    expect(lidCurve(BLINK_CLOSE_MS + BLINK_HOLD_MS + 52)).toBeCloseTo(0.25, 1);
    expect(lidCurve(BLINK_MS)).toBe(0);
  });

  it('blinks every couple of seconds, never two blinks back to back', () => {
    const b = new Blinker(0, rngOf(7));
    let starts = 0;
    let wasShut = false;
    let lastStart = -Infinity;
    let minGap = Infinity;
    for (let t = 0; t < 120_000; t += 10) {
      const lid = b.lid(t);
      const shut = lid > 0.5;
      if (shut && !wasShut) {
        if (t - lastStart > BLINK_MS * 2 + 100) {
          starts++;
          minGap = Math.min(minGap, t - lastStart);
          lastStart = t;
        }
      }
      wasShut = shut;
    }
    // About one every 2-6 s.
    expect(starts).toBeGreaterThan(15);
    expect(starts).toBeLessThan(60);
    expect(minGap).toBeGreaterThan(1_500);
  });

  it('a face that cannot blink keeps the eyes open', () => {
    const b = new Blinker(0, rngOf(1));
    for (let t = 0; t < 20_000; t += 10) expect(b.lid(t, false)).toBe(0);
  });
});

describe('GazeDriver', () => {
  it('keeps the eyes moving: many fixations a minute, never locked forward', () => {
    const g = new GazeDriver(0, {}, rngOf(11));
    let moves = 0;
    let prevX = 0;
    let prevY = 0;
    let atRest = 0;
    let samples = 0;
    for (let t = 0; t < 60_000; t += 33) {
      const o = g.update(t, {});
      if (Math.hypot(o.gazeX - prevX, o.gazeY - prevY) > 0.02) moves++;
      if (Math.hypot(o.gazeX, o.gazeY) < 0.02) atRest++;
      samples++;
      prevX = o.gazeX;
      prevY = o.gazeY;
      expect(Math.abs(o.gazeX)).toBeLessThanOrEqual(1);
      expect(Math.abs(o.eyeX)).toBeLessThanOrEqual(1);
      expect(Math.abs(o.headRoll)).toBeLessThanOrEqual(1);
    }
    expect(moves).toBeGreaterThan(30);
    expect(atRest / samples).toBeLessThan(0.5);
  });

  it('moves the head smoothly: no frame-to-frame jumps', () => {
    const g = new GazeDriver(0, {}, rngOf(5));
    let px = 0;
    let py = 0;
    let pr = 0;
    let maxStep = 0;
    for (let t = 0; t < 60_000; t += 33) {
      const o = g.update(t, { cursor: { x: Math.sin(t / 900) * 0.8, y: 0.2 } });
      if (t > 0) maxStep = Math.max(maxStep, Math.abs(o.headX - px), Math.abs(o.headY - py), Math.abs(o.headRoll - pr));
      px = o.headX;
      py = o.headY;
      pr = o.headRoll;
    }
    expect(maxStep).toBeLessThan(0.05);
  });

  it('a look is an eased glide, not a jump (261119: "eyes jitter")', () => {
    const g = new GazeDriver(0, { homeChance: 0, cursorChance: 0, interestChance: 0, glanceChance: 1 }, rngOf(9));
    let prev = g.update(0, {}).gazeX;
    let biggestFrame = 0;
    for (let t = 33; t < 30_000; t += 33) {
      const x = g.update(t, {}).gazeX;
      biggestFrame = Math.max(biggestFrame, Math.abs(x - prev));
      prev = x;
    }
    // At 30 fps the eyes never move more than maxSpeed allows in one frame (4/s * 33 ms), plus the drift.
    expect(biggestFrame).toBeLessThan(0.14);
    expect(biggestFrame).toBeGreaterThan(0.02);
  });

  it('turns a stepped cursor feed (150 ms polls) into a smooth follow', () => {
    const g = new GazeDriver(0, { homeChance: 0, cursorChance: 1, activeCursorChance: 1, interestChance: 0, glanceChance: 0 }, rngOf(4));
    let feed = { x: 0, y: 0 };
    const xs: number[] = [];
    for (let t = 0; t < 12_000; t += 16) {
      // The host only reports the cursor every 150 ms.
      if (t % 150 < 16) feed = { x: Math.sin(t / 1200) * 0.6, y: Math.cos(t / 1700) * 0.3 };
      const o = g.update(t, { cursor: feed });
      if (t > 2_000) xs.push(o.gazeX);
    }
    // Second difference (acceleration per frame): a stepped follow shows a spike every poll.
    let maxAcc = 0;
    for (let i = 2; i < xs.length; i++) maxAcc = Math.max(maxAcc, Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2]));
    expect(maxAcc).toBeLessThan(0.006);
  });

  it('a cursor resting on the mouse does not jiggle her eyes (dead zone)', () => {
    const g = new GazeDriver(0, { homeChance: 0, cursorChance: 1, activeCursorChance: 1, interestChance: 0, glanceChance: 0, drift: 0 }, rngOf(6));
    const rng = rngOf(77);
    let px = 0;
    let travel = 0;
    for (let t = 0; t < 8_000; t += 16) {
      // A hand on the mouse: the cursor trembles by about 0.01 around one point.
      const cur = { x: 0.4 + (rng() - 0.5) * 0.02, y: 0.1 + (rng() - 0.5) * 0.02 };
      const o = g.update(t, { cursor: cur });
      if (t > 3_000) travel += Math.abs(o.gazeX - px);
      px = o.gazeX;
    }
    // Over 5 s the gaze barely moves (no tremor following).
    expect(travel).toBeLessThan(0.05);
  });

  it('looks at a cursor that starts moving, and keeps with it while it moves', () => {
    const g = new GazeDriver(0, {}, rngOf(31));
    let near = 0;
    let n = 0;
    for (let t = 0; t < 20_000; t += 33) {
      // Still for 5 s, then sweeping.
      const cx = t < 5_000 ? -0.5 : -0.5 + Math.sin((t - 5_000) / 2_000) * 0.6;
      const o = g.update(t, { cursor: { x: cx, y: 0.1 } });
      if (t > 6_000) {
        n++;
        if (Math.abs(o.gazeX - cx) < 0.2) near++;
      }
    }
    expect(near / n).toBeGreaterThan(0.6);
  });

  it('the head sways only a little (261119: "no pendulum")', () => {
    const g = new GazeDriver(0, { homeChance: 1, cursorChance: 0, interestChance: 0, glanceChance: 0 }, rngOf(8));
    let maxRoll = 0;
    let maxHead = 0;
    for (let t = 0; t < 120_000; t += 50) {
      const o = g.update(t, {});
      maxRoll = Math.max(maxRoll, Math.abs(o.headRoll));
      maxHead = Math.max(maxHead, Math.abs(o.headX));
    }
    expect(maxRoll).toBeLessThan(0.3);
    expect(maxHead).toBeLessThan(0.1);
  });

  it('glances at the cursor and at room objects when given them', () => {
    const g = new GazeDriver(
      0,
      {
        homeChance: 0,
        cursorChance: 0.5,
        interestChance: 0.5,
        glanceChance: 0,
      },
      rngOf(21),
    );
    let nearCursor = 0;
    let nearThing = 0;
    for (let t = 0; t < 60_000; t += 33) {
      const o = g.update(t, {
        cursor: { x: 0.6, y: -0.2 },
        interests: [{ x: -0.7, y: 0.3 }],
      });
      if (Math.hypot(o.gazeX - 0.6, o.gazeY + 0.2) < 0.08) nearCursor++;
      if (Math.hypot(o.gazeX + 0.7, o.gazeY - 0.3) < 0.12) nearThing++;
    }
    expect(nearCursor).toBeGreaterThan(50);
    expect(nearThing).toBeGreaterThan(50);
  });

  it('pursues a moving cursor smoothly while it follows it', () => {
    const g = new GazeDriver(0, { homeChance: 0, cursorChance: 1, interestChance: 0, glanceChance: 0 }, rngOf(4));
    let px = 0;
    let maxStep = 0;
    let near = 0;
    let n = 0;
    for (let t = 0; t < 30_000; t += 33) {
      const cx = Math.sin(t / 1500) * 0.6;
      const o = g.update(t, { cursor: { x: cx, y: 0 } });
      if (t > 3000) {
        maxStep = Math.max(maxStep, Math.abs(o.gazeX - px));
        if (Math.abs(o.gazeX - cx) < 0.15) near++;
        n++;
      }
      px = o.gazeX;
    }
    // Tracks it most of the time, never jumping more than a fast pursuit would.
    expect(near / n).toBeGreaterThan(0.6);
    expect(maxStep).toBeLessThan(0.08);
  });

  it('allocates nothing per update (the output object is reused)', () => {
    const g = new GazeDriver(0, {}, rngOf(2));
    const a = g.update(16, {});
    const b = g.update(32, {});
    expect(a).toBe(b);
  });
});
