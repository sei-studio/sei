/**
 * Tests for gamesTipPref (260929): the one-time games tip's show/dismiss
 * rules. The module replaced backseatTipPref (260803) and keeps its rules.
 *
 * The predicate is the whole feature: get it wrong and either nobody ever sees
 * the tip, or it comes back forever. Both are invisible in review, and both
 * happened once each to the Backseat tip this replaced.
 *
 * Invariants under test:
 *   1. Nothing stored -> the tip shows on the chat screen.
 *   2. Each suppression alone is enough to hide it: retired, on the call view,
 *      a game surface open, a modal open, the tutorial running, the first
 *      moment live.
 *   3. Retiring persists. The key is NEW, so a dismissal of the old Backseat
 *      tip does not carry over: everyone sees this one once.
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

const { gamesTipDone, dismissGamesTip, shouldShowGamesTip } = await import('./gamesTipPref');

const KEY_LOCAL = 'sei.gamesTipDone.v1.local';

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
  modalOpen: false,
  tutorialActive: false,
} as const;

describe('shouldShowGamesTip', () => {
  it('shows for a first-time player on the chat screen', () => {
    expect(shouldShowGamesTip({ ...base })).toBe(true);
  });

  it('hides once the tip is done', () => {
    expect(shouldShowGamesTip({ ...base, done: true })).toBe(false);
  });

  it('hides on the call view, where the player is already past it', () => {
    expect(shouldShowGamesTip({ ...base, onChatScreen: false })).toBe(false);
  });

  it('hides while a game surface is open under the header', () => {
    expect(shouldShowGamesTip({ ...base, gameOpen: true })).toBe(false);
    expect(shouldShowGamesTip({ ...base, gameOpen: false })).toBe(true);
  });

  it('hides behind a modal, including the games picker the button itself opens', () => {
    expect(shouldShowGamesTip({ ...base, modalOpen: true })).toBe(false);
  });

  it('hides during the tutorial, which spotlights the same button', () => {
    // Two pointers at one button is worse than either alone, and the tutorial
    // scrim would sit over the card anyway.
    expect(shouldShowGamesTip({ ...base, tutorialActive: true })).toBe(false);
  });

  it('hides while the guided first moment is pending or showing its card', () => {
    expect(shouldShowGamesTip({ ...base, firstMomentLive: true })).toBe(false);
    expect(shouldShowGamesTip({ ...base, firstMomentLive: false })).toBe(true);
  });
});

describe('gamesTipDone persistence', () => {
  it('is false before anything happens', () => {
    expect(gamesTipDone()).toBe(false);
  });

  it('is true once retired ("Got it" or a click on the games button)', () => {
    dismissGamesTip();
    expect(localStorage.getItem(KEY_LOCAL)).toBe('1');
    expect(gamesTipDone()).toBe(true);
  });

  it('ignores a dismissed Backseat tip, so everyone sees the games tip once', () => {
    // The games tip replaced the Backseat one in the same header; a player who
    // pressed "Got it" on that one has not been told about the games.
    localStorage.setItem('sei.gamesTipDone.v2.local', '1');
    localStorage.setItem('sei.gamesTipDone', '1');
    expect(gamesTipDone()).toBe(false);
  });

  it('does not carry a dismissal across accounts', () => {
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    dismissGamesTip();
    expect(gamesTipDone()).toBe(true);

    authState = signedIn('22222222-2222-2222-2222-222222222222');
    expect(gamesTipDone()).toBe(false);

    // ...and the first account keeps its dismissal rather than being reset by
    // the second account arriving.
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    expect(gamesTipDone()).toBe(true);
  });

  it('keeps the signed-out profile separate from any account', () => {
    // 'local' is a real profile scope in main (paths.setActiveScope), not an
    // absence of one, so it gets its own flag like any account.
    dismissGamesTip();
    expect(gamesTipDone()).toBe(true);
    authState = signedIn('33333333-3333-3333-3333-333333333333');
    expect(gamesTipDone()).toBe(false);
  });

  it('degrades to not-done when storage is unavailable', () => {
    install(fakeStorage({ throws: true }));
    expect(gamesTipDone()).toBe(false);
    expect(() => dismissGamesTip()).not.toThrow();
    expect(gamesTipDone()).toBe(false);
  });
});
