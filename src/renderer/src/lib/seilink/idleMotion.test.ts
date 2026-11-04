import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_CONFIG,
  IdleScheduler,
  eventGap,
  expSample,
  poseTransform,
  walkProgress,
  type IdleExits,
  type IdlePhase,
  type IdlePose,
} from './idleMotion';

/** Deterministic rng (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXITS: IdleExits = { left: 2.4, right: 2.1 };
const FRAME = 1000 / 30;

interface Run {
  poses: Array<IdlePose & { t: number }>;
  walks: Array<{ start: number; awayMs: number; back: number }>;
}

/** Drive a scheduler at 30 fps for `ms`, recording poses and walk-offs. */
function run(s: IdleScheduler, from: number, ms: number, busyAt: (t: number) => boolean = () => false, keepPoses = false, startPhase?: IdlePhase): Run {
  const poses: Run['poses'] = [];
  const walks: Run['walks'] = [];
  let prev: IdlePhase = startPhase ?? s.phase;
  let cur: { start: number; awayStart: number; awayMs: number } | null = null;
  for (let t = from; t <= from + ms; t += FRAME) {
    const p = s.update(t, { busy: busyAt(t), exits: EXITS });
    if (keepPoses) poses.push({ ...p, t });
    if (p.phase !== prev) {
      if (p.phase === 'standing') cur = { start: t, awayStart: 0, awayMs: 0 };
      if (p.phase === 'away' && cur) cur.awayStart = t;
      if (prev === 'away' && cur) cur.awayMs = t - cur.awayStart;
      if (p.phase === 'seated' && prev === 'sitting' && cur) {
        walks.push({ start: cur.start, awayMs: cur.awayMs, back: t });
        cur = null;
      }
      prev = p.phase;
    }
  }
  return { poses, walks };
}

describe('idle motion timing', () => {
  it('exponential gaps have the requested mean and a refractory floor', () => {
    const r = rng(7);
    const n = 20_000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += expSample(1000, r);
    expect(sum / n).toBeGreaterThan(950);
    expect(sum / n).toBeLessThan(1050);
    for (let i = 0; i < 1000; i++) expect(eventGap(500, 200, r)).toBeGreaterThanOrEqual(500);
  });

  it('walkProgress runs 0 to 1, monotonic, with eased ends', () => {
    for (const [a, b] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ] as const) {
      expect(walkProgress(0, a, b)).toBeCloseTo(0, 6);
      expect(walkProgress(1, a, b)).toBeCloseTo(1, 6);
      let last = -1;
      for (let u = 0; u <= 1.0001; u += 0.01) {
        const v = walkProgress(u, a, b);
        expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        last = v;
      }
    }
    // Eased start: slower than linear early on.
    expect(walkProgress(0.05, true, false)).toBeLessThan(0.05);
  });

  it('walk-offs are rare, spaced, and random (about one every 10-20 minutes)', () => {
    const gaps: number[] = [];
    const aways: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const s = new IdleScheduler(0, {}, rng(seed));
      const { walks } = run(s, 0, 4 * 3_600_000);
      for (let i = 0; i < walks.length; i++) {
        aways.push(walks[i].awayMs);
        if (i > 0) gaps.push(walks[i].start - walks[i - 1].back);
      }
    }
    expect(gaps.length).toBeGreaterThan(20);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(10 * 60_000);
    expect(mean).toBeLessThan(20 * 60_000);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(DEFAULT_IDLE_CONFIG.walkMinGapMs - FRAME);
    // The tail is exponential: its spread is about its mean (a fixed rhythm would be ~0).
    const tail = gaps.map((g) => g - DEFAULT_IDLE_CONFIG.walkMinGapMs);
    const tm = tail.reduce((a, b) => a + b, 0) / tail.length;
    const sd = Math.sqrt(tail.reduce((a, b) => a + (b - tm) ** 2, 0) / tail.length);
    expect(sd / tm).toBeGreaterThan(0.6);
    for (const a of aways) {
      expect(a).toBeGreaterThanOrEqual(DEFAULT_IDLE_CONFIG.awayMinMs - 2 * FRAME);
      expect(a).toBeLessThanOrEqual(DEFAULT_IDLE_CONFIG.awayMaxMs + 2 * FRAME);
    }
  });

  it('different seeds give different schedules', () => {
    const a = new IdleScheduler(0, {}, rng(11));
    const b = new IdleScheduler(0, {}, rng(12));
    expect(a.walkDueAt).not.toBe(b.walkDueAt);
    expect(a.shiftDueAt).not.toBe(b.shiftDueAt);
  });
});

describe('idle motion pose', () => {
  it('seated idle stays small and calm', () => {
    const s = new IdleScheduler(0, {}, rng(5));
    const { poses } = run(s, 0, 5 * 60_000, () => false, true);
    const c = DEFAULT_IDLE_CONFIG;
    let shifts = 0;
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      expect(p.present).toBe(true);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(c.shiftRange + c.swayDrift + 1e-9);
      expect(Math.abs(p.lean)).toBeLessThan(c.swayLeanDeg + 1.2);
      expect(p.lift).toBeGreaterThanOrEqual(0);
      expect(p.lift).toBeLessThan(0.01);
      expect(Math.abs(p.breath - 1)).toBeLessThanOrEqual(c.breathAmp + 1e-9);
      if (i > 0) {
        // No twitch: per-frame change stays tiny.
        expect(Math.abs(p.x - poses[i - 1].x)).toBeLessThan(0.004);
        expect(Math.abs(p.lean - poses[i - 1].lean)).toBeLessThan(0.1);
        if (p.phase === 'shifting' && poses[i - 1].phase !== 'shifting') shifts++;
      }
    }
    // 5 minutes: a handful of seat shifts, not constant fidgeting.
    expect(shifts).toBeGreaterThanOrEqual(2);
    expect(shifts).toBeLessThanOrEqual(20);
  });

  it('a forced walk-off goes stand, out, away, in, sit, and stays continuous', () => {
    const s = new IdleScheduler(0, {}, rng(9));
    run(s, 0, 2000);
    expect(s.forceWalk(2000, EXITS, 12_000)).toBe(true);
    const { poses, walks } = run(s, 2000, 40_000, () => false, true, 'seated');
    const order: IdlePhase[] = [];
    for (const p of poses) if (order[order.length - 1] !== p.phase) order.push(p.phase);
    expect(order.slice(0, 6)).toEqual(['standing', 'walkingOut', 'away', 'walkingIn', 'sitting', 'seated']);
    expect(walks).toHaveLength(1);
    expect(walks[0].awayMs).toBeGreaterThan(11_500);
    expect(walks[0].awayMs).toBeLessThan(12_500);
    const c = DEFAULT_IDLE_CONFIG;
    const maxStep = (c.walkSpeed * 1.5 * FRAME) / 1000;
    for (let i = 1; i < poses.length; i++) {
      const a = poses[i - 1];
      const b = poses[i];
      expect(b.lift).toBeLessThanOrEqual(c.standLift + 1e-9);
      expect(b.lift).toBeGreaterThanOrEqual(-1e-9);
      if (a.present && b.present) {
        expect(Math.abs(b.x - a.x)).toBeLessThan(maxStep);
        expect(Math.abs(b.lift - a.lift)).toBeLessThan(0.006);
        expect(Math.abs(b.lean - a.lean)).toBeLessThan(0.5);
      }
    }
    // Out means out: fully past the frame edge while away.
    const away = poses.filter((p) => !p.present);
    expect(away.length).toBeGreaterThan(0);
    for (const p of away) expect(p.x >= EXITS.right - 1e-9 || p.x <= -EXITS.left + 1e-9).toBe(true);
    // Back on her seat, near the anchor.
    expect(Math.abs(poses[poses.length - 1].x)).toBeLessThan(c.shiftRange + 0.01);
    expect(s.forceWalk(42_100, EXITS)).toBe(true);
  });

  it('forceWalk is refused unless she is seated', () => {
    const s = new IdleScheduler(0, {}, rng(3));
    expect(s.forceWalk(0, EXITS)).toBe(true);
    s.update(100, { busy: false, exits: EXITS });
    expect(s.forceWalk(100, EXITS)).toBe(false);
  });
});

describe('busy holds her in place', () => {
  it('nothing starts while busy', () => {
    const s = new IdleScheduler(0, { walkMinGapMs: 1000, walkMeanGapMs: 1000, shiftMinGapMs: 500, shiftMeanGapMs: 500 }, rng(4));
    const { poses } = run(s, 0, 10 * 60_000, () => true, true);
    for (const p of poses) expect(p.phase).toBe('seated');
  });

  it('busy mid walk-out turns her round and brings her back', () => {
    const s = new IdleScheduler(0, {}, rng(6));
    s.forceWalk(0, EXITS, 30_000);
    // Up and walking by 1.6 s, then the player speaks.
    run(s, 0, 1600);
    expect(s.phase).toBe('walkingOut');
    const { poses } = run(s, 1600 + FRAME, 15_000, () => true, true);
    const phases = new Set(poses.map((p) => p.phase));
    expect(phases.has('away')).toBe(false);
    expect(poses[poses.length - 1].phase).toBe('seated');
    for (let i = 1; i < poses.length; i++) {
      expect(Math.abs(poses[i].lean - poses[i - 1].lean)).toBeLessThan(0.6);
      expect(Math.abs(poses[i].lift - poses[i - 1].lift)).toBeLessThan(0.006);
    }
  });

  it('busy while away calls her straight back, and no new walk-off follows soon after', () => {
    const s = new IdleScheduler(0, {}, rng(8));
    s.forceWalk(0, EXITS, 40_000);
    run(s, 0, 6000);
    expect(s.phase).toBe('away');
    let busyUntil = 6000 + 5000;
    const { poses } = run(s, 6000 + FRAME, 10_000, (t) => t < busyUntil, true);
    expect(poses[0].phase).toBe('walkingIn');
    expect(poses[poses.length - 1].phase).toBe('seated');
    busyUntil = 0;
    expect(s.walkDueAt).toBeGreaterThanOrEqual(11_000 + DEFAULT_IDLE_CONFIG.busyHoldMs - FRAME);
  });

  it('busy while standing up sits her back down', () => {
    const s = new IdleScheduler(0, {}, rng(10));
    s.forceWalk(0, EXITS);
    run(s, 0, 500);
    expect(s.phase).toBe('standing');
    const { poses } = run(s, 500 + FRAME, 3000, () => true, true);
    expect(poses[0].phase).toBe('sitting');
    expect(poses[poses.length - 1].phase).toBe('seated');
    expect(poses[poses.length - 1].lift).toBeCloseTo(0, 6);
  });
});

describe('poseTransform', () => {
  it('maps heights to px about the bottom centre', () => {
    const t = poseTransform({ x: 0.1, lift: 0.05, lean: 1.5, scale: 0.97, breath: 1.01, phase: 'seated', present: true }, 400);
    expect(t).toBe('translate3d(40.00px, -20.00px, 0) rotate(1.500deg) scale(0.9700, 0.9797)');
  });
});
