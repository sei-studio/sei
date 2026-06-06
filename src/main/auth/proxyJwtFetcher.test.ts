/**
 * Tests for proxyJwtFetcher — getProxyJwt + setupJwtRotation.
 *
 * Plan 13-14 (PROXY-08): every cloud-proxy bot call carries a fresh Bearer
 * JWT. Supabase JWTs expire in ~1h; the bot process can run for many hours,
 * so we must refresh before expiry AND push the new token to the running
 * bot via the existing utilityProcess MessagePortMain channel.
 *
 * Covers eight cases (plan §Task 1 <behavior>):
 *   1. no session (getSession returns null) → throws PROXY_NO_SESSION.
 *   2. session expires_at in the past → refreshSession called.
 *   3. session expires_at within 5 minutes → refreshSession called.
 *   4. session expires_at well in future (1h away) → no refresh; returns
 *      current access_token.
 *   5. refreshSession rejects (returns error) → throws PROXY_REFRESH_FAILED.
 *   6. refreshSession returns session=null → throws PROXY_REFRESH_FAILED.
 *   7. setupJwtRotation polls every 30 minutes (fake timers); each tick
 *      calls postMessage({kind:'cloud-jwt-update', jwt}).
 *   8. setupJwtRotation returns a teardown function that clearInterval-s.
 *
 * Threat model anchors:
 *   - T-13-14-01 (info disclosure): JWT never reaches console.warn output.
 *   - T-13-14-02 (DoS): 5s AbortController timeout on refreshSession.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stable mock surface — each test installs behavior via the fns below.
const getSessionMock = vi.fn();
const refreshSessionMock = vi.fn();

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      getSession: getSessionMock,
      refreshSession: refreshSessionMock,
    },
  }),
}));

// Imported AFTER mocks so the module under test uses the stubs.
import { getProxyJwt, setupJwtRotation, ProxyAuthError } from './proxyJwtFetcher';

const NOW_S = 1_780_000_000; // arbitrary fixed UNIX seconds for deterministic math
const NOW_MS = NOW_S * 1000;

beforeEach(() => {
  getSessionMock.mockReset();
  refreshSessionMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getProxyJwt', () => {
  it('throws PROXY_NO_SESSION when getSession returns null session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    await expect(getProxyJwt()).rejects.toBeInstanceOf(ProxyAuthError);
    await expect(getProxyJwt()).rejects.toMatchObject({ code: 'PROXY_NO_SESSION' });
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it('refreshes when expires_at is in the past', async () => {
    // expires_at = 60s ago — well past
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'stale', expires_at: NOW_S - 60 } },
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: { access_token: 'fresh', expires_at: NOW_S + 3600 } },
      error: null,
    });
    const token = await getProxyJwt();
    expect(token).toBe('fresh');
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes when expires_at is within 5 minutes', async () => {
    // expires_at = 4 min away — inside the 5-min refresh threshold
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'almost-stale', expires_at: NOW_S + 4 * 60 } },
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: { access_token: 'fresh', expires_at: NOW_S + 3600 } },
      error: null,
    });
    const token = await getProxyJwt();
    expect(token).toBe('fresh');
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
  });

  it('returns current access_token when expires_at is well in future (1h away)', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'still-fresh', expires_at: NOW_S + 3600 } },
    });
    const token = await getProxyJwt();
    expect(token).toBe('still-fresh');
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it('throws PROXY_REFRESH_FAILED when refreshSession returns an error', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'stale', expires_at: NOW_S - 60 } },
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'network down' },
    });
    await expect(getProxyJwt()).rejects.toBeInstanceOf(ProxyAuthError);
    await expect(getProxyJwt()).rejects.toMatchObject({ code: 'PROXY_REFRESH_FAILED' });
  });

  it('throws PROXY_REFRESH_FAILED when refreshSession returns session=null with no error', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'stale', expires_at: NOW_S - 60 } },
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    await expect(getProxyJwt()).rejects.toMatchObject({ code: 'PROXY_REFRESH_FAILED' });
  });
});

describe('setupJwtRotation', () => {
  it('polls every 30 minutes and posts cloud-jwt-update messages with the fresh jwt', async () => {
    // Session expires_at is computed dynamically per call from Date.now() so
    // fake-timer advances don't age the mock session past the 5-min refresh
    // threshold mid-test (we want the pure passthrough path here; the
    // refresh path is covered by the getProxyJwt suite above). Every tick
    // returns a fresh 1h-in-the-future session.
    getSessionMock.mockImplementation(async () => ({
      data: {
        session: {
          access_token: 'token-A',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }));
    const postMessage = vi.fn();
    const teardown = setupJwtRotation({ postMessage });

    // Seed tick fires immediately (microtask) — drain microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({ kind: 'cloud-jwt-update', jwt: 'token-A' });

    // Advance one 30-min interval — one more tick. Step a single interval
    // at a time so the async tick's microtasks drain between fires (fake
    // setInterval queues callbacks synchronously inside one advance call,
    // but our tick() is async; stepping interval-by-interval keeps the
    // call count deterministic).
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(postMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(postMessage).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(postMessage).toHaveBeenCalledTimes(4);

    teardown();
  });

  it('returns a teardown function that stops further ticks', async () => {
    getSessionMock.mockImplementation(async () => ({
      data: {
        session: {
          access_token: 'token-A',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }));
    const postMessage = vi.fn();
    const teardown = setupJwtRotation({ postMessage });

    // Drain seed tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledTimes(1);

    // Stop the interval.
    teardown();

    // Advance well past several intervals — no further ticks should land.
    await vi.advanceTimersByTimeAsync(5 * 30 * 60 * 1000);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
