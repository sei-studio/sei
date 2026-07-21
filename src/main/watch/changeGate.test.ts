/**
 * Change-gate math — the pure functions that decide which screen frames are
 * worth an LLM look. No Electron, no timers: state in, decision out.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GATE_CONFIG,
  decideSend,
  effectiveLowIntervalMs,
  grayFromBitmap,
  initialGateState,
  isBlankFrame,
  meanAbsDiff,
  reactionIsStale,
  unpromptedSayAllowed,
  UNPROMPTED_SAY_COOLDOWN_MS,
  type GateState,
} from './changeGate';

const CFG = DEFAULT_GATE_CONFIG;

/** Base epoch: lastSentAt 0 is the "never sent" sentinel, so tests offset. */
const T0 = 1_000_000;

function sentAt(t: number, quietPolls = 0): GateState {
  return { lastSentAt: T0 + t, quietPolls };
}

function at(offset: number): number {
  return T0 + offset;
}

describe('grayFromBitmap / meanAbsDiff', () => {
  it('averages the three color channels and ignores alpha', () => {
    // Two pixels: (30,60,90,alpha=255) → 60; (0,0,0,0) → 0.
    const bmp = new Uint8Array([30, 60, 90, 255, 0, 0, 0, 0]);
    expect(Array.from(grayFromBitmap(bmp, 2))).toEqual([60, 0]);
  });

  it('meanAbsDiff is 0 for identical frames and exact for a known shift', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([10, 20, 30, 40]);
    expect(meanAbsDiff(a, b)).toBe(0);
    const c = new Uint8Array([20, 10, 30, 60]);
    // |10-20| + |20-10| + |30-30| + |40-60| = 40 / 4 = 10
    expect(meanAbsDiff(a, c)).toBe(10);
  });

  it('meanAbsDiff treats a length mismatch as maximal change', () => {
    expect(meanAbsDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(255);
    expect(meanAbsDiff(new Uint8Array(0), new Uint8Array(0))).toBe(255);
  });
});

describe('decideSend', () => {
  it('always sends the first frame of a session', () => {
    const d = decideSend(initialGateState(), CFG, 0, 1_000);
    expect(d.send).toBe(true);
    expect(d.next.lastSentAt).toBe(1_000);
  });

  it('sends immediately on a HIGH delta once the floor has passed', () => {
    const d = decideSend(sentAt(0), CFG, CFG.highDelta + 1, at(CFG.floorMs));
    expect(d.send).toBe(true);
  });

  it('never sends inside the hard floor, whatever the delta', () => {
    const d = decideSend(sentAt(0), CFG, 255, at(CFG.floorMs - 1));
    expect(d.send).toBe(false);
    // The floor holds even for the LOW path.
    const d2 = decideSend(sentAt(0), CFG, CFG.lowDelta + 1, at(CFG.floorMs - 1));
    expect(d2.send).toBe(false);
  });

  it('a LOW delta waits for the low interval, not just the floor', () => {
    const delta = CFG.lowDelta + 1;
    const early = decideSend(sentAt(0), CFG, delta, at(CFG.floorMs + 1));
    expect(early.send).toBe(false);
    const due = decideSend(sentAt(0), CFG, delta, at(CFG.lowIntervalMs));
    expect(due.send).toBe(true);
  });

  it('a delta at or below LOW never sends and grows the quiet streak', () => {
    const d = decideSend(sentAt(0), CFG, CFG.lowDelta, at(CFG.quietMaxIntervalMs * 2));
    expect(d.send).toBe(false);
    expect(d.next.quietPolls).toBe(1);
    const d2 = decideSend(d.next, CFG, 0, at(CFG.quietMaxIntervalMs * 3));
    expect(d2.next.quietPolls).toBe(2);
  });

  it('the quiet streak stretches the LOW cadence toward the 20-30s band', () => {
    expect(effectiveLowIntervalMs(sentAt(0, 0), CFG)).toBe(CFG.lowIntervalMs);
    expect(effectiveLowIntervalMs(sentAt(0, 4), CFG)).toBe(
      CFG.lowIntervalMs + 4 * CFG.quietStepMs,
    );
    // Capped at the ceiling.
    expect(effectiveLowIntervalMs(sentAt(0, 1000), CFG)).toBe(CFG.quietMaxIntervalMs);

    // A LOW delta that would send on the base cadence is held by the stretch...
    const stretched = sentAt(0, 6); // 10s + 15s = 25s effective
    const held = decideSend(stretched, CFG, CFG.lowDelta + 1, at(CFG.lowIntervalMs + 1));
    expect(held.send).toBe(false);
    // ...but a HIGH delta cuts straight through the stretch.
    const burst = decideSend(stretched, CFG, CFG.highDelta + 1, at(CFG.lowIntervalMs + 1));
    expect(burst.send).toBe(true);
    expect(burst.next.quietPolls).toBe(0);
  });

  it('a send resets the quiet streak; a quiet poll after a send keeps counting', () => {
    const afterSend = decideSend(sentAt(0, 5), CFG, 255, at(CFG.floorMs)).next;
    expect(afterSend.quietPolls).toBe(0);
    const quiet = decideSend(afterSend, CFG, 0, at(2 * CFG.floorMs + 3_000)).next;
    expect(quiet.quietPolls).toBe(1);
  });
});

describe('blank frames + speech pacing', () => {
  it('flags an all-black frame and passes a dark-but-lit one', () => {
    expect(isBlankFrame(new Uint8Array(100))).toBe(true);
    const dark = new Uint8Array(100);
    dark[50] = 180; // one highlight — a dark game scene, not a black capture
    expect(isBlankFrame(dark)).toBe(false);
    expect(isBlankFrame(new Uint8Array(0))).toBe(true);
  });

  it('unprompted say lines respect the 20s cooldown (first line exempt)', () => {
    expect(unpromptedSayAllowed(0, 5_000)).toBe(true);
    expect(unpromptedSayAllowed(10_000, 10_000 + UNPROMPTED_SAY_COOLDOWN_MS - 1)).toBe(false);
    expect(unpromptedSayAllowed(10_000, 10_000 + UNPROMPTED_SAY_COOLDOWN_MS)).toBe(true);
  });

  it('a reaction goes stale only when the frame is old AND the screen diverged', () => {
    const t0 = 100_000;
    // Fresh frame, huge divergence → keep (still within the staleness window).
    expect(reactionIsStale(t0, t0 + 9_000, 255, CFG)).toBe(false);
    // Old frame, small divergence → keep (the moment is still on screen).
    expect(reactionIsStale(t0, t0 + 15_000, CFG.highDelta, CFG)).toBe(false);
    // Old frame + hard divergence → drop.
    expect(reactionIsStale(t0, t0 + 15_000, CFG.highDelta + 1, CFG)).toBe(true);
  });
});
