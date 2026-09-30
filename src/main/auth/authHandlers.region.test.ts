/**
 * W7 region gate (260816) — handler gate tests.
 *
 * Mocks '../regionDetect' to steer the verdict and asserts:
 *   - blocked  -> signIn/signUp/Google return the region_blocked error shape
 *                 BEFORE any Supabase / OAuth / pre-check work runs;
 *   - unknown  -> the flows proceed exactly as before (fail open);
 *   - a throwing detector also fails open.
 *
 * The Supabase/pre-check mocks mirror authHandlers.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithPasswordMock = vi.fn();
const signUpMock = vi.fn();
const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });
const resetPasswordForEmailMock = vi.fn().mockResolvedValue({ data: {}, error: null });
const resendMock = vi.fn().mockResolvedValue({ data: {}, error: null });

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPasswordMock(...args),
      signUp: (...args: unknown[]) => signUpMock(...args),
      resetPasswordForEmail: (...args: unknown[]) => resetPasswordForEmailMock(...args),
      resend: (...args: unknown[]) => resendMock(...args),
    },
    rpc: (...args: unknown[]) => rpcMock(...args),
  }),
}));

// The region verdict under test.
const getRegionStatusMock = vi.fn();
vi.mock('../regionDetect', () => ({
  getRegionStatus: () => getRegionStatusMock(),
}));

// Signup pre-checks: allow by default, and OBSERVABLE so we can assert the
// blocked path never reaches them.
const checkSignupCooldownMock = vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
const recordSignupAttemptMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./signupCooldown', () => ({
  checkSignupCooldown: () => checkSignupCooldownMock(),
  recordSignupAttempt: () => recordSignupAttemptMock(),
}));
vi.mock('./captcha', () => ({
  consumeCaptchaToken: () => undefined,
}));
vi.mock('../env', () => ({
  getSupabaseUrl: () => 'https://test.supabase.co',
  getSupabaseAnonKey: () => 'anon-key',
}));

// Google OAuth: observable so the blocked path can assert no browser dance.
const startGoogleOAuthMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock('./loopbackPkce', () => ({
  startGoogleOAuth: (...args: unknown[]) => startGoogleOAuthMock(...args),
}));

import { signInWithPassword, signUpWithPassword, signInWithGoogle } from './authHandlers';
import { REGION_BLOCKED_COPY } from '../../shared/regionGate';

const SIGNUP_ARGS = {
  email: 'a@b.com',
  password: 'longenough',
  dobYear: 1990,
  dobMonth: 6,
  dobDay: 15,
};

beforeEach(() => {
  signInWithPasswordMock.mockReset();
  signUpMock.mockReset();
  startGoogleOAuthMock.mockReset().mockResolvedValue({ ok: true });
  checkSignupCooldownMock.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  recordSignupAttemptMock.mockReset().mockResolvedValue(undefined);
  getRegionStatusMock.mockReset();
  // signup-guard fetch: allowed. Only reachable on the unblocked paths.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('region gate: blocked', () => {
  beforeEach(() => {
    getRegionStatusMock.mockResolvedValue({ loc: 'CN', blocked: true });
  });

  it('signInWithPassword returns the region_blocked error shape, no Supabase call', async () => {
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: false, code: 'region_blocked', message: REGION_BLOCKED_COPY });
    expect(signInWithPasswordMock).not.toHaveBeenCalled();
  });

  it('signUpWithPassword returns the region_blocked error shape before every pre-check', async () => {
    const r = await signUpWithPassword(SIGNUP_ARGS);
    expect(r).toEqual({ ok: false, code: 'region_blocked', message: REGION_BLOCKED_COPY });
    expect(signUpMock).not.toHaveBeenCalled();
    // The gate sits ABOVE the cooldown ladder: a blocked user's attempt is
    // not recorded, and the signup-guard is never hit.
    expect(checkSignupCooldownMock).not.toHaveBeenCalled();
    expect(recordSignupAttemptMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('signInWithGoogle returns the region_blocked reason without opening the browser', async () => {
    const r = await signInWithGoogle();
    expect(r).toEqual({ ok: false, reason: 'region_blocked', message: REGION_BLOCKED_COPY });
    expect(startGoogleOAuthMock).not.toHaveBeenCalled();
  });
});

describe('region gate: unknown -> allowed (fail open)', () => {
  beforeEach(() => {
    getRegionStatusMock.mockResolvedValue({ loc: null, blocked: false });
  });

  it('signInWithPassword proceeds to Supabase', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: 'u1' } } },
      error: null,
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: true });
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(1);
  });

  it('signUpWithPassword proceeds through the pre-checks to Supabase', async () => {
    signUpMock.mockResolvedValue({
      data: { session: {}, user: { id: 'u1', identities: [{}] } },
      error: null,
    });
    const r = await signUpWithPassword(SIGNUP_ARGS);
    expect(r).toEqual({ ok: true, requiresVerification: false });
    expect(signUpMock).toHaveBeenCalledTimes(1);
    expect(recordSignupAttemptMock).toHaveBeenCalledTimes(1);
  });

  it('signInWithGoogle proceeds to the OAuth dance', async () => {
    const r = await signInWithGoogle();
    expect(r).toEqual({ ok: true });
    expect(startGoogleOAuthMock).toHaveBeenCalledTimes(1);
  });
});

describe('region gate: detector failure -> allowed (fail open)', () => {
  it('a throwing getRegionStatus never blocks sign-in', async () => {
    getRegionStatusMock.mockRejectedValue(new Error('detector exploded'));
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: 'u1' } } },
      error: null,
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: true });
    expect(signInWithPasswordMock).toHaveBeenCalledTimes(1);
  });

  it('an allowed (supported-region) verdict passes through untouched', async () => {
    getRegionStatusMock.mockResolvedValue({ loc: 'US', blocked: false });
    signInWithPasswordMock.mockResolvedValue({
      data: { session: { user: { id: 'u1' } } },
      error: null,
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: true });
  });
});
