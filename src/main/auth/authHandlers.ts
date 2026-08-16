/**
 * IPC handler bodies for the 9 auth:* channels.
 *
 * This file is the per-handler dispatch surface. Each handler function
 * is referenced by name from src/main/ipc.ts. Plan 03 ships SHELLS;
 * plans 04 (email/password — this file now), 05 (Google OAuth), 06 (sign-out
 * + JWT + verify), 08 (delete via Edge Function), 09 (export) fill the bodies.
 *
 * Plan 04 replaces the signInWithPassword + signUpWithPassword shells with
 * real Supabase calls + 15s timeout wrap (CLAUDE.md: every external call has
 * a timeout) + error-class mapping that pairs error codes to the UI-SPEC
 * Empty/Error/Loading copy strings.
 *
 * Sources:
 *   - 10-RESEARCH §Pattern 5 (IPC channel table)
 *   - 10-CONTEXT integration_points (channel list)
 *   - 10-UI-SPEC §Empty/Error/Loading states (sign-in error copy verbatim)
 *   - CLAUDE.md §"Every external call has a timeout"
 */
import { writeFile } from 'node:fs/promises';
import type {
  SignInResult,
  SignUpResult,
  OAuthResult,
  DeleteAccountResult,
  ExportDataResult,
  ResendVerificationResult,
  VerifyEmailCodeResult,
  PasswordResetResult,
  UpdatePasswordResult,
} from '../../shared/ipc';
import { IpcChannel } from '../../shared/ipc';
import { getClient } from './supabaseClient';
import { LOOPBACK_CALLBACK_URL } from './loopbackCallback';
import { markRecoveryRequested } from './recoveryFlag';
import { startGoogleOAuth } from './loopbackPkce';
import { getCurrentAuthState, transitionToLocal } from './authState';
import { callEdgeFunction } from './edgeFunctionClient';
import { buildExport } from './exportBuilder';
import { getSupabaseUrl, getSupabaseAnonKey } from '../env';
import { REGION_BLOCKED, REGION_BLOCKED_COPY } from '../../shared/regionGate';
import type { BotSupervisor } from '../botSupervisor';

// Inline logger (matches main/* convention — each module owns its own logger).
// T-10-06-08: only error.message strings are logged here, never JWT or
// session blobs. Audit gate: grep -E "access_token|refresh_token|session"
// against this file should return 0 user-data references.
const logger = {
  warn: (m: string) => console.warn(`[sei] ${m}`),
};

/**
 * Plan 10-06: handle to the bot supervisor so signOut can stop the bot BEFORE
 * clearing the Supabase session (D-09: the bot's last request must not race a
 * just-revoked JWT). Wired by registerIpcHandlers via setSupervisor() at boot;
 * unset at module init so a test importing authHandlers without wiring won't
 * accidentally call into a real supervisor.
 */
let supervisorRef: BotSupervisor | null = null;

/** Wire the supervisor handle. Called once during registerIpcHandlers. */
export function setSupervisor(s: BotSupervisor): void {
  supervisorRef = s;
}

/**
 * D-09 + T-10-06-09: stop the bot before clearing any auth state so its
 * final request flushes under the still-valid JWT. Used by signOut AND
 * deleteAccount (the latter is logically a superset of sign-out, so the
 * same ordering invariant applies — BL-06).
 *
 * Failure is swallowed with a warn log. A failed bot-stop must NOT block
 * the surrounding auth action; the user has already confirmed via the
 * preceding modal and we cannot strand them in a half-state.
 */
async function stopBotIfActive(label: string): Promise<void> {
  if (supervisorRef && supervisorRef.getActiveId() !== null) {
    try {
      await supervisorRef.stop();
    } catch (err) {
      logger.warn(`${label}: bot stop failed: ${(err as Error).message}`);
    }
  }
}

/**
 * 15s timeout wrap for any external auth call. On timeout, resolves to the
 * caller-supplied fallback value (NOT a rejection) so the handler can map it
 * uniformly through the error-class classifier.
 *
 * CLAUDE.md invariant: every external call has a timeout — pathfinder,
 * Anthropic, Supabase — no exceptions.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // BL-05: when the timer wins the race, `p` keeps executing in the
  // background. If it later rejects (Supabase 500, ECONNRESET) the rejection
  // has no consumer and Node emits unhandledRejection. Attach a silent
  // catch BEFORE the race so a late loser-rejection is swallowed instead of
  // bubbling to the process. The race still observes the original `p`
  // settlement order, because Promise.race only ever subscribes once; the
  // .catch here just registers a second handler.
  p.catch(() => undefined);
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 260605 no-silent-failure — look up which identity providers an email is
 * registered with, via the `account_identity_providers` SECURITY DEFINER RPC
 * (see migration 20260605120000). Returns:
 *   - string[]  the provider labels ([] when no account exists)
 *   - null      the lookup failed (network/timeout/RPC error) → caller FAILS
 *               OPEN to its prior behaviour so a transient DB hiccup never
 *               blocks a legitimate sign-up or password reset.
 *
 * 8s timeout (shorter than the 15s auth-call wrap) so a slow RPC adds only a
 * brief delay before failing open.
 */
async function lookupIdentityProviders(email: string): Promise<string[] | null> {
  try {
    const supabase = getClient();
    // .rpc() returns a thenable query builder, not a Promise — wrap it so the
    // Promise-typed withTimeout accepts it.
    const result = await withTimeout(
      Promise.resolve(supabase.rpc('account_identity_providers', { p_email: email })),
      8_000,
      () =>
        ({ data: null, error: { message: 'timeout' } }) as unknown as Awaited<
          ReturnType<typeof supabase.rpc>
        >,
    );
    const { data, error } = result as { data: unknown; error: AuthErrShape | null };
    if (error || !Array.isArray(data)) return null;
    return data.filter((p): p is string => typeof p === 'string');
  } catch (err) {
    logger.warn(`account_identity_providers lookup failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Human-friendly label for an OAuth provider string. Defaults to a capitalised
 * form so an unanticipated provider (e.g. a future 'github') still reads well.
 */
function providerLabel(provider: string): string {
  if (provider === 'google') return 'Google';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Build the SignUpResult for an email Supabase reports as already registered.
 *
 * 260729: silent forgot-password treatment. The 260605 honest message ("an
 * account with this email already exists") leaked account existence to anyone
 * typing an address into the signup form, so it is gone: we silently send a
 * password-reset email to the address and return the SAME
 * `{ ok: true, requiresVerification: true }` a brand-new signup gets. In-app,
 * registered and unregistered emails are indistinguishable; the legitimate
 * owner still gets in via the code in their inbox (the email copy says to
 * ignore it if unrequested).
 *
 * 260804: this is why verifyEmailCode tries BOTH token types. The user is now
 * shown a code box rather than told to check for a link, and the code sitting
 * in their inbox on this path is a RECOVERY code, not a signup one. If the
 * panel could tell the difference, so could an attacker.
 *
 * OAuth-only accounts (Google, no password identity): sendPasswordReset
 * refuses those by design (a reset link would graft a password identity), so
 * no email goes out. Accepted cost of staying silent — that user can still
 * sign in with "Continue with Google", and an attacker learns nothing.
 */
async function alreadyRegisteredResult(email: string): Promise<SignUpResult> {
  try {
    await sendPasswordReset({ email });
  } catch (err) {
    // Still return neutral success: the send failing must not reopen the
    // enumeration channel, and the user can recover via "forgot password?".
    logger.warn(`signup silent-reset send failed: ${(err as Error).message}`);
  }
  return { ok: true, requiresVerification: true };
}

/**
 * 260603 anti-abuse — call the `signup-guard` Edge Function before signup.
 *
 * Returns `{ rateLimited: true, retryAfterSeconds }` ONLY on an explicit 429
 * from the guard (per-IP signup flood). Every other outcome — 200, any non-429
 * status, network/timeout error, or a missing-Supabase-config throw — FAILS
 * OPEN (`{ rateLimited: false }`) so the guard being unreachable never blocks a
 * legitimate human. The guard needs no JWT (verify_jwt=false); we still send
 * the anon `apikey` because the Supabase functions gateway requires it.
 *
 * 8s timeout (shorter than the 15s Supabase-call wrap) so a slow guard adds at
 * most a brief delay before failing open.
 */
async function callSignupGuard(): Promise<{ rateLimited: boolean; retryAfterSeconds?: number }> {
  let url: string;
  let anon: string;
  try {
    url = `${getSupabaseUrl()}/functions/v1/signup-guard`;
    anon = getSupabaseAnonKey();
  } catch {
    return { rateLimited: false }; // misconfigured env in dev/test → fail open
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anon },
      body: '{}',
      signal: controller.signal,
    });
    if (res.status === 429) {
      const retryHeader = res.headers.get('Retry-After');
      let retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
      if (retryAfterSeconds == null || Number.isNaN(retryAfterSeconds)) {
        try {
          const body = (await res.json()) as { retry_after_seconds?: number };
          if (typeof body?.retry_after_seconds === 'number') {
            retryAfterSeconds = body.retry_after_seconds;
          }
        } catch {
          // ignore — fall back to default below
        }
      }
      return { rateLimited: true, retryAfterSeconds: retryAfterSeconds ?? 60 };
    }
    // 200 (allowed) or any non-429 status → fail open.
    return { rateLimited: false };
  } catch (err) {
    // Network / timeout / abort → fail open. Never block a real human on the
    // guard being unreachable.
    logger.warn(`signup-guard unreachable, failing open: ${(err as Error).message}`);
    return { rateLimited: false };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Map a Supabase signInWithPassword error to a SignInResult union variant.
 * Copy strings come from UI-SPEC §Empty/Error/Loading states verbatim.
 *
 * 260519 UAT fix #3 — `email_not_confirmed` short-circuit:
 *   When the project has email-confirmation enabled and the user signs in
 *   before clicking the verification link, Supabase returns
 *   `{ message: "Email not confirmed", status: 400 }`. Per D-04, email
 *   verification does NOT block sign-in — the verify-email Banner (plan 06)
 *   handles the persistent prompt. So we treat this case as
 *   `{ ok: true }` and let the auth-state subscriber drive the transition.
 *   This branch MUST run before the generic 400 → invalid_credentials catch
 *   below, otherwise the user sees a misleading "Email or password doesn't
 *   match" message.
 */
function classifySignInError(message: string, status?: number): SignInResult {
  const m = message.toLowerCase();
  if (isEmailNotConfirmed(message)) {
    // D-04 path: not an error — the account exists and the password matched.
    // 260804: signInWithPassword intercepts this case BEFORE reaching the
    // classifier so it can also mint a fresh code; this branch survives as a
    // backstop for any other caller and returns the same shape.
    return { ok: true, needsVerification: true };
  }
  if (status === 429 || m.includes('rate limit')) {
    return { ok: false, code: 'rate_limited', message: 'Hold on a moment, too many attempts.' };
  }
  // Malformed email — distinct from a wrong-credentials 400 so the user knows
  // to fix the address, not the password. MUST precede the generic 400 catch.
  if (m.includes('unable to validate email') || m.includes('invalid format') ||
      (m.includes('email') && (m.includes('invalid') || m.includes('valid')))) {
    return { ok: false, code: 'invalid_email', message: "That doesn't look like a valid email address." };
  }
  if (m.includes('invalid login') || m.includes('invalid credentials') || status === 400) {
    return { ok: false, code: 'invalid_credentials', message: "Email or password doesn't match. Try again." };
  }
  // Empty/missing fields that slipped past the disabled-submit guard.
  if (m.includes('missing email') || m.includes('email is required') || m.includes('password')) {
    return { ok: false, code: 'invalid_credentials', message: 'Enter both your email and password.' };
  }
  return {
    ok: false,
    code: 'network',
    message: "Couldn't reach Sei's sign-in server. Check your connection and try again.",
  };
}

/**
 * Map a Supabase signUp error to a SignUpResult union variant.
 * Copy strings come from UI-SPEC §Empty/Error/Loading states verbatim.
 *
 * SECURITY (260519 UAT fix #4): the "email already registered" branch is
 * intentionally omitted here. Supabase's default signup behaviour with email
 * confirmation enabled obfuscates already-registered emails by returning a
 * success shape with `user.identities = []` and no session — but some project
 * settings (or older Supabase versions) still surface an explicit
 * "User already registered" error. Either way, we MUST NOT echo that signal
 * to the renderer because it leaks account-enumeration. Callers in
 * signUpWithPassword detect both shapes and return the same neutral
 * `{ ok: true, requiresVerification: true }` they would for a brand-new
 * account — the user can't tell from the UX whether the address was new
 * or already registered.
 */
function classifySignUpError(message: string): SignUpResult {
  const m = message.toLowerCase();
  if (
    m.includes('password') &&
    (m.includes('character') || m.includes('length') || m.includes('weak') || m.includes('short'))
  ) {
    return { ok: false, code: 'weak_password', message: 'Pick a password with at least 8 characters.' };
  }
  if (m.includes('email') && (m.includes('invalid') || m.includes('valid') || m.includes('format'))) {
    return { ok: false, code: 'invalid_email', message: "That doesn't look like an email address." };
  }
  // WR-03: collapse anything else (including genuine network failures) into
  // neutral success so a Supabase wire-format change can't reopen the
  // enumeration channel via a side-channel like "duplicate key value
  // violates unique constraint" → network code (registered) vs. neutral
  // success (new). Trade-off: a real network failure during signup is now
  // indistinguishable from "check your email," which is UX-misleading on
  // offline retry. Accepted because (a) the SignInModal's verify-email
  // flow surfaces the actual outcome on the next sign-in attempt, and
  // (b) T-10-04 is a security gate, not a UX preference.
  return { ok: true, requiresVerification: true };
}

/**
 * W7 region gate (260816) — true when cloud auth must be refused because the
 * detected IP region is unsupported by Anthropic or Polar (see
 * src/shared/regionGate.ts for the blocklist and its sources).
 *
 * Checked at the TOP of signInWithPassword / signUpWithPassword /
 * signInWithGoogle, before any Supabase call and before the signup
 * pre-checks (COPPA, cooldown, signup-guard). Deliberately NOT checked
 * anywhere else: session restore, sign-out, ToS, verification/reset flows
 * and everything for already-signed-in users stay ungated.
 *
 * FAILS OPEN twice over: regionDetect resolves 'unknown' (= allowed) on any
 * detection failure, and this wrapper additionally swallows an import or
 * unexpected throw as 'allowed'. The renderer's `region:status` pre-check
 * usually shows the popup before a submit ever reaches here; this is the
 * authoritative backstop.
 */
async function isCloudAuthRegionBlocked(): Promise<boolean> {
  try {
    // Lazy import matches the ipc.ts convention (cycle-safe at module init)
    // and keeps tests free to vi.mock '../regionDetect'.
    const { getRegionStatus } = await import('../regionDetect');
    return (await getRegionStatus()).blocked;
  } catch (err) {
    logger.warn(`region gate check failed, failing open: ${(err as Error).message}`);
    return false;
  }
}

// Internal shape we receive from Supabase auth methods we care about. Kept
// loose-typed so the timeout-fallback object validates without importing
// Supabase's full AuthResponse type into the union.
interface AuthErrShape {
  message: string;
  status?: number;
}

/** True for the Supabase "you have not confirmed your address yet" refusal. */
function isEmailNotConfirmed(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('email not confirmed') || m.includes('email_not_confirmed');
}

/** Email/password sign-in. Plan 04. */
export async function signInWithPassword(args: { email: string; password: string }): Promise<SignInResult> {
  // W7 region gate (260816) — refuse before any Supabase call. Fails open.
  if (await isCloudAuthRegionBlocked()) {
    return { ok: false, code: REGION_BLOCKED, message: REGION_BLOCKED_COPY };
  }
  const supabase = getClient();
  try {
    const result = await withTimeout(
      supabase.auth.signInWithPassword({ email: args.email, password: args.password }),
      15_000,
      // Timeout fallback shape is intentionally narrower than Supabase's
      // AuthResponse — we only read .error.{message,status} on the unhappy
      // path. Cast via `unknown` so TS doesn't demand AuthError shape.
      () =>
        ({
          data: { session: null, user: null },
          error: { message: 'timeout', status: 0 },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    if (error) {
      // 260804 PIN migration — an unverified account signing in used to be a
      // dead end. classifySignInError correctly refuses to call this an error
      // (D-04), but no session is issued either, so the renderer sat on the
      // form with nothing to wait for except a click on an emailed link. Now
      // there is a code panel to send them to: mint a fresh code (best-effort,
      // a 429 just means the one from signup is still good) and say so.
      if (isEmailNotConfirmed(error.message)) {
        void resendVerification(args.email).catch(() => undefined);
        return { ok: true, needsVerification: true };
      }
      return classifySignInError(error.message, error.status);
    }
    return { ok: true };
  } catch (err) {
    return classifySignInError((err as Error).message);
  }
}

/**
 * NOTE: LOOPBACK_CALLBACK_URL is imported from loopbackCallback.ts (top of
 * file). Single source of truth — WR-04 changed `localhost` to `127.0.0.1`
 * to avoid IPv4/IPv6 dual-stack ECONNREFUSED on Linux + some macOS configs.
 *
 * IMPORTANT: this URL must ALSO be registered as a valid Site URL (or
 * Additional Redirect URL) in the Supabase project's Auth settings,
 * otherwise the email link will redirect to localhost:3000 (Supabase's
 * default Site URL) and the code will be consumed by no one. See
 * deferred-items.md.
 */

/**
 * Email/password sign-up. Plan 04.
 *
 * 260519 UAT fix #4 — enumeration-resistant return shape:
 *   When the email is already registered, Supabase exposes the signal in TWO
 *   ways depending on project settings:
 *
 *     a. With "Confirm email" enabled (the project default), signUp returns
 *        success with `data.user.identities = []` (length 0) and no session.
 *        No verification email is actually sent. This is Supabase's
 *        enumeration-resistance behaviour and we preserve it.
 *
 *     b. With "Confirm email" disabled, or on older Supabase versions, the
 *        error message can surface as "User already registered" / "already
 *        exists". We intercept that and return the SAME neutral
 *        `{ ok: true, requiresVerification: true }` shape so the UI cannot
 *        distinguish "new email" from "already registered". The verification
 *        email is silently a no-op for already-registered addresses, exactly
 *        as in case (a).
 *
 *   Net effect: callers always receive `{ ok: true, requiresVerification: bool }`
 *   for any well-formed email + acceptable password, and the SignInModal UI
 *   shows "check your email" in both cases. An attacker probing for valid
 *   accounts via signup gets the same response either way.
 *
 *   The remaining error branches (weak_password, invalid_email, network)
 *   reveal nothing about whether the email is registered.
 *
 * requiresVerification reflects whether Supabase returned a session:
 *   - session present  → email-confirmation disabled AND email is new → user signed in
 *   - session === null → email-confirmation enabled, OR email is already registered
 *                        → show "check your email" message in SignInModal
 *
 * Per D-04 the user proceeds either way (when a session is returned);
 * the verify-email Banner (plan 06) handles the persistent prompt when
 * emailVerified is false.
 */
export async function signUpWithPassword(args: {
  email: string;
  password: string;
  dobYear: number;
  dobMonth: number;
  dobDay: number;
}): Promise<SignUpResult> {
  // W7 region gate (260816) — refuse before EVERYTHING: no Supabase call, no
  // cooldown recording, no signup-guard hit for a region we cannot serve.
  // Fails open on any detection failure.
  if (await isCloudAuthRegionBlocked()) {
    return { ok: false, code: REGION_BLOCKED, message: REGION_BLOCKED_COPY };
  }

  // F-10 (quick/260525-usc) — COPPA age gate. Compute age from the
  // self-attested DOB triple via wall-clock today. The DOB itself is NEVER
  // logged, NEVER passed to Supabase, NEVER persisted in any form. We store
  // only the derived boolean fact `age >= 13` — the existence of a successful
  // auth.signUp call, combined with the signup timestamp Supabase records,
  // IS that boolean. This is privacy minimisation per the COPPA disclosure
  // in privacy.html §7.
  //
  // Reject BEFORE any Supabase call so an underage user's email is never
  // sent to Supabase at all (Supabase would otherwise enqueue a verification
  // email which we'd then strand).
  {
    const today = new Date();
    const todayYear = today.getFullYear();
    const todayMonth = today.getMonth() + 1; // getMonth() is 0-indexed
    const todayDay = today.getDate();
    let age = todayYear - args.dobYear;
    if (todayMonth < args.dobMonth || (todayMonth === args.dobMonth && todayDay < args.dobDay)) {
      age -= 1;
    }
    if (age < 13) {
      return {
        ok: false,
        code: 'under_13',
        message: 'Sorry, Sei accounts require you to be at least 13 years old. (COPPA compliance.)',
      };
    }
  }

  // 260603 anti-abuse — escalating per-device signup cooldown (Layer 1).
  // Checked BEFORE any Supabase call so a rapid local automation loop is
  // throttled before it can hammer Supabase Auth. The attempt is RECORDED
  // below regardless of the server outcome, so triggering a server 4xx doesn't
  // let an attacker dodge the ladder. Friction, not a hard lock — a human
  // spacing signups by >30s never hits it. See signupCooldown.ts.
  {
    const { checkSignupCooldown, recordSignupAttempt } = await import('./signupCooldown');
    const decision = await checkSignupCooldown();
    if (!decision.allowed) {
      const secs = Math.ceil(decision.retryAfterMs / 1000);
      return {
        ok: false,
        code: 'cooldown',
        retryAfterMs: decision.retryAfterMs,
        message: `You're creating accounts quickly. Please wait ${secs}s and try again.`,
      };
    }
    // Record the attempt up-front (before the network call) so a crash /
    // process kill mid-signup still counts the attempt against the ladder.
    await recordSignupAttempt();
  }

  // 260603 anti-abuse — server-side per-IP signup guard (Layer 4). Call the
  // signup-guard Edge Function BEFORE auth.signUp. It applies a per-IP
  // fixed-window bucket and 429s a flood. We honor a 429 (return cooldown copy)
  // but FAIL OPEN on any network/transport error or non-429 status — the guard
  // being unreachable must never block a legitimate human (the Supabase-native
  // per-IP limit + the trial-claim gates remain the backstops).
  {
    const guard = await callSignupGuard();
    if (guard.rateLimited) {
      const secs = guard.retryAfterSeconds ?? 60;
      return {
        ok: false,
        code: 'cooldown',
        retryAfterMs: secs * 1000,
        message: `Too many sign-ups right now. Please wait ${secs}s and try again.`,
      };
    }
  }

  // 260603 anti-abuse — Turnstile/hCaptcha bot-protection seam. When the
  // operator has enabled bot-protection (CAPTCHA_ENABLED + Supabase Dashboard
  // setting), the renderer hands a solved token to main via the
  // `auth:set-captcha-token` IPC channel; we forward it as
  // options.captchaToken. Inert (undefined) until keys are provisioned — see
  // captcha.ts + ABUSE-GUARD-PLAN.md §4c.
  const captchaToken = (await import('./captcha')).consumeCaptchaToken();

  const supabase = getClient();
  try {
    const result = await withTimeout(
      supabase.auth.signUp({
        email: args.email,
        password: args.password,
        // Point Supabase at our loopback callback for the verification email.
        // Without this, the email link uses the project's Site URL (defaults
        // to localhost:3000, where nothing listens, so the OTP just expires).
        options: {
          emailRedirectTo: LOOPBACK_CALLBACK_URL,
          ...(captchaToken ? { captchaToken } : {}),
        },
      }),
      15_000,
      // Timeout fallback shape cast via `unknown` — see signInWithPassword.
      () =>
        ({
          data: { session: null, user: null },
          error: { message: 'timeout' },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    if (error) {
      const msg = error.message.toLowerCase();
      // Already-registered (260519 UAT fix #4 case b). 260605: no longer a
      // silent neutral success — surface it honestly. See alreadyRegisteredResult.
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        return await alreadyRegisteredResult(args.email);
      }
      return classifySignUpError(error.message);
    }
    const data = (result as {
      data: {
        session: unknown | null;
        user: { id?: string; identities?: unknown[] } | null;
      };
    }).data;
    // Already-registered → neutral success (260519 UAT fix #4 case a):
    //   Supabase signals "this email is already registered" by returning a
    //   user object with an empty identities array.
    if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      // Do NOT record ToS for a re-signup attempt against an already-registered
      // account — there's no new user to associate the acceptance with, and the
      // signed-in user's prior tos_acceptance row (if any) is still authoritative.
      // 260605: surface it honestly instead of the old silent neutral success.
      return await alreadyRegisteredResult(args.email);
    }
    // Phase 11 plan 12 (D-26 / LIB-06) — fire-and-forget tos_acceptance insert
    // for the brand-new user. Failure here does NOT block signup: the next
    // launch's blocking modal (Plan 11-13) re-prompts when isTosAccepted
    // returns false, and the cloud-write gate (Plan 11-14) blocks any cloud
    // write until accepted, so a transient INSERT failure here is recoverable.
    // We don't await on the modal blocking path — the renderer's confirmation
    // already disabled the submit button until tosChecked, so this is a record
    // of an explicit consent already given.
    const newUserId = data?.user?.id;
    if (typeof newUserId === 'string' && newUserId.length > 0) {
      try {
        const { recordAcceptance } = await import('./tosGate');
        await recordAcceptance(newUserId);
      } catch (err) {
        logger.warn(`signUpWithPassword: post-signup ToS record failed: ${(err as Error).message}`);
      }
    }
    return { ok: true, requiresVerification: data?.session == null };
  } catch (err) {
    return classifySignUpError((err as Error).message);
  }
}

/*
 * Module-level abort controller for the in-flight Google OAuth attempt.
 *
 * Held across one OAuth handler invocation so that:
 *   1. The cancel handler can fire .abort() on the in-flight loopback wait.
 *   2. A second OAuth attempt invoked while a previous one is still in flight
 *      (e.g. the user clicked twice) aborts the old attempt before starting a
 *      new one — otherwise we'd race two loopback servers on two ephemeral
 *      ports.
 *
 * Cleared in the finally block so a stale controller from a completed flow
 * doesn't get aborted later (a no-op abort is harmless, but adds log noise).
 */
let oauthController: AbortController | null = null;

export async function signInWithGoogle(): Promise<OAuthResult> {
  // W7 region gate (260816) — refuse before the browser ever opens. Fails open.
  if (await isCloudAuthRegionBlocked()) {
    return { ok: false, reason: REGION_BLOCKED, message: REGION_BLOCKED_COPY };
  }
  // If a previous attempt is still in flight (user double-clicked), abort it
  // before starting a new one. The old loopback handler will resolve with
  // reason:'user_cancelled' and its server will close in its own finally.
  if (oauthController) {
    oauthController.abort();
    oauthController = null;
  }
  const controller = new AbortController();
  oauthController = controller;
  try {
    return await startGoogleOAuth({ timeoutMs: 60_000, abortSignal: controller.signal });
  } finally {
    // Only clear if WE are still the owner — a concurrent re-entry could have
    // already replaced us.
    if (oauthController === controller) oauthController = null;
  }
}

export async function cancelGoogle(): Promise<void> {
  if (oauthController) {
    oauthController.abort();
    oauthController = null;
  }
}

/**
 * Sign out. AUTH-05 invariant: local data (characters/, memory/, api_key.bin,
 * cached cloud character definitions) is NEVER touched here — Supabase only
 * owns session.bin via the safeStorage adapter, and supabase.auth.signOut()
 * delegates removal to that adapter alone.
 *
 * Ordering (D-09 + threat T-10-06-09): if a bot is running we MUST call
 * supervisor.stop() BEFORE auth.signOut() so the bot disconnects with a still-
 * valid JWT, rather than racing a soon-to-be-revoked one. The user has already
 * confirmed via SignOutConfirmModal; we don't re-prompt.
 *
 * Threat T-10-06-02: if auth.signOut() fails (network down, Supabase down),
 * we still drop the renderer to local mode via transitionToLocal() so the user
 * isn't stranded in a half-signed state. The next launch's session.bin load
 * will either succeed (false alarm) or fail (real signed-out state). The
 * supervisor.stop() failure path is similarly swallowed — we always continue
 * to the auth.signOut() call.
 *
 * Plan 10-06.
 */
export async function signOut(): Promise<void> {
  // D-09 + T-10-06-09: stop the bot first so its final request flushes under
  // the still-valid JWT.
  await stopBotIfActive('signOut');
  try {
    await getClient().auth.signOut();
  } catch (err) {
    // T-10-06-02: never strand the renderer mid-signout. Force local state.
    logger.warn(`signOut: supabase.auth.signOut failed: ${(err as Error).message}`);
    transitionToLocal();
  }
}

/**
 * Delete the signed-in user's account via the delete-me Edge Function (AUTH-06).
 *
 * Flow:
 *   1. Pull access_token from the live session via getClient().auth.getSession().
 *      No session → {ok:false, code:'network', 'Not signed in'}.
 *   2. POST to /functions/v1/delete-me with Bearer JWT. The Edge Function
 *      inserts a deletion_queue row + calls auth.admin.deleteUser.
 *   3. On HTTP 204 / 2xx → call supabase.auth.signOut() locally so session.bin
 *      is cleared and the SIGNED_OUT event drops the renderer to AuthChoice
 *      (D-12 success state).
 *   4. Map status=0 → 'network', other non-2xx → 'edge_function_error'.
 *
 * Threat T-10-08-03 mitigation: the server side already runs a compensating
 * delete on the queue row if auth.admin.deleteUser fails — by the time we see
 * !res.ok here, no queue row exists.
 *
 * Plan 10-08.
 */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const supabase = getClient();
  const { data: { session }, error: sessErr } = await supabase.auth.getSession();
  if (sessErr || !session) {
    return { ok: false, code: 'network', message: 'Not signed in' };
  }
  // BL-06: deleteAccount is logically a superset of sign-out — D-09 +
  // T-10-06-09's "stop bot before clearing session" invariant applies here
  // too. Without this, the running bot continues with a soon-to-be-invalid
  // JWT until its next action (which will 401-cascade in Phase 13). User
  // has already confirmed via DeleteAccountModal, no re-prompt.
  await stopBotIfActive('deleteAccount');
  const res = await callEdgeFunction('delete-me', {
    jwt: session.access_token,
    method: 'POST',
  });
  if (res.ok) {
    // Deletion succeeded server-side; clear local session so the renderer
    // drops to AuthChoice via the SIGNED_OUT event (D-12 success state).
    try {
      await supabase.auth.signOut();
    } catch (err) {
      // Best-effort — the account is gone; even if signOut fails locally,
      // the user's next API call will 401 and Supabase will SIGNED_OUT.
      logger.warn(`deleteAccount: post-delete signOut failed: ${(err as Error).message}`);
    }
    return { ok: true };
  }
  if (res.status === 0) {
    return {
      ok: false,
      code: 'network',
      message: "Couldn't reach the account-deletion service. Try again.",
    };
  }
  return { ok: false, code: 'edge_function_error', message: res.message };
}

/**
 * Export the signed-in user's cloud data as a JSON file (AUTH-07).
 *
 * Flow:
 *   1. Pull current session → fail closed if not signed in.
 *   2. Build the schemaVersion=1 envelope via buildExport (see
 *      exportBuilder.ts). Phase 10 fills `account`; Phase 11 fills
 *      `characters` from the cloud (async); sharing is empty-but-present
 *      per D-14 so Phase 12 can append data without bumping schemaVersion.
 *      CLOUD_LIST_FAILED from buildExport is caught and routed to the
 *      same {write_failed} envelope as writeFile timeouts (T-11-11 plan).
 *   3. Prompt the native save dialog with a `sei-export-<YYYY-MM-DD>.json`
 *      default filename. The path comes from the user via the OS dialog —
 *      never from the renderer (T-10-09-02 mitigation).
 *   4. writeFile wrapped in a 15s withTimeout per CLAUDE.md "every external
 *      call has a timeout" invariant. A stuck network drive surfaces cleanly
 *      as {code:'write_failed', message:'Save timed out'} instead of freezing
 *      the IPC channel (T-10-09-03 mitigation).
 *
 * Cancellation is silent: dialog Cancel → {ok:false, code:'cancelled'}. The
 * renderer's SettingsScreen treats `code:'cancelled'` as a no-op (no toast).
 *
 * Audit (T-10-09-04): buildExport reads ONLY session.user.{email,created_at}.
 * The JWT (access_token / refresh_token) is never written to disk.
 *
 * Plan 10-09.
 */
export async function exportData(): Promise<ExportDataResult> {
  const supabase = getClient();
  const { data: { session }, error: sessErr } = await supabase.auth.getSession();
  if (sessErr || !session) {
    return { ok: false, code: 'write_failed', message: 'Not signed in' };
  }

  // Phase 11 — buildExport is async; it fetches characters[] from cloud.
  // CLOUD_LIST_FAILED errors surface here as the rejected promise; the
  // catch block below maps them to {ok:false, code:'write_failed'} like
  // any other failure mode (envelope is symmetric with the writeFile
  // timeout path — message is preserved verbatim).
  let envelope;
  try {
    envelope = await buildExport(session);
  } catch (err) {
    return { ok: false, code: 'write_failed', message: (err as Error).message };
  }

  // Lazy-import electron so test environments without electron can still
  // type-check / import this file. dialog + BrowserWindow are main-process-only.
  const { dialog, BrowserWindow } = await import('electron');
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const defaultPath = `sei-export-${today}.json`;

  const saveOpts = {
    defaultPath,
    title: 'Save Sei data export',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const saveRes = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts);

  if (saveRes.canceled || !saveRes.filePath) {
    return { ok: false, code: 'cancelled', message: 'Cancelled' };
  }

  const filePath = saveRes.filePath;
  const json = JSON.stringify(envelope, null, 2);

  // CLAUDE.md invariant: every external call has a timeout. A network drive
  // can hang writeFile indefinitely; the 15s wrap surfaces it as a clean
  // error rather than freezing the IPC channel (T-10-09-03).
  try {
    await withTimeout(
      writeFile(filePath, json, 'utf8'),
      15_000,
      () => {
        throw new Error('timeout');
      },
    );
    return { ok: true, savedPath: filePath };
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'timeout') {
      return { ok: false, code: 'write_failed', message: 'Save timed out' };
    }
    return { ok: false, code: 'write_failed', message };
  }
}

/**
 * Resend the email-verification code via supabase.auth.resend({type:'signup'}).
 *
 * Rate-limit policy (Supabase default: 60s between resends per email):
 *   - 429 / "rate limit" → {code:'rate_limited'} with the verbatim D-04 copy.
 *   - Any other error    → {code:'network'} fallback.
 *   - No email available → {code:'network', 'Not signed in'} — a freshly
 *     signed-up-but-unverified user has NO session, so callers in that state
 *     (the onboarding verify panel, 260729) pass the address they just signed
 *     up with explicitly; the signed-in fallback serves the Settings Banner.
 *
 * 260804 ALREADY-CONFIRMED FALLBACK. The code panel now sits over two different
 * inboxes (see verifyEmailCode), and its Resend button has to work on both or
 * the decoy path is distinguishable by a button that errors. For a confirmed
 * address Supabase refuses a signup resend outright, so that specific refusal
 * quietly re-sends a RECOVERY code instead and reports the same neutral success.
 * Nothing about which branch ran reaches the renderer.
 *
 * 15s timeout wrap mirrors signInWithPassword / signUpWithPassword.
 *
 * Plan 10-06.
 */
export async function resendVerification(email?: string): Promise<ResendVerificationResult> {
  const state = getCurrentAuthState();
  const target = email?.trim() || (state.kind === 'signed_in' ? state.user.email : undefined);
  if (!target) {
    return { ok: false, code: 'network', message: 'Not signed in' };
  }
  const supabase = getClient();
  try {
    const result = await withTimeout(
      supabase.auth.resend({ type: 'signup', email: target }),
      15_000,
      // Timeout fallback shape — only .error is read on the unhappy path.
      () =>
        ({
          data: { user: null, session: null },
          error: { message: 'timeout', status: 0 },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.resend>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    if (error) {
      const m = error.message.toLowerCase();
      const status = error.status;
      if (status === 429 || m.includes('rate limit') || m.includes('over_email_send_rate_limit')) {
        return {
          ok: false,
          code: 'rate_limited',
          message: 'Hold on, wait a minute before requesting another code.',
        };
      }
      // Already-confirmed address → this is the decoy path (or a user who
      // verified elsewhere). Send a recovery code so the panel's Resend button
      // behaves identically for both kinds of inbox.
      if (m.includes('already confirmed') || m.includes('already been confirmed') ||
          m.includes('already registered') || m.includes('email_already_confirmed')) {
        const reset = await sendPasswordReset({ email: target });
        // oauth_only means no password identity exists, so no code can be sent.
        // Stay neutral rather than naming the provider here — the caller is a
        // code panel, not the sign-in form that surfaces oauth_only honestly.
        return reset.ok || reset.code === 'oauth_only'
          ? { ok: true }
          : { ok: false, code: reset.code, message: reset.message };
      }
      return { ok: false, code: 'network', message: "Couldn't resend the code." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'network', message: (err as Error).message };
  }
}

/**
 * 260804 — redeem a 6-digit email code.
 *
 * WHY IT TRIES TWO TOKEN TYPES. The panel that collects a code cannot know
 * which kind of email the user is holding, and it must not find out: a
 * brand-new address gets a `signup` confirmation code, while an address that
 * is ALREADY registered gets a `recovery` code (alreadyRegisteredResult's
 * silent forgot-password treatment), and the two paths are deliberately
 * indistinguishable in the UI — that indistinguishability IS the T-10-04
 * enumeration defence. So main tries `signup`, and on a token mismatch tries
 * `recovery`. Supabase keeps the two in separate columns on auth.users, so a
 * wrong-type attempt compares against the wrong column, fails cleanly, and
 * consumes nothing.
 *
 * Cost of the two-step: a genuinely wrong code costs two verify round trips
 * instead of one, which halves how many wrong guesses fit inside Supabase's
 * per-IP token-verification limit. A wrong code is the rare path and the limit
 * is generous, so this is not worth optimising with a client-side guess about
 * which email we last sent — that guess would be wrong exactly when the app
 * restarts between the send and the entry.
 *
 * `signup` is the type GoTrue pairs with the Confirm-signup template's
 * {{ .Token }}. If a future Supabase version routes that token under the newer
 * generic `email` type instead, this is the one line to add to the ladder.
 *
 * A recovery redemption lands a recovery session. We push
 * `auth:password-recovery` on the same channel the loopback callback uses, so
 * App.tsx raises SetNewPasswordModal through wiring that already exists, and
 * ALSO report `recovery: true` so the calling panel can skip its own
 * "you're in" chrome.
 */
export async function verifyEmailCode(args: {
  email: string;
  code: string;
}): Promise<VerifyEmailCodeResult> {
  // Users paste codes with spaces and hyphens out of mail clients. Strip to
  // digits so "123 456" and "123-456" both work.
  const token = args.code.replace(/\D/g, '');
  const email = args.email.trim();
  if (token.length === 0) {
    return { ok: false, code: 'invalid_code', message: 'Enter the code from your email.' };
  }
  const supabase = getClient();

  const attempt = async (
    type: 'signup' | 'recovery',
  ): Promise<{ ok: true } | { err: AuthErrShape }> => {
    const result = await withTimeout(
      supabase.auth.verifyOtp({ email, token, type }),
      15_000,
      () =>
        ({
          data: { session: null, user: null },
          error: { message: 'timeout', status: 0 },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.verifyOtp>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    return error ? { err: error } : { ok: true };
  };

  /** Wrong code, wrong type, or past its lifetime — all worth a second try. */
  const isTokenMismatch = (e: AuthErrShape): boolean => {
    const m = e.message.toLowerCase();
    return (
      m.includes('invalid') ||
      m.includes('expired') ||
      m.includes('not found') ||
      e.status === 401 ||
      e.status === 403 ||
      e.status === 404
    );
  };

  const isRateLimited = (e: AuthErrShape): boolean => {
    const m = e.message.toLowerCase();
    return e.status === 429 || m.includes('rate limit') || m.includes('too many');
  };

  try {
    const first = await attempt('signup');
    if ('ok' in first) return { ok: true, recovery: false };
    if (isRateLimited(first.err)) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'Too many tries. Wait a minute, then enter the code again.',
      };
    }
    if (!isTokenMismatch(first.err)) {
      return {
        ok: false,
        code: 'network',
        message: "Couldn't check that code. Check your connection and try again.",
      };
    }

    const second = await attempt('recovery');
    if ('ok' in second) {
      // Recovery session is live. Raise the new-password prompt through the
      // same channel the emailed-link path used, so App.tsx needs no new
      // subscriber. Focus the window first for the same reason the loopback
      // handler does: the modal should animate in on a foregrounded window.
      try {
        const { BrowserWindow } = await import('electron');
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send(IpcChannel.auth.passwordRecovery);
        }
      } catch (err) {
        // The renderer still gets recovery:true in the result, so a failed
        // push degrades to "the panel routes it" rather than stranding the
        // user in a recovery session with no prompt.
        logger.warn(`verifyEmailCode: recovery push failed: ${(err as Error).message}`);
      }
      return { ok: true, recovery: true };
    }
    if (isRateLimited(second.err)) {
      return {
        ok: false,
        code: 'rate_limited',
        message: 'Too many tries. Wait a minute, then enter the code again.',
      };
    }
    return {
      ok: false,
      code: 'invalid_code',
      message: "That code didn't work. Check it, or send a new one.",
    };
  } catch (err) {
    return { ok: false, code: 'network', message: (err as Error).message };
  }
}

/**
 * Send a password-reset email via supabase.auth.resetPasswordForEmail.
 *
 * Anti-enumeration (mirrors signUpWithPassword): return { ok:true } whether or
 * not the address is registered. Supabase itself does not reveal it, and a
 * neutral response keeps the renderer from leaking account existence on the
 * sign-in screen.
 *
 * 260804: the reset email now carries a 6-digit code, redeemed in-app by
 * verifyEmailCode, which pushes auth:password-recovery itself. The redirectTo
 * and the recovery flag are KEPT rather than removed: the Supabase templates
 * are dashboard state, not repo state, so a template that still renders
 * {{ .ConfirmationURL }} (an older project, a rollback, an email already in
 * someone's inbox when the template changed) must keep landing on the loopback
 * server and still be recognised as a recovery. Reusing the existing redirect
 * also means no new dashboard Redirect-URL allow-list entry is required.
 *
 * 15s timeout wrap mirrors signInWithPassword / resendVerification.
 */
export async function sendPasswordReset(args: { email: string }): Promise<PasswordResetResult> {
  const supabase = getClient();
  // 260605 — refuse a reset for an OAuth-only account. A Google-only account
  // has no password identity; resetPasswordForEmail + updateUser would graft a
  // password onto it, silently turning a Google account into an email/password
  // one. Look up the providers first; only block when we KNOW the account is
  // OAuth-only (providers present AND no 'email'). Fail OPEN on a null lookup
  // (RPC unreachable) and proceed neutrally for an unknown email (empty array)
  // so we neither block legitimate resets nor leak existence of unknown emails.
  const providers = await lookupIdentityProviders(args.email);
  if (providers && providers.length > 0 && !providers.includes('email')) {
    const friendly = providerLabel(providers.includes('google') ? 'google' : providers[0]);
    return {
      ok: false,
      code: 'oauth_only',
      provider: friendly,
      message: `This account uses ${friendly} sign-in, so it has no password to reset. Use “Continue with ${friendly}” instead.`,
    };
  }
  // Mark BEFORE the network call so a user who clicks the emailed link very
  // quickly still finds the flag set when the loopback exchange runs.
  markRecoveryRequested();
  try {
    const result = await withTimeout(
      supabase.auth.resetPasswordForEmail(args.email, { redirectTo: LOOPBACK_CALLBACK_URL }),
      15_000,
      // Timeout fallback shape — only .error is read on the unhappy path.
      () =>
        ({
          data: {},
          error: { message: 'timeout', status: 0 },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.resetPasswordForEmail>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    if (error) {
      const m = error.message.toLowerCase();
      if (
        error.status === 429 ||
        m.includes('rate limit') ||
        m.includes('over_email_send_rate_limit')
      ) {
        return {
          ok: false,
          code: 'rate_limited',
          message: 'Hold on, wait a minute before requesting another reset link.',
        };
      }
      // Any other server error: neutral network copy (still no account-existence
      // signal).
      return {
        ok: false,
        code: 'network',
        message: "Couldn't send the reset email. Check your connection and try again.",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'network', message: (err as Error).message };
  }
}

/**
 * Set a new password for the currently signed-in user via
 * supabase.auth.updateUser({ password }).
 *
 * Reached from SetNewPasswordModal after a reset link lands a recovery session —
 * the user IS signed in at that point (a recovery session satisfies signed_in).
 * If the session has since expired (`not_signed_in`) the renderer routes the
 * user back to request a fresh link.
 *
 * 15s timeout wrap mirrors signInWithPassword.
 */
export async function updatePassword(args: { password: string }): Promise<UpdatePasswordResult> {
  const state = getCurrentAuthState();
  if (state.kind !== 'signed_in') {
    return {
      ok: false,
      code: 'not_signed_in',
      message: 'Your reset link expired. Request a new one from the sign-in screen.',
    };
  }
  const supabase = getClient();
  try {
    const result = await withTimeout(
      supabase.auth.updateUser({ password: args.password }),
      15_000,
      () =>
        ({
          data: { user: null },
          error: { message: 'timeout', status: 0 },
        }) as unknown as Awaited<ReturnType<typeof supabase.auth.updateUser>>,
    );
    const error = (result as { error: AuthErrShape | null }).error;
    if (error) {
      const m = error.message.toLowerCase();
      // Supabase weak-password copy varies ("Password should be at least N
      // characters", "weak password"); match the common shapes, else network.
      if (m.includes('weak') || m.includes('at least') || m.includes('characters')) {
        return { ok: false, code: 'weak_password', message: 'Password must be at least 8 characters.' };
      }
      return { ok: false, code: 'network', message: "Couldn't update your password. Try again." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'network', message: (err as Error).message };
  }
}
