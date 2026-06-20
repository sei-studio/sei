/**
 * Tests for Plan 11-14 — isCloudWriteAllowed defense-in-depth gate.
 *
 * Stubs `./tosGate` (created by parallel plan 11-12) so the gate can be
 * exercised in isolation. Asserts the four branches (local / unverified /
 * tos-not-accepted / fully-allowed), the fail-closed branch when the tri-state
 * getTosAcceptance throws or returns 'unknown' (260610), the 60s TTL cache
 * behaviour (definitive results only), and the invalidateTosCache hook.
 *
 * The authState module is module-scoped — currentState is a closure variable.
 * We drive transitions via the existing transitionToLocal / transitionToSignedIn
 * exports (they're documented as test-only entry points in authState.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock tosGate (Plan 11-12; 260610 tri-state) --------------------------
const getTosAcceptanceMock = vi.fn();

vi.mock('./tosGate', () => ({
  getTosAcceptance: (...args: unknown[]) => getTosAcceptanceMock(...args),
}));

// ---- Mock supabaseClient (260606 — validateSessionOrSignOut) -------------
const getUserMock = vi.fn();
const signOutMock = vi.fn().mockResolvedValue({ error: null });
vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
      signOut: (...args: unknown[]) => signOutMock(...args),
    },
  }),
}));

// Imported AFTER the mock so isCloudWriteAllowed resolves the stub.
import {
  isCloudWriteAllowed,
  invalidateTosCache,
  transitionToLocal,
  transitionToSignedIn,
  validateSessionOrSignOut,
  getCurrentAuthState,
  _disposeForTests,
} from './authState';
import type { AuthUser } from '../../shared/ipc';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    email: overrides.email ?? 'a@b.com',
    emailVerified: overrides.emailVerified ?? true,
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  getTosAcceptanceMock.mockReset();
  getUserMock.mockReset();
  signOutMock.mockReset().mockResolvedValue({ error: null });
  invalidateTosCache();
  transitionToLocal();
});

afterEach(() => {
  _disposeForTests();
  invalidateTosCache();
  vi.restoreAllMocks();
});

describe('isCloudWriteAllowed', () => {
  it('returns false when kind === local (not_signed_in)', async () => {
    transitionToLocal();
    expect(await isCloudWriteAllowed()).toBe(false);
    expect(getTosAcceptanceMock).not.toHaveBeenCalled();
  });

  it('returns false when signed_in but email NOT verified (email_unverified)', async () => {
    transitionToSignedIn(makeUser({ emailVerified: false }));
    expect(await isCloudWriteAllowed()).toBe(false);
    expect(getTosAcceptanceMock).not.toHaveBeenCalled();
  });

  it('returns false when signed_in + verified but tos NOT accepted', async () => {
    getTosAcceptanceMock.mockResolvedValue('not_accepted');
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(false);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(1);
  });

  it('returns true when signed_in + verified + tos accepted', async () => {
    getTosAcceptanceMock.mockResolvedValue('accepted');
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(true);
  });

  it('fails closed (false) when getTosAcceptance rejects', async () => {
    getTosAcceptanceMock.mockRejectedValue(new Error('CLOUD_TIMEOUT'));
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(false);
  });

  it('caches the tos result for 60s — two consecutive calls hit getTosAcceptance once', async () => {
    getTosAcceptanceMock.mockResolvedValue('accepted');
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateTosCache forces re-query on next call', async () => {
    getTosAcceptanceMock.mockResolvedValue('accepted');
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(true);
    invalidateTosCache();
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(2);
  });

  it('cache busts when TTL expires (vi.useFakeTimers)', async () => {
    vi.useFakeTimers();
    try {
      getTosAcceptanceMock.mockResolvedValue('accepted');
      transitionToSignedIn(makeUser({ emailVerified: true }));
      expect(await isCloudWriteAllowed()).toBe(true);
      // Advance past the 60s TTL.
      vi.advanceTimersByTime(60_001);
      expect(await isCloudWriteAllowed()).toBe(true);
      expect(getTosAcceptanceMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT cache an 'unknown' result — next call re-queries (260610 offline fix)", async () => {
    getTosAcceptanceMock.mockResolvedValue('unknown');
    transitionToSignedIn(makeUser({ emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(false);
    // Connectivity returns — the very next call must re-query instead of
    // serving a stale 60s "false" from the cache.
    getTosAcceptanceMock.mockResolvedValue('accepted');
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(2);
  });

  it('cache is per-user — switching users invalidates the prior cache entry', async () => {
    getTosAcceptanceMock.mockResolvedValue('accepted');
    transitionToSignedIn(makeUser({ id: '11111111-1111-4111-8111-111111111111', emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(1);

    transitionToSignedIn(makeUser({ id: '22222222-2222-4222-8222-222222222222', emailVerified: true }));
    expect(await isCloudWriteAllowed()).toBe(true);
    expect(getTosAcceptanceMock).toHaveBeenCalledTimes(2);
  });
});

describe('validateSessionOrSignOut (260606 — auto sign-out of a dead session)', () => {
  it('signs out when getUser returns a 401 (user deleted/revoked)', async () => {
    transitionToSignedIn(makeUser());
    getUserMock.mockResolvedValue({ data: { user: null }, error: { status: 401, message: 'user_not_found' } });
    await validateSessionOrSignOut();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(getCurrentAuthState()).toEqual({ kind: 'local' });
  });

  it('forces local even if signOut itself fails', async () => {
    transitionToSignedIn(makeUser());
    getUserMock.mockResolvedValue({ data: { user: null }, error: { status: 403 } });
    signOutMock.mockRejectedValue(new Error('network'));
    await validateSessionOrSignOut();
    expect(getCurrentAuthState()).toEqual({ kind: 'local' });
  });

  it('keeps the session on a valid getUser (no error)', async () => {
    const user = makeUser();
    transitionToSignedIn(user);
    getUserMock.mockResolvedValue({ data: { user: { id: user.id } }, error: null });
    await validateSessionOrSignOut();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(getCurrentAuthState().kind).toBe('signed_in');
  });

  it('keeps the session on a network throw (offline-tolerant)', async () => {
    transitionToSignedIn(makeUser());
    getUserMock.mockRejectedValue(new Error('fetch failed'));
    await validateSessionOrSignOut();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(getCurrentAuthState().kind).toBe('signed_in');
  });

  it('keeps the session on an inconclusive non-auth status (e.g. 500)', async () => {
    transitionToSignedIn(makeUser());
    getUserMock.mockResolvedValue({ data: { user: null }, error: { status: 500 } });
    await validateSessionOrSignOut();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(getCurrentAuthState().kind).toBe('signed_in');
  });
});
