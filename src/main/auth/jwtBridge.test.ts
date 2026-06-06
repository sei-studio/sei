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

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      getSession: (...args: unknown[]) => getSessionMock(...args),
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
