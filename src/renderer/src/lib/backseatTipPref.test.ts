/**
 * Tests for backseatTipPref (260803): the one-time Backseat tip's show/dismiss
 * rules.
 *
 * The predicate is the whole feature: get it wrong and either nobody ever sees
 * the tip, or it comes back forever. Both are invisible in review.
 *
 * Invariants under test:
 *   1. Nothing stored → the tip shows (on the fullscreen controls, with a
 *      companion to share with, while not already sharing).
 *   2. Each suppression condition alone is enough to hide it: dismissed,
 *      already sharing, no share target, and the small (docked) size.
 *   3. "Got it" persists, and is the ONLY thing that does. Sharing must NOT
 *      retire the tip: the people most owed a beta notice are the ones who
 *      already used the feature in an earlier build (revised 260803).
 *   4. A storage read/write that throws (private mode) degrades to "not done"
 *      rather than crashing the call controls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { backseatTipDone, dismissBackseatTip, shouldShowBackseatTip } from './backseatTipPref';

const KEY = 'sei.backseatTipDone.v2';

/** Minimal in-memory localStorage: the module only uses getItem/setItem. */
function fakeStorage(opts?: { throws?: boolean }): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (opts?.throws) throw new Error('denied');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts?.throws) throw new Error('denied');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function install(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  install(fakeStorage());
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

const base = { done: false, sharing: false, hasTarget: true, size: 'lg' } as const;

describe('shouldShowBackseatTip', () => {
  it('shows for a first-time caller on the fullscreen controls', () => {
    expect(shouldShowBackseatTip({ ...base })).toBe(true);
  });

  it('hides once the tip is done', () => {
    expect(shouldShowBackseatTip({ ...base, done: true })).toBe(false);
  });

  it('hides while a share is already running', () => {
    expect(shouldShowBackseatTip({ ...base, sharing: true })).toBe(false);
  });

  it('hides when the share button has no companion to target', () => {
    expect(shouldShowBackseatTip({ ...base, hasTarget: false })).toBe(false);
  });

  it('hides on the small docked controls', () => {
    expect(shouldShowBackseatTip({ ...base, size: 'sm' })).toBe(false);
  });
});

describe('backseatTipDone persistence', () => {
  it('is false before anything happens', () => {
    expect(backseatTipDone()).toBe(false);
  });

  it('is true after "Got it"', () => {
    dismissBackseatTip();
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(backseatTipDone()).toBe(true);
  });

  it('is NOT retired by a share, only by "Got it"', () => {
    // The regression this pins: an earlier version wrote the same flag from
    // useBackseatStore.share(), so everyone who had used backseat before the
    // tip existed was silenced by their own first share and never saw it.
    // Nothing outside this module may write the flag.
    expect(backseatTipDone()).toBe(false);
    expect(shouldShowBackseatTip({ ...base, sharing: true })).toBe(false);
    expect(shouldShowBackseatTip({ ...base, sharing: false })).toBe(true);
  });

  it('ignores a flag left by the previous key, so the notice re-announces', () => {
    localStorage.setItem('sei.backseatTipDone', '1');
    expect(backseatTipDone()).toBe(false);
  });

  it('degrades to not-done when storage is unavailable', () => {
    install(fakeStorage({ throws: true }));
    expect(backseatTipDone()).toBe(false);
    expect(() => dismissBackseatTip()).not.toThrow();
    expect(backseatTipDone()).toBe(false);
  });
});
