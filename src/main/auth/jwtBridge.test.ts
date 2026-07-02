/**
 * Tests for plan 10-06 — jwtBridge: pushes Supabase access_token to bot
 * supervisor on every relevant auth event; null on SIGNED_OUT.
 *
 * The bridge subscribes to onAuthStateChange and forwards session.access_token
 * via supervisor.updateJwt(). Refresh tokens never cross this seam (T-10-06-01).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onAuthStateChangeMock = vi.fn();
const getSessionMock = vi.fn();
const startAutoRefreshMock = vi.fn(() => Promise.resolve());
const stopAutoRefreshMock = vi.fn(() => Promise.resolve());

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      getSession: (...args: unknown[]) => getSessionMock(...args),
      startAutoRefresh: () => startAutoRefreshMock(),
      stopAutoRefresh: () => stopAutoRefreshMock(),
    },
  }),
}));

import { initJwtBridge, _disposeForTests } from './jwtBridge';
import type { BotSupervisor } from '../botSupervisor';

function makeSupervisorStub(): BotSupervisor & { updateJwt: ReturnType<typeof vi.fn> } {
  return {
    summon: vi.fn(),
    stop: vi.fn(),
    getActiveId: vi.fn(() => null),
    shutdown: vi.fn(),
    updateJwt: vi.fn(),
  } as unknown as BotSupervisor & { updateJwt: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  onAuthStateChangeMock.mockReset();
  getSessionMock.mockReset();
  startAutoRefreshMock.mockClear();
  stopAutoRefreshMock.mockClear();
  _disposeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jwtBridge', () => {
  it('pushes the initial access_token to supervisor on init', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt-initial' } } });
    onAuthStateChangeMock.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup);
    expect(sup.updateJwt).toHaveBeenCalledWith('jwt-initial');
  });

  it('pushes new JWT on TOKEN_REFRESHED (Pitfall A4)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    let cb: ((event: string, session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((fn) => {
      cb = fn as typeof cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup);
    cb?.('TOKEN_REFRESHED', { access_token: 'jwt-refreshed' });
    expect(sup.updateJwt).toHaveBeenLastCalledWith('jwt-refreshed');
  });

  it('arms the auto-refresh ticker on init (260617 expired_jwt fix)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt-initial' } } });
    onAuthStateChangeMock.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    await initJwtBridge(makeSupervisorStub());
    expect(startAutoRefreshMock).toHaveBeenCalled();
  });

  it('stops the ticker on SIGNED_OUT and re-arms on SIGNED_IN', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    let cb: ((event: string, session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((fn) => {
      cb = fn as typeof cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    await initJwtBridge(makeSupervisorStub());
    startAutoRefreshMock.mockClear();
    cb?.('SIGNED_OUT', null);
    expect(stopAutoRefreshMock).toHaveBeenCalled();
    cb?.('SIGNED_IN', { access_token: 'jwt-new' });
    expect(startAutoRefreshMock).toHaveBeenCalled();
  });

  it('pushes null on SIGNED_OUT', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    let cb: ((event: string, session: { access_token: string } | null) => void) | undefined;
    onAuthStateChangeMock.mockImplementation((fn) => {
      cb = fn as typeof cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    const sup = makeSupervisorStub();
    await initJwtBridge(sup);
    cb?.('SIGNED_OUT', null);
    expect(sup.updateJwt).toHaveBeenLastCalledWith(null);
  });
});
