/**
 * Tests for regenHintPref (261107): the one-time "Not happy with the look?
 * Regenerate" hint on a companion's profile.
 *
 * Invariants under test:
 *   1. Once per player, EVER: after the hint is marked seen, no profile (any
 *      companion) shows it again on that account.
 *   2. The flag is per account (scope in the key); a second account on the
 *      same machine still gets it once.
 *   3. Eligibility = where Regenerate would work: owned (not a bundled
 *      default, not someone else's World companion), signed in, real portrait
 *      art, at least one regeneration left (unknown counts as no).
 *   4. An ineligible or busy profile does NOT use the hint up.
 *   5. Storage that throws degrades to "not seen", never a crash.
 *   6. Analytics carry shape only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthState } from '@shared/ipc';

let authState: AuthState = { kind: 'local' };
vi.mock('./stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ state: authState }) },
}));
const track = vi.fn();
vi.mock('./ipcClient', () => ({ sei: { track: (...a: unknown[]) => track(...a) } }));

const {
  regenHintSeen,
  markRegenHintSeen,
  regenHintKey,
  isRegenHintEligible,
  shouldShowRegenHint,
  trackRegenHintShown,
  trackRegenHintDismissed,
  trackRegenHintRegenerateClicked,
} = await import('./regenHintPref');

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const signedIn = (id: string): AuthState => ({
  kind: 'signed_in',
  user: { id, email: 'a@b.com', emailVerified: true, createdAt: '2026-01-01T00:00:00Z' },
});

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
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}

beforeEach(() => {
  install(fakeStorage());
  authState = signedIn(ME);
  track.mockReset();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
});

const mine = { is_default: false, owner: ME };
const eligibleBase = { character: mine, currentUserId: ME, hasPortrait: true, regensLeft: 3 };

describe('isRegenHintEligible', () => {
  it('is eligible for an owned companion with art and regenerations left', () => {
    expect(isRegenHintEligible(eligibleBase)).toBe(true);
  });

  it('counts a legacy owner-null companion as owned', () => {
    expect(isRegenHintEligible({ ...eligibleBase, character: { is_default: false, owner: null } })).toBe(true);
  });

  it('is never eligible for a bundled default (Sui, Lyra, ...)', () => {
    expect(isRegenHintEligible({ ...eligibleBase, character: { is_default: true, owner: null } })).toBe(false);
  });

  it("is never eligible for someone else's World companion", () => {
    expect(isRegenHintEligible({ ...eligibleBase, character: { is_default: false, owner: OTHER } })).toBe(false);
  });

  it('needs a signed-in account (regeneration rides the proxy)', () => {
    expect(
      isRegenHintEligible({ ...eligibleBase, character: { is_default: false, owner: null }, currentUserId: null }),
    ).toBe(false);
  });

  it('never for a card image the player uploaded (product call 261110)', () => {
    expect(isRegenHintEligible({ ...eligibleBase, customImage: true })).toBe(false);
    expect(isRegenHintEligible({ ...eligibleBase, customImage: false })).toBe(true);
  });

  it('needs real portrait art', () => {
    expect(isRegenHintEligible({ ...eligibleBase, hasPortrait: false })).toBe(false);
  });

  it('needs a regeneration left, and an unknown count is a no', () => {
    expect(isRegenHintEligible({ ...eligibleBase, regensLeft: 0 })).toBe(false);
    expect(isRegenHintEligible({ ...eligibleBase, regensLeft: null })).toBe(false);
    expect(isRegenHintEligible({ ...eligibleBase, regensLeft: 1 })).toBe(true);
  });
});

const calm = {
  seen: false,
  eligible: true,
  tutorialActive: false,
  firstMomentLive: false,
  overlayOpen: false,
  leaving: false,
} as const;

describe('shouldShowRegenHint', () => {
  it('shows on a calm, eligible profile the first time', () => {
    expect(shouldShowRegenHint({ ...calm })).toBe(true);
  });

  it('never shows once seen', () => {
    expect(shouldShowRegenHint({ ...calm, seen: true })).toBe(false);
  });

  it('does not show on an ineligible profile', () => {
    expect(shouldShowRegenHint({ ...calm, eligible: false })).toBe(false);
  });

  it('waits out the guided tour, the first moment, any popup and the exit animation', () => {
    // The onboarding tour's first step IS a companion's profile.
    expect(shouldShowRegenHint({ ...calm, tutorialActive: true })).toBe(false);
    expect(shouldShowRegenHint({ ...calm, firstMomentLive: true })).toBe(false);
    expect(shouldShowRegenHint({ ...calm, overlayOpen: true })).toBe(false);
    expect(shouldShowRegenHint({ ...calm, leaving: true })).toBe(false);
  });
});

describe('once per player, ever', () => {
  it('is unseen until marked, then seen for every companion on that account', () => {
    expect(regenHintSeen()).toBe(false);
    markRegenHintSeen();
    expect(localStorage.getItem(`sei.regenHintSeen.v1.${ME}`)).toBe('1');
    expect(regenHintSeen()).toBe(true);
    // A different companion's profile reads the same flag: no second showing.
    expect(shouldShowRegenHint({ ...calm, seen: regenHintSeen() })).toBe(false);
  });

  it('an ineligible or busy profile does not use it up', () => {
    // The flow only marks seen when the predicate passed, so a default's
    // profile, or one opened during the tour, leaves the flag untouched.
    expect(shouldShowRegenHint({ ...calm, eligible: false })).toBe(false);
    expect(shouldShowRegenHint({ ...calm, tutorialActive: true })).toBe(false);
    expect(regenHintSeen()).toBe(false);
  });

  it('is per account: a second account on the same machine still gets it once', () => {
    markRegenHintSeen();
    authState = signedIn(OTHER);
    expect(regenHintKey()).toBe(`sei.regenHintSeen.v1.${OTHER}`);
    expect(regenHintSeen()).toBe(false);
    authState = signedIn(ME);
    expect(regenHintSeen()).toBe(true);
  });

  it('degrades to "not seen" when storage throws', () => {
    install(fakeStorage({ throws: true }));
    expect(() => markRegenHintSeen()).not.toThrow();
    expect(regenHintSeen()).toBe(false);
  });
});

describe('analytics', () => {
  it('sends the three events with shape-only props', () => {
    trackRegenHintShown('unique', 3);
    trackRegenHintRegenerateClicked('custom', 2);
    trackRegenHintDismissed('regenerate', 1234.6);
    trackRegenHintDismissed('outside', -5);
    expect(track.mock.calls).toEqual([
      ['regen_hint_shown', { character_kind: 'unique', regens_left: 3 }],
      ['regen_hint_regenerate_clicked', { character_kind: 'custom', regens_left: 2 }],
      ['regen_hint_dismissed', { how: 'regenerate', visible_ms: 1235 }],
      ['regen_hint_dismissed', { how: 'outside', visible_ms: 0 }],
    ]);
  });

  it('never throws when the bridge does', () => {
    track.mockImplementation(() => {
      throw new Error('no bridge');
    });
    expect(() => trackRegenHintDismissed('close', 10)).not.toThrow();
  });
});
