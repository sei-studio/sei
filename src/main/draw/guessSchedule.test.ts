import { describe, expect, it } from 'vitest';
import {
  GUESS_COOLDOWN_MS,
  STROKE_TRIGGER,
  TIME_TRIGGER_MS,
  guessGate,
  type GuessGateInput,
} from './guessSchedule';

const T0 = 1_000_000;

/** A turn that just started: canvas empty, dispatch clock seeded to turn start. */
function base(over: Partial<GuessGateInput> = {}): GuessGateInput {
  return {
    phase: 'drawing',
    drawer: 'player',
    inFlight: false,
    strokeCount: 0,
    strokesSinceDispatch: 0,
    lastDispatchAt: T0,
    lastCompletedAt: 0,
    pendingChat: false,
    now: T0,
    ...over,
  };
}

describe('guessGate', () => {
  it('never guesses at an empty canvas, however long it waits', () => {
    expect(guessGate(base({ now: T0 + 60_000 }))).toEqual({ go: false, reason: 'empty-canvas' });
  });

  it('fires on the third committed stroke', () => {
    const two = base({ strokeCount: 2, strokesSinceDispatch: 2, now: T0 + 1000 });
    expect(guessGate(two)).toEqual({ go: false, reason: 'no-trigger' });

    const three = base({
      strokeCount: STROKE_TRIGGER,
      strokesSinceDispatch: STROKE_TRIGGER,
      now: T0 + 1000,
    });
    expect(guessGate(three)).toEqual({ go: true, reason: 'strokes' });
  });

  it('fires on the time trigger with fewer than three strokes', () => {
    const justBefore = base({
      strokeCount: 1,
      strokesSinceDispatch: 1,
      now: T0 + TIME_TRIGGER_MS - 1,
    });
    expect(guessGate(justBefore).go).toBe(false);

    const at = base({ strokeCount: 1, strokesSinceDispatch: 1, now: T0 + TIME_TRIGGER_MS });
    expect(guessGate(at)).toEqual({ go: true, reason: 'time' });
  });

  it('does not fire immediately at turn start (the clock is seeded, not zero)', () => {
    // Regression guard: seeding lastDispatchAt to 0 would make now - 0 exceed
    // the time trigger on the very first tick and guess at one stroke.
    const oneStroke = base({ strokeCount: 1, strokesSinceDispatch: 1, now: T0 + 500 });
    expect(guessGate(oneStroke)).toEqual({ go: false, reason: 'no-trigger' });
  });

  it('holds everything while a call is in flight', () => {
    const busy = base({
      inFlight: true,
      strokeCount: 20,
      strokesSinceDispatch: 20,
      now: T0 + 60_000,
    });
    expect(guessGate(busy)).toEqual({ go: false, reason: 'in-flight' });
  });

  it('collapses any number of missed triggers into exactly one look', () => {
    // Nine strokes land during an in-flight call.
    const during = base({ inFlight: true, strokeCount: 9, strokesSinceDispatch: 9, now: T0 + 8_000 });
    expect(guessGate(during).go).toBe(false);

    // The call completes; cooldown passes; ONE dispatch is owed.
    const after = base({
      strokeCount: 9,
      strokesSinceDispatch: 9,
      lastCompletedAt: T0 + 9_000,
      now: T0 + 9_000 + GUESS_COOLDOWN_MS,
    });
    expect(guessGate(after)).toEqual({ go: true, reason: 'strokes' });

    // Dispatch resets the counter, so the next tick is quiet rather than
    // draining a backlog of eight more guesses.
    const settled = base({
      strokeCount: 9,
      strokesSinceDispatch: 0,
      lastDispatchAt: T0 + 14_000,
      lastCompletedAt: T0 + 9_000,
      now: T0 + 14_500,
    });
    expect(guessGate(settled)).toEqual({ go: false, reason: 'no-trigger' });
  });

  it('measures cooldown from completion, not dispatch', () => {
    // A guess dispatched at T0 that took 4s to come back may not be chased
    // until 5s after it LANDED, i.e. T0+9s, not T0+5s.
    const soon = base({
      strokeCount: 5,
      strokesSinceDispatch: 5,
      lastDispatchAt: T0,
      lastCompletedAt: T0 + 4_000,
      now: T0 + 6_000,
    });
    expect(guessGate(soon)).toEqual({ go: false, reason: 'cooldown' });

    const later = base({
      strokeCount: 5,
      strokesSinceDispatch: 5,
      lastDispatchAt: T0,
      lastCompletedAt: T0 + 4_000,
      now: T0 + 4_000 + GUESS_COOLDOWN_MS,
    });
    expect(later.now - later.lastCompletedAt).toBe(GUESS_COOLDOWN_MS);
    expect(guessGate(later)).toEqual({ go: true, reason: 'strokes' });
  });

  it('does not apply a cooldown before the first guess of a turn', () => {
    const first = base({
      strokeCount: 3,
      strokesSinceDispatch: 3,
      lastCompletedAt: 0,
      now: T0 + 1_000,
    });
    expect(guessGate(first)).toEqual({ go: true, reason: 'strokes' });
  });

  // 260728 — a player who stopped drawing to talk got total silence: chat woke
  // nothing, and the next scheduled look aborted on the unchanged canvas.
  it('answers the player even with nothing drawn yet', () => {
    const spokenTo = base({ pendingChat: true, strokeCount: 0, now: T0 + 1_000 });
    expect(guessGate(spokenTo)).toEqual({ go: true, reason: 'chat' });
  });

  it('answers the player without waiting for the stroke or time trigger', () => {
    const justLooked = base({
      pendingChat: true,
      strokeCount: 4,
      strokesSinceDispatch: 0,
      lastDispatchAt: T0,
      now: T0 + 1_000,
    });
    expect(guessGate(justLooked)).toEqual({ go: true, reason: 'chat' });
    // Same state without the message waits, which is what makes the difference real.
    expect(guessGate({ ...justLooked, pendingChat: false })).toEqual({
      go: false,
      reason: 'no-trigger',
    });
  });

  it('still coalesces a burst of messages behind the cooldown and single flight', () => {
    const inFlight = base({ pendingChat: true, strokeCount: 4, inFlight: true });
    expect(guessGate(inFlight)).toEqual({ go: false, reason: 'in-flight' });

    const cooling = base({
      pendingChat: true,
      strokeCount: 4,
      lastCompletedAt: T0,
      now: T0 + GUESS_COOLDOWN_MS - 1,
    });
    expect(guessGate(cooling)).toEqual({ go: false, reason: 'cooldown' });
  });

  it('ignores chat once the turn is not the player drawing', () => {
    expect(guessGate(base({ pendingChat: true, drawer: 'ai' })).go).toBe(false);
    expect(guessGate(base({ pendingChat: true, phase: 'turn-end' })).go).toBe(false);
  });

  it('stays silent when it is not the player drawing', () => {
    const aiTurn = base({ drawer: 'ai', strokeCount: 5, strokesSinceDispatch: 5 });
    expect(guessGate(aiTurn)).toEqual({ go: false, reason: 'not-drawing' });

    for (const phase of ['setup', 'turn-end', 'gallery'] as const) {
      expect(guessGate(base({ phase, strokeCount: 5, strokesSinceDispatch: 5 })).go).toBe(false);
    }
  });
});
