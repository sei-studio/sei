/**
 * Tests for backseatTipPref (260803): the one-time Backseat tip's show/dismiss
 * rules.
 *
 * The predicate is the whole feature: get it wrong and either nobody ever sees
 * the tip, or it comes back forever. Both are invisible in review, and both
 * have already happened once each here.
 *
 * Invariants under test:
 *   1. Nothing stored → the tip shows on the chat screen.
 *   2. Each suppression alone is enough to hide it: dismissed, on the call
 *      view, already sharing, a modal open, the tutorial running.
 *   3. "Got it" persists, and is the ONLY thing that does. Sharing must NOT
 *      retire the tip: the people most owed a beta notice are the ones who
 *      already used the feature in an earlier build.
 *   4. The flag is PER ACCOUNT. localStorage is one bucket for the whole app
 *      and is not moved when the profile scope changes, so the key carries the
 *      scope; a second account on the same machine must not inherit the
 *      first's dismissal.
 *   5. A storage read/write that throws (private mode) degrades to "not done"
 *      rather than crashing the header.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthState } from '@shared/ipc';

/** The store is mocked rather than imported: the real module pulls in the
 *  preload bridge, and all this file needs from it is the active scope. */
let authState: AuthState = { kind: 'local' };
vi.mock('./stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ state: authState }) },
}));

const { backseatTipDone, dismissBackseatTip, shouldShowBackseatTip } = await import(
  './backseatTipPref'
);

const KEY_LOCAL = 'sei.backseatTipDone.v2.local';

const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: 'a@b.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});

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
  authState = { kind: 'local' };
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

const base = {
  done: false,
  onChatScreen: true,
  sharing: false,
  modalOpen: false,
  tutorialActive: false,
} as const;

describe('shouldShowBackseatTip', () => {
  it('shows for a first-time player on the chat screen', () => {
    expect(shouldShowBackseatTip({ ...base })).toBe(true);
  });

  it('hides once the tip is done', () => {
    expect(shouldShowBackseatTip({ ...base, done: true })).toBe(false);
  });

  it('hides on the call view, where the player is already past it', () => {
    expect(shouldShowBackseatTip({ ...base, onChatScreen: false })).toBe(false);
  });

  it('hides while a share is already running', () => {
    expect(shouldShowBackseatTip({ ...base, sharing: true })).toBe(false);
  });

  it('hides behind a modal, including the picker the button itself opens', () => {
    expect(shouldShowBackseatTip({ ...base, modalOpen: true })).toBe(false);
  });

  it('hides during the tutorial, which spotlights the same button', () => {
    // Two pointers at one button is worse than either alone, and the tutorial
    // scrim would sit over the card anyway.
    expect(shouldShowBackseatTip({ ...base, tutorialActive: true })).toBe(false);
  });
});

describe('backseatTipDone persistence', () => {
  it('is false before anything happens', () => {
    expect(backseatTipDone()).toBe(false);
  });

  it('is true after "Got it"', () => {
    dismissBackseatTip();
    expect(localStorage.getItem(KEY_LOCAL)).toBe('1');
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

  it('does not carry a dismissal across accounts', () => {
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    dismissBackseatTip();
    expect(backseatTipDone()).toBe(true);

    authState = signedIn('22222222-2222-2222-2222-222222222222');
    expect(backseatTipDone()).toBe(false);

    // ...and the first account keeps its dismissal rather than being reset by
    // the second account arriving.
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    expect(backseatTipDone()).toBe(true);
  });

  it('keeps the signed-out profile separate from any account', () => {
    // 'local' is a real profile scope in main (paths.setActiveScope), not an
    // absence of one, so it gets its own flag like any account.
    dismissBackseatTip();
    expect(backseatTipDone()).toBe(true);
    authState = signedIn('33333333-3333-3333-3333-333333333333');
    expect(backseatTipDone()).toBe(false);
  });

  it('degrades to not-done when storage is unavailable', () => {
    install(fakeStorage({ throws: true }));
    expect(backseatTipDone()).toBe(false);
    expect(() => dismissBackseatTip()).not.toThrow();
    expect(backseatTipDone()).toBe(false);
  });
});
