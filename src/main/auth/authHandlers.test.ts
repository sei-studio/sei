/**
 * Tests for plan 10-04 — signInWithPassword + signUpWithPassword handler bodies.
 *
 * Stubs getClient() from ./supabaseClient so the handlers don't try to reach
 * a real Supabase project. Asserts the {ok:true} happy path and each of the
 * error-code mappings against UI-SPEC error-copy strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked auth methods — replaced per-test via mockResolvedValue / mockRejectedValue.
const signInWithPasswordMock = vi.fn();
const signUpMock = vi.fn();
// 260605 — account_identity_providers lookup. Default resolves data:null so the
// handler fails open to the generic (provider-less) already-registered message;
// per-test overrides report a provider list (e.g. ['google']).
const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null });

vi.mock('./supabaseClient', () => ({
  getClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPasswordMock(...args),
      signUp: (...args: unknown[]) => signUpMock(...args),
    },
    rpc: (...args: unknown[]) => rpcMock(...args),
  }),
}));

// 260603 anti-abuse — make the signup pre-checks deterministic. By default the
// cooldown ALLOWS (so the pre-existing happy-path tests are unaffected) and the
// captcha seam is inert. Per-test overrides exercise the cooldown-block branch.
const checkSignupCooldownMock = vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
const recordSignupAttemptMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./signupCooldown', () => ({
  checkSignupCooldown: () => checkSignupCooldownMock(),
  recordSignupAttempt: () => recordSignupAttemptMock(),
}));
vi.mock('./captcha', () => ({
  consumeCaptchaToken: () => undefined,
}));
// Mock env so callSignupGuard resolves a URL (then we stub global.fetch).
vi.mock('../env', () => ({
  getSupabaseUrl: () => 'https://test.supabase.co',
  getSupabaseAnonKey: () => 'anon-key',
}));

// Imported AFTER the mock so the handlers resolve the stub.
import { signInWithPassword, signUpWithPassword } from './authHandlers';

beforeEach(() => {
  signInWithPasswordMock.mockReset();
  signUpMock.mockReset();
  rpcMock.mockReset().mockResolvedValue({ data: null, error: null });
  checkSignupCooldownMock.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  recordSignupAttemptMock.mockReset().mockResolvedValue(undefined);
  // Default: signup-guard fetch returns 200 (allowed). Tests override per-case.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signInWithPassword', () => {
  it('returns {ok:true} on Supabase success', async () => {
    signInWithPasswordMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } }, error: null });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: true });
  });

  it('maps "Invalid login credentials" to invalid_credentials', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid login credentials', status: 400 },
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'wrong' });
    expect(r).toEqual({
      ok: false,
      code: 'invalid_credentials',
      message: "Email or password doesn't match. Try again.",
    });
  });

  it('maps HTTP 429 to rate_limited', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'too many requests', status: 429 },
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('rate_limited');
      expect(r.message).toBe('Hold on a moment, too many attempts.');
    }
  });

  it('maps a thrown network error to network', async () => {
    signInWithPasswordMock.mockRejectedValue(new Error('fetch failed'));
    const r = await signInWithPassword({ email: 'a@b.com', password: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('network');
      expect(r.message).toMatch(/Couldn't reach Sei's sign-in server/);
    }
  });

  it('260519 UAT fix #3: treats "Email not confirmed" as {ok:true} (D-04 — verification does not block sign-in)', async () => {
    // Supabase returns this error when email-confirm is enabled and the user
    // signs in before clicking the verification link. Per D-04 the user
    // proceeds; the verify-email Banner (plan 06) handles the prompt.
    signInWithPasswordMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'Email not confirmed', status: 400 },
    });
    const r = await signInWithPassword({ email: 'a@b.com', password: 'goodpassword' });
    expect(r).toEqual({ ok: true });
  });
});

describe('signUpWithPassword', () => {
  it('returns {ok:true, requiresVerification:true} when Supabase returns session=null (email-confirm enabled)', async () => {
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({ ok: true, requiresVerification: true });
  });

  it('returns {ok:true, requiresVerification:false} when session is populated (email-confirm disabled)', async () => {
    signUpMock.mockResolvedValue({
      data: { session: { access_token: 'jwt', user: { id: 'u1' } }, user: { id: 'u1' } },
      error: null,
    });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({ ok: true, requiresVerification: false });
  });

  it('260605 no-silent-failure: surfaces "User already registered" honestly (case b)', async () => {
    // The explicit Supabase "already registered" error is no longer masked as a
    // neutral success — we tell the user the account exists so signup can't
    // silently send nothing. The provider lookup (getClient().rpc) is absent in
    // this mock → fails open to the generic (provider-less) message.
    signUpMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'User already registered' },
    });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({
      ok: false,
      code: 'already_registered',
      message: 'An account with this email already exists. Sign in instead.',
    });
  });

  it('260605 no-silent-failure: surfaces already-registered obfuscation (empty identities) honestly (case a)', async () => {
    // Supabase's enumeration-resistance: signUp on an already-registered email
    // with email-confirm enabled returns success with user.identities = [].
    signUpMock.mockResolvedValue({
      data: { session: null, user: { id: 'u1', identities: [] } },
      error: null,
    });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({
      ok: false,
      code: 'already_registered',
      message: 'An account with this email already exists. Sign in instead.',
    });
  });

  it('260605: names the provider when the existing account is OAuth-only (Google)', async () => {
    // With a working provider lookup that reports a Google-only account, the
    // message steers the user to Continue with Google.
    signUpMock.mockResolvedValue({
      data: { session: null, user: { id: 'u1', identities: [] } },
      error: null,
    });
    rpcMock.mockResolvedValue({ data: ['google'], error: null });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({
      ok: false,
      code: 'already_registered',
      provider: 'Google',
      message: 'You already have a Sei account with this email via Google. Use “Continue with Google” to sign in.',
    });
  });

  it('maps "Password should be at least 8 characters" to weak_password', async () => {
    signUpMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'Password should be at least 8 characters' },
    });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'abc', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({
      ok: false,
      code: 'weak_password',
      message: 'Pick a password with at least 8 characters.',
    });
  });

  it('maps "Invalid email format" to invalid_email', async () => {
    signUpMock.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid email format' },
    });
    const r = await signUpWithPassword({ email: 'not-an-email', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({
      ok: false,
      code: 'invalid_email',
      message: "That doesn't look like an email address.",
    });
  });

  it('F-10 (quick/260525-usc): rejects under-13 DOB BEFORE calling Supabase', async () => {
    // COPPA age gate: if the self-attested DOB implies the user is < 13,
    // return { ok: false, code: 'under_13' } BEFORE any supabase.auth.signUp
    // call. The DOB is never logged or persisted; this is the only place we
    // touch it.
    const today = new Date();
    // 12 years and 6 months ago — comfortably under 13.
    const dobYear = today.getFullYear() - 12;
    const dobMonth = today.getMonth() + 1;
    const dobDay = today.getDate();
    const r = await signUpWithPassword({
      email: 'a@b.com',
      password: 'longenough',
      dobYear,
      dobMonth,
      dobDay,
    });
    expect(r).toEqual({
      ok: false,
      code: 'under_13',
      message: 'Sorry, Sei accounts require you to be at least 13 years old. (COPPA compliance.)',
    });
    // Critical: Supabase MUST NOT be called when the DOB gate rejects.
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('F-10: allows exactly-13 DOB (boundary)', async () => {
    // The user is exactly 13 today — must pass the gate.
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
    const today = new Date();
    const dobYear = today.getFullYear() - 13;
    const dobMonth = today.getMonth() + 1;
    const dobDay = today.getDate();
    const r = await signUpWithPassword({
      email: 'a@b.com',
      password: 'longenough',
      dobYear,
      dobMonth,
      dobDay,
    });
    expect(r).toEqual({ ok: true, requiresVerification: true });
    expect(signUpMock).toHaveBeenCalledOnce();
  });

  it('WR-03 (T-10-04): collapses thrown errors into neutral success to prevent enumeration side-channel', async () => {
    // After WR-03 we deliberately collapse any unclassified signup error
    // (including thrown network errors) into { ok: true, requiresVerification: true }
    // so an attacker cannot distinguish a registered email (which might surface
    // as a 500 / "duplicate key" → network) from a fresh signup (neutral success).
    // Trade-off: a real offline retry now looks like "check your email" — accepted
    // because T-10-04 is a security gate, not a UX preference.
    signUpMock.mockRejectedValue(new Error('fetch failed'));
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({ ok: true, requiresVerification: true });
  });

  // ── 260603 anti-abuse: signup cooldown + per-IP guard ───────────────────
  it('returns cooldown (no Supabase call) when the device cooldown is active', async () => {
    checkSignupCooldownMock.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('cooldown');
      expect((r as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
    }
    // Cooling down → no Supabase signup, and the attempt is NOT recorded
    // (recordSignupAttempt runs only on the allowed path).
    expect(signUpMock).not.toHaveBeenCalled();
    expect(recordSignupAttemptMock).not.toHaveBeenCalled();
  });

  it('records the attempt before the Supabase call on the allowed path', async () => {
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
    await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(recordSignupAttemptMock).toHaveBeenCalledOnce();
    expect(signUpMock).toHaveBeenCalledOnce();
  });

  it('returns cooldown when signup-guard responds 429 (per-IP), no Supabase call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'rate_limited', retry_after_seconds: 900 }), {
        status: 429,
        headers: { 'Retry-After': '900' },
      }),
    );
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('cooldown');
      expect((r as { retryAfterMs: number }).retryAfterMs).toBe(900_000);
    }
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('fails OPEN to signup when signup-guard is unreachable (network error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    signUpMock.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
    const r = await signUpWithPassword({ email: 'a@b.com', password: 'longenough', dobYear: 1990, dobMonth: 6, dobDay: 15 });
    expect(r).toEqual({ ok: true, requiresVerification: true });
    expect(signUpMock).toHaveBeenCalledOnce();
  });
});
