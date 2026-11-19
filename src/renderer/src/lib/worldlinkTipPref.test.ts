/**
 * Tests for worldlinkTipPref (261119): the one-time "New" tip under the chat
 * header's WorldLink button. It replaced the games tip (260929), which had
 * replaced the Backseat tip (260803), and keeps their storage rules.
 *
 * Invariants under test:
 *   1. Nothing stored -> the tip shows on the chat screen where WorldLink runs.
 *   2. Each suppression alone hides it: retired, WorldLink unavailable,
 *      WorldLink already known, the call view, a game surface, a modal, a
 *      WorldLink surface (sheet, editor, intro, hint, move in progress), a
 *      tour, the first moment.
 *   3. It never talks over WorldLink's own onboarding: the first-link intro
 *      seen or the guide's tour finished hide it for good, a snoozed or
 *      never-offered tour does not, and opening WorldLink from any entry
 *      (seilinkFlow.trackEntry) retires it.
 *   4. The key is NEW: a dismissed games (or Backseat) tip does not carry over.
 *   5. The flag is PER ACCOUNT.
 *   6. Storage that throws degrades to "not done" across launches but a
 *      dismissal still holds for the session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthState } from '@shared/ipc';

/** The store is mocked rather than imported: the real module pulls in the
 *  preload bridge, and all this file needs from it is the active scope. */
let authState: AuthState = { kind: 'local' };
vi.mock('./stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ state: authState }) },
}));

const {
  worldlinkTipDone,
  dismissWorldlinkTip,
  shouldShowWorldlinkTip,
  worldlinkAlreadyKnown,
  claimTipShown,
  useWorldlinkTipStore,
  __resetWorldlinkTipSessionForTest,
} = await import('./worldlinkTipPref');
const { markIntroSeen } = await import('./seilink/introPref');
const { writeTourRecord, afterOffered, afterNotNow, retired, EMPTY_TOUR_RECORD } = await import('./seilink/tourPref');

const KEY_LOCAL = 'sei.worldlinkTipDone.v1.local';

const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: 'a@b.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});

/** Minimal in-memory localStorage: the modules only use getItem/setItem. */
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
  __resetWorldlinkTipSessionForTest();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

const base = {
  done: false,
  available: true,
  alreadyKnown: false,
  onChatScreen: true,
  modalOpen: false,
  seilinkOpen: false,
  tutorialActive: false,
} as const;

describe('shouldShowWorldlinkTip', () => {
  it('shows on the chat screen for someone who has not met WorldLink', () => {
    expect(shouldShowWorldlinkTip({ ...base })).toBe(true);
  });

  it('hides once the tip is done', () => {
    expect(shouldShowWorldlinkTip({ ...base, done: true })).toBe(false);
  });

  it('hides where WorldLink cannot run (there is no button to point at)', () => {
    expect(shouldShowWorldlinkTip({ ...base, available: false })).toBe(false);
  });

  it('hides for someone who already knows WorldLink', () => {
    expect(shouldShowWorldlinkTip({ ...base, alreadyKnown: true })).toBe(false);
  });

  it('hides on the call view, while a game surface is open, and behind a modal', () => {
    expect(shouldShowWorldlinkTip({ ...base, onChatScreen: false })).toBe(false);
    expect(shouldShowWorldlinkTip({ ...base, gameOpen: true })).toBe(false);
    expect(shouldShowWorldlinkTip({ ...base, modalOpen: true })).toBe(false);
  });

  it('never stacks on a WorldLink surface (the sheet or intro the button opens)', () => {
    expect(shouldShowWorldlinkTip({ ...base, seilinkOpen: true })).toBe(false);
  });

  it('hides during a tour: the WorldLink tour spotlights the same button', () => {
    expect(shouldShowWorldlinkTip({ ...base, tutorialActive: true })).toBe(false);
  });

  it('hides while the guided first moment is pending or showing its card', () => {
    expect(shouldShowWorldlinkTip({ ...base, firstMomentLive: true })).toBe(false);
    expect(shouldShowWorldlinkTip({ ...base, firstMomentLive: false })).toBe(true);
  });
});

describe('worldlinkAlreadyKnown (WorldLink onboarding wins)', () => {
  it('is false for someone who never met WorldLink', () => {
    expect(worldlinkAlreadyKnown()).toBe(false);
  });

  it('is true once the first-link intro was seen (used WorldLink, even on an older build)', () => {
    markIntroSeen();
    expect(worldlinkAlreadyKnown()).toBe(true);
  });

  it('is true once the guide\'s tour is finished (Sure, completed, dropped, declined twice)', () => {
    writeTourRecord(retired(afterOffered(EMPTY_TOUR_RECORD)));
    expect(worldlinkAlreadyKnown()).toBe(true);
  });

  it('stays false for a tour that was only offered or snoozed once', () => {
    const offered = afterOffered(EMPTY_TOUR_RECORD);
    writeTourRecord(offered);
    expect(worldlinkAlreadyKnown()).toBe(false);
    writeTourRecord(afterNotNow(offered, 1_000).record);
    expect(worldlinkAlreadyKnown()).toBe(false);
  });

  it('is per account', () => {
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    markIntroSeen();
    expect(worldlinkAlreadyKnown()).toBe(true);
    authState = signedIn('22222222-2222-2222-2222-222222222222');
    expect(worldlinkAlreadyKnown()).toBe(false);
  });
});

describe('opening WorldLink retires the tip', () => {
  it('every entry (seilinkFlow.trackEntry) retires it and wakes a mounted header', async () => {
    vi.doMock('./ipcClient', () => ({ sei: { track: vi.fn() } }));
    const { trackEntry } = await import('./seilink/seilinkFlow');
    const before = useWorldlinkTipStore.getState().rev;
    trackEntry('0b9c4e7a-1f2d-4c3b-9a8e-7d6c5b4a3f21', 'gear', 'sheet');
    expect(worldlinkTipDone()).toBe(true);
    expect(useWorldlinkTipStore.getState().rev).toBe(before + 1);
    vi.doUnmock('./ipcClient');
  });
});

describe('worldlinkTipDone persistence', () => {
  it('is false before anything happens', () => {
    expect(worldlinkTipDone()).toBe(false);
  });

  it('is true once retired', () => {
    dismissWorldlinkTip();
    expect(localStorage.getItem(KEY_LOCAL)).toBe('1');
    expect(worldlinkTipDone()).toBe(true);
  });

  it('ignores a dismissed games or Backseat tip, so everyone sees the WorldLink tip once', () => {
    localStorage.setItem('sei.gamesTipDone.v1.local', '1');
    localStorage.setItem('sei.backseatTipDone.v2.local', '1');
    expect(worldlinkTipDone()).toBe(false);
  });

  it('does not carry a dismissal across accounts', () => {
    authState = signedIn('11111111-1111-1111-1111-111111111111');
    dismissWorldlinkTip();
    expect(worldlinkTipDone()).toBe(true);

    authState = signedIn('22222222-2222-2222-2222-222222222222');
    expect(worldlinkTipDone()).toBe(false);

    authState = signedIn('11111111-1111-1111-1111-111111111111');
    expect(worldlinkTipDone()).toBe(true);
  });

  it('keeps the signed-out profile separate from any account', () => {
    dismissWorldlinkTip();
    expect(worldlinkTipDone()).toBe(true);
    authState = signedIn('33333333-3333-3333-3333-333333333333');
    expect(worldlinkTipDone()).toBe(false);
  });

  it('without storage: not done at first, and a dismissal still holds for the session', () => {
    install(fakeStorage({ throws: true }));
    expect(worldlinkTipDone()).toBe(false);
    expect(() => dismissWorldlinkTip()).not.toThrow();
    expect(worldlinkTipDone()).toBe(true);
  });
});

describe('claimTipShown', () => {
  it('fires once per account per session', () => {
    expect(claimTipShown()).toBe(true);
    expect(claimTipShown()).toBe(false);
    authState = signedIn('44444444-4444-4444-4444-444444444444');
    expect(claimTipShown()).toBe(true);
  });
});
