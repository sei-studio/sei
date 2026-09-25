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
