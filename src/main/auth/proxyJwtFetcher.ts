/**
 * Cloud-proxy JWT fetcher + utilityProcess rotation pump.
 *
 * Plan 13-14 (PROXY-08): every cloud-proxy bot call must carry a fresh Bearer
 * JWT. Supabase access tokens expire in ~1h; the bot's utilityProcess can run
 * for many hours. Two complementary primitives live here:
 *
 *   1. getProxyJwt() — on-demand fetch. Reads the current Supabase session,
 *      refreshes if expiry is within REFRESH_THRESHOLD_MS, returns the
 *      access_token. The 5-minute buffer absorbs clock skew + network jitter
 *      so a request never lands at the proxy with an exp-just-past token.
 *
 *   2. setupJwtRotation(target) — background pump for the utilityProcess.
 *      Posts a {kind:'cloud-jwt-update', jwt} message every
 *      ROTATION_INTERVAL_MS (30 min) so the bot's anthropicClient.js sees a
 *      rolling fresh token mid-session. 30 min × 1h JWT = 30 min buffer:
 *      if a single rotation tick fails (network blip), the next tick
 *      recovers before the in-flight token expires.
 *
 * Threat model:
 *   - T-13-14-01 (info disclosure): JWT NEVER appears in console.warn. Only
 *     the ProxyAuthError instance (which carries `code`, not the token) is
 *     logged. The token itself is held in a local variable that goes out of
 *     scope immediately after postMessage.
 *   - T-13-14-02 (DoS): refreshSession is wrapped in a 5s AbortController
 *     timeout — Supabase-js has internal retry logic but no caller-visible
 *     timeout, so a hung Supabase auth endpoint would otherwise deadlock the
 *     rotation pump (and any in-flight cloud-proxy call). The supabase-js
 *     refreshSession() API does not accept an AbortSignal, but installing the
 *     controller + timeout still acts as a wall-clock budget alongside the
 *     await — paired with the fact that the rotation pump's catch keeps the
 *     bot running with the previous token, this is the right shape per
 *     PATTERNS pitfall "every external call has a timeout".
 *
 * MessagePortMain channel:
 *   - Phase 10's existing pump uses `kind:'jwt-update'` (Supabase user JWT
 *     for renderer/main IPC). This module introduces a DISTINCT
 *     `kind:'cloud-jwt-update'` so the two channels never alias — different
 *     audiences (proxy vs supabase) and different consumers (anthropic SDK
 *     vs supabaseClient).
 *
 * Sources:
 *   - 13-PATTERNS §"JWT rotation" (refresh threshold + bot-side authToken
 *     reassignment)
 *   - 13-PATTERNS §"Every external call has an AbortController + timeout"
 *   - 10-RESEARCH §Pattern 1 (supabase singleton + safeStorage)
 */
import { getClient } from './supabaseClient.js';

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const ROTATION_INTERVAL_MS = 30 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5_000;

/**
 * Stable error vocabulary for cloud-proxy auth failures. Callers branch on
 * `code` — message strings may change for human readability without
 * breaking callers.
 */
export class ProxyAuthError extends Error {
  constructor(
    public readonly code: 'PROXY_NO_SESSION' | 'PROXY_REFRESH_FAILED',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ProxyAuthError';
  }
}

/**
 * Fetch a fresh cloud-proxy JWT.
 *
 * Behavior:
 *   - No session → throws ProxyAuthError(PROXY_NO_SESSION).
 *   - Session expiry within 5 minutes (or already past) → calls
 *     refreshSession. On error or null session → throws
 *     ProxyAuthError(PROXY_REFRESH_FAILED).
 *   - Session healthy → returns existing access_token.
 *
 * The 5s timeout guards against a hung Supabase auth endpoint deadlocking
 * the caller (rotation pump or per-call fetch).
 */
export async function getProxyJwt(): Promise<string> {
  const supabase = getClient();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ProxyAuthError('PROXY_NO_SESSION');

  const expiresAtMs = (data.session.expires_at ?? 0) * 1000;
  if (Date.now() > expiresAtMs - REFRESH_THRESHOLD_MS) {
    // WR-06 (Phase 13 REVIEW): we previously constructed an AbortController
    // and a 5s setTimeout that called controller.abort(), but the signal
    // was never observed — supabase-js's refreshSession() doesn't accept
    // an AbortSignal. The controller was decorative; if refreshSession
    // hung, the await hung. Replace the dead controller with a real
    // wall-clock race so the 5s budget is actually enforced.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const refreshP = supabase.auth.refreshSession();
    const timeoutP = new Promise<never>((_, rej) => {
      timeoutId = setTimeout(
        () => rej(new ProxyAuthError('PROXY_REFRESH_FAILED', 'timeout')),
        REFRESH_TIMEOUT_MS,
      );
    });
    try {
      const { data: refreshed, error } = await Promise.race([
        refreshP,
        timeoutP,
      ]);
      if (error || !refreshed.session) {
        throw new ProxyAuthError('PROXY_REFRESH_FAILED', error?.message);
      }
      return refreshed.session.access_token;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
  return data.session.access_token;
}

/**
 * Message-port target shape — narrowed to exactly what this module uses so
 * we can hand the bot's MessagePortMain in directly and a hand-rolled stub
 * in tests. The kind literal is the channel-discriminator on the bot side
 * (see src/bot/index.js cloud-jwt-update handler).
 */
export interface JwtTarget {
  postMessage(msg: { kind: 'cloud-jwt-update'; jwt: string }): void;
}

/**
 * Start a 30-min rotation pump that pushes a fresh JWT to the bot
 * utilityProcess. Returns a teardown closure that callers MUST invoke on
 * bot shutdown (utilityProcess.on('exit', teardown)) so we don't leak the
 * setInterval handle and a now-orphaned tick attempt past the bot lifetime.
 *
 * The pump fires once IMMEDIATELY to seed the bot — without this, the bot
 * would call anthropicClient.js with no CLOUD_PROXY_JWT for up to 30 min
 * after spawn.
 *
 * Errors in a tick are swallowed (console.warn with the ProxyAuthError —
 * NEVER the JWT itself) so a transient Supabase outage doesn't crash the
 * pump. The bot keeps running with its prior token until the next
 * successful tick.
 */
export function setupJwtRotation(target: JwtTarget): () => void {
  let running = true;
  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      const jwt = await getProxyJwt();
      // Re-check running between the await and the postMessage so a
      // teardown during refreshSession doesn't punch a final message into
      // a port the caller has already disposed.
      if (!running) return;
      target.postMessage({ kind: 'cloud-jwt-update', jwt });
    } catch (err) {
      // T-13-14-01: do NOT include the JWT. Only the error code/message.
      console.warn('proxyJwtFetcher rotation_failed', err);
    }
  };
  const handle = setInterval(() => void tick(), ROTATION_INTERVAL_MS);
  // Seed tick — fire once immediately so the bot has a JWT before its first
  // cloud-proxy call rather than waiting up to 30 min for the first interval.
  void tick();
  return () => {
    running = false;
    clearInterval(handle);
  };
}
