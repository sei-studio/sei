/** 260929: one in-character "your move" nudge per idle player turn. */
import { describe, it, expect } from 'vitest';
import { nudgeDueInMs, type NudgeInput } from './turnNudge';

const T = { nudgeFirstMoveMs: 20_000, nudgeMoveMs: 120_000 };

function input(over: Partial<NudgeInput> = {}): NudgeInput {
  return {
    now: 100_000,
    playerTurnSince: 100_000,
    lastActivityAt: 0,
    nudged: false,
    firstMove: true,
    active: true,
    busy: false,
    ...over,
  };
}

describe('nudgeDueInMs', () => {
  it('waits the first-move threshold from the start of the turn', () => {
    expect(nudgeDueInMs(input(), T)).toBe(20_000);
    expect(nudgeDueInMs(input({ now: 119_999 }), T)).toBe(1);
    expect(nudgeDueInMs(input({ now: 120_000 }), T)).toBe(0);
  });

  it('uses the longer threshold after the first move', () => {
    expect(nudgeDueInMs(input({ firstMove: false, now: 130_000 }), T)).toBe(90_000);
    expect(nudgeDueInMs(input({ firstMove: false, now: 220_000 }), T)).toBe(0);
  });

  it('never nudges twice in one turn', () => {
    expect(nudgeDueInMs(input({ now: 500_000, nudged: true }), T)).toBeNull();
  });

  it('never nudges when it is not the player turn or the game is not live', () => {
    expect(nudgeDueInMs(input({ playerTurnSince: null, now: 500_000 }), T)).toBeNull();
    expect(nudgeDueInMs(input({ active: false, now: 500_000 }), T)).toBeNull();
  });

  it('measures quiet from the last chat line, so talking pushes it back', () => {
    // Turn began at 100s, player chatted at 115s: due at 135s, not 120s.
    expect(nudgeDueInMs(input({ now: 120_000, lastActivityAt: 115_000 }), T)).toBe(15_000);
    expect(nudgeDueInMs(input({ now: 135_000, lastActivityAt: 115_000 }), T)).toBe(0);
  });

  it('defers instead of talking over a busy table', () => {
    const d = nudgeDueInMs(input({ now: 200_000, busy: true }), T);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(5_000);
  });
});
