/**
 * callState: main closing calls on an account switch (260926).
 *
 * The renderer owns a call's audio, so main only learns when it went live
 * (markCallLive, from the connect report) and closes it itself on an account
 * switch (closeAllCallsFromMain) with that duration. The renderer's hang-up
 * report that follows must then be recognised and skipped (consumeClosedByMain)
 * so it does not post a second call row into the incoming account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setCallActive,
  markCallLive,
  closeAllCallsFromMain,
  wasClosedByMain,
  consumeClosedByMain,
  isCallActive,
  wasCallRecentlyActive,
  clearAllCalls,
  applyCallReport,
  endCallFromCompanion,
} from './callState';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
});
afterEach(() => {
  clearAllCalls();
  for (const id of ['sui', 'lyra', 'marv']) consumeClosedByMain(id);
  vi.useRealTimers();
});

describe('closeAllCallsFromMain', () => {
  it('closes every call with its live duration, null when it never connected', () => {
    setCallActive('sui', true);
    markCallLive('sui');
    setCallActive('lyra', true); // still ringing
    vi.advanceTimersByTime(42_000);

    const closed = closeAllCallsFromMain().sort((a, b) => a.characterId.localeCompare(b.characterId));
    expect(closed).toEqual([
      { characterId: 'lyra', connectedMs: null },
      { characterId: 'sui', connectedMs: 42_000 },
    ]);
    expect(isCallActive('sui')).toBe(false);
    expect(isCallActive('lyra')).toBe(false);
    // Still inside the late-line grace window, like an ordinary hang-up.
    expect(wasCallRecentlyActive('sui')).toBe(true);
    expect(closeAllCallsFromMain()).toEqual([]);
  });

  it('marks the closed calls so the renderer hang-up report is skipped exactly once', () => {
    setCallActive('sui', true);
    markCallLive('sui');
    closeAllCallsFromMain();
    expect(wasClosedByMain('sui')).toBe(true);
    expect(consumeClosedByMain('sui')).toBe(true);
    expect(consumeClosedByMain('sui')).toBe(false);
    expect(wasClosedByMain('marv')).toBe(false);
  });

  it('a late connect report cannot resurrect a closed call', () => {
    setCallActive('sui', true);
    closeAllCallsFromMain();
    markCallLive('sui');
    expect(isCallActive('sui')).toBe(false);
    // A later dial starts clean, and main forgets the switch-close.
    setCallActive('sui', true);
    expect(wasClosedByMain('sui')).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(closeAllCallsFromMain()).toEqual([{ characterId: 'sui', connectedMs: null }]);
  });

  it('markCallLive keeps the first connect time', () => {
    setCallActive('sui', true);
    markCallLive('sui');
    vi.advanceTimersByTime(10_000);
    markCallLive('sui'); // a group join re-reporting live
    vi.advanceTimersByTime(5_000);
    expect(closeAllCallsFromMain()).toEqual([{ characterId: 'sui', connectedMs: 15_000 }]);
  });

  it('an ordinary hang-up clears the live stamp', () => {
    setCallActive('sui', true);
    markCallLive('sui');
    setCallActive('sui', false);
    expect(closeAllCallsFromMain()).toEqual([]);
    expect(wasClosedByMain('sui')).toBe(false);
  });
});

/**
 * applyCallReport is what the voice:call-state IPC handler runs (ipc.ts): the
 * handler only forwards `voiceCall` to the supervisor, posts the row for
 * `endedMs`, and stamps presence when `stamp`.
 */
describe('applyCallReport (voice:call-state composition)', () => {
  it('dial, connect, hang-up: opens, stamps live, posts the row with the renderer duration', () => {
    expect(applyCallReport({ characterId: 'sui', active: true })).toEqual({ voiceCall: true, endedMs: null, stamp: true });
    expect(isCallActive('sui')).toBe(true);
    // Connect on the open call: only the live stamp.
    expect(applyCallReport({ characterId: 'sui', active: true, live: true })).toEqual({
      voiceCall: null,
      endedMs: null,
      stamp: false,
    });
    vi.advanceTimersByTime(5_000);
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 5_000 })).toEqual({
      voiceCall: false,
      endedMs: 5_000,
      stamp: true,
    });
    expect(isCallActive('sui')).toBe(false);
  });

  it('a hang-up that never connected posts no row', () => {
    applyCallReport({ characterId: 'sui', active: true });
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 0 })).toEqual({
      voiceCall: false,
      endedMs: null,
      stamp: true,
    });
  });

  it('a group join (live, not yet open) opens and stamps in one report', () => {
    expect(applyCallReport({ characterId: 'lyra', active: true, live: true })).toEqual({
      voiceCall: true,
      endedMs: null,
      stamp: true,
    });
    vi.advanceTimersByTime(3_000);
    expect(closeAllCallsFromMain()).toEqual([{ characterId: 'lyra', connectedMs: 3_000 }]);
  });

  it('after an account switch the late hang-up report has no effects at all', () => {
    applyCallReport({ characterId: 'sui', active: true });
    applyCallReport({ characterId: 'sui', active: true, live: true });
    vi.advanceTimersByTime(10_000);
    expect(closeAllCallsFromMain()).toEqual([{ characterId: 'sui', connectedMs: 10_000 }]);
    // The renderer's teardown reports the hang-up: no second row, no event,
    // no supervisor flip, no presence stamp in the incoming account.
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 10_050 })).toEqual({
      voiceCall: null,
      endedMs: null,
      stamp: false,
    });
    // Consumed: an ordinary call afterwards behaves normally.
    expect(wasClosedByMain('sui')).toBe(false);
  });

  it('a late connect after an account switch cannot reopen the call', () => {
    applyCallReport({ characterId: 'sui', active: true });
    closeAllCallsFromMain();
    expect(applyCallReport({ characterId: 'sui', active: true, live: true })).toEqual({
      voiceCall: null,
      endedMs: null,
      stamp: false,
    });
    expect(isCallActive('sui')).toBe(false);
  });

  it('a new dial after a switch is a new call, and clears the closed mark', () => {
    applyCallReport({ characterId: 'sui', active: true });
    closeAllCallsFromMain();
    expect(applyCallReport({ characterId: 'sui', active: true })).toEqual({ voiceCall: true, endedMs: null, stamp: true });
    expect(wasClosedByMain('sui')).toBe(false);
    expect(isCallActive('sui')).toBe(true);
  });

  it('the closed mark expires, so a much later group join is accepted', () => {
    applyCallReport({ characterId: 'sui', active: true });
    closeAllCallsFromMain(); // the renderer report never came
    vi.advanceTimersByTime(61_000);
    expect(applyCallReport({ characterId: 'sui', active: true, live: true }).voiceCall).toBe(true);
    expect(isCallActive('sui')).toBe(true);
  });

  it('clearAllCalls (renderer gone) forgets closed marks', () => {
    applyCallReport({ characterId: 'sui', active: true });
    closeAllCallsFromMain();
    expect(wasClosedByMain('sui')).toBe(true);
    clearAllCalls();
    expect(wasClosedByMain('sui')).toBe(false);
  });
});

describe('companion hang-up racing an account switch', () => {
  it('a switch in the goodbye gap closes the call in the old account, and the report is dropped', () => {
    applyCallReport({ characterId: 'sui', active: true });
    applyCallReport({ characterId: 'sui', active: true, live: true });
    vi.advanceTimersByTime(20_000);
    endCallFromCompanion('sui'); // end_call: renderer still speaking the goodbye
    expect(isCallActive('sui')).toBe(false);
    vi.advanceTimersByTime(1_500);
    // The switch lands before the renderer's report.
    expect(closeAllCallsFromMain()).toEqual([{ characterId: 'sui', connectedMs: 20_000 }]);
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 21_400 })).toEqual({
      voiceCall: null,
      endedMs: null,
      stamp: false,
    });
  });

  it('without a switch the renderer report posts the row as usual', () => {
    applyCallReport({ characterId: 'sui', active: true });
    applyCallReport({ characterId: 'sui', active: true, live: true });
    vi.advanceTimersByTime(20_000);
    endCallFromCompanion('sui');
    expect(applyCallReport({ characterId: 'sui', active: false, connectedMs: 21_000 }).endedMs).toBe(21_000);
    // The report consumed the pending entry: a later switch has nothing to close.
    expect(closeAllCallsFromMain()).toEqual([]);
  });

  it('a pending companion hang-up older than its TTL is not closed again', () => {
    applyCallReport({ characterId: 'sui', active: true });
    applyCallReport({ characterId: 'sui', active: true, live: true });
    endCallFromCompanion('sui');
    vi.advanceTimersByTime(61_000);
    expect(closeAllCallsFromMain()).toEqual([]);
  });
});
