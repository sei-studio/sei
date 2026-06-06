/**
 * CAPTCHA / Turnstile bot-protection seam (anti-abuse, Layer 2).
 *
 * MAIN PROCESS ONLY.
 *
 * Supabase Auth supports Cloudflare Turnstile / hCaptcha bot-protection on the
 * Auth surface. When the operator enables it (USER-ACTION: provision keys +
 * flip the Supabase Dashboard → Auth → Bot Protection setting + set
 * CAPTCHA_ENABLED=true), `auth.signUp` / `auth.signInWithPassword` REQUIRE an
 * `options.captchaToken`.
 *
 * v1.0 is a desktop app with no browser origin, so the renderer hosts the
 * Turnstile widget (a sandboxed webview on the signup screen) and, on the
 * widget's success callback, hands the solved token to main via the
 * `auth:set-captcha-token` IPC channel. This module is the single holder for
 * that token: `signUpWithPassword` calls `consumeCaptchaToken()` immediately
 * before the Supabase call and forwards the result.
 *
 * Tokens are SINGLE-USE and short-lived (Turnstile tokens expire ~5 min and
 * are invalidated server-side on first verify), so we CONSUME (read-and-clear)
 * rather than read — a stale token must never be reused.
 *
 * INERT BY DEFAULT: when bot-protection is not enabled the renderer never sets
 * a token, `consumeCaptchaToken()` returns undefined, and the signUp call omits
 * `captchaToken` — so the build keeps working before keys are provisioned. See
 * ABUSE-GUARD-PLAN.md §4c + the §8 USER-ACTIONS runbook.
 */

let pendingToken: string | null = null;

/**
 * Store a Turnstile/hCaptcha token solved by the renderer widget. Wired to the
 * `auth:set-captcha-token` IPC handler. Passing an empty string / null clears.
 */
export function setCaptchaToken(token: string | null): void {
  pendingToken = token && token.length > 0 ? token : null;
}

/**
 * Read AND clear the pending captcha token (single-use). Returns undefined when
 * none is set (bot-protection disabled, or already consumed). `signUpWithPassword`
 * forwards a defined result as `options.captchaToken`.
 */
export function consumeCaptchaToken(): string | undefined {
  const t = pendingToken ?? undefined;
  pendingToken = null;
  return t;
}

/** Whether bot-protection is enabled in this build (operator flag). */
export function isCaptchaEnabled(): boolean {
  // Read at call time so tests / packaged builds can toggle via env. The
  // electron-vite `define` substitutes import.meta.env at build; process.env is
  // the dev fallback.
  const fromProcess = typeof process !== 'undefined' ? process.env?.CAPTCHA_ENABLED : undefined;
  return fromProcess === 'true' || fromProcess === '1';
}

/** TEST-ONLY: reset the pending token. */
export function _resetCaptchaForTests(): void {
  pendingToken = null;
}
