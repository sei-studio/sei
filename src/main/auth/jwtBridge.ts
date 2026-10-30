/**
 * JWT delivery from main process to utilityProcess.
 *
 * Subscribes to Supabase auth events; on SIGNED_IN / TOKEN_REFRESHED /
 * INITIAL_SESSION / USER_UPDATED pushes the current access_token (JWT) to the
 * bot supervisor, which forwards to the running utilityProcess (if any) over
 * MessagePortMain. On SIGNED_OUT pushes null.
 *
 * Phase 10 wires this. Phase 13's proxy is the JWT consumer (the bot will
 * use it as a Bearer header when cloud-AI mode is selected). In Phase 10
 * the bot loop ignores the {type:'jwt'} message — that's expected; the
 * wiring is verified in plan 06's checkpoint.
 *
 * SECURITY (T-10-06-01): only `session.access_token` crosses to utilityProcess.
 * The refresh credential never leaves main — it stays in sessionStore.bin
 * behind safeStorage. The plan's verification gate greps the snake-case
 * Supabase field name (refresh- + -token, joined) against this file and
 * expects 0 matches.
 *
 * Sources:
 *   - 10-CONTEXT Claude's discretion (JWT-only crosses to utilityProcess)
 *   - 10-RESEARCH §Pitfall A4 (push on TOKEN_REFRESHED to avoid stale-JWT bot stop)
 */
import { getClient } from './supabaseClient';
import type { BotSupervisor } from '../botSupervisor';

let supervisorRef: BotSupervisor | null = null;
let subscription: { unsubscribe: () => void } | null = null;

/**
 * Arm supabase-js's background refresh ticker. Must be called explicitly in
 * Electron's main process (see the incident note in initJwtBridge). Best-effort:
 * a missing method (test mocks) or a transient error never blocks bridge init.
 */
function startAutoRefreshSafely(): void {
  try {
    const auth = getClient().auth as { startAutoRefresh?: () => Promise<void> };
    void auth.startAutoRefresh?.()?.catch(() => { /* ticker retries on its own */ });
  } catch { /* best-effort */ }
}

/** Stop the refresh ticker (sign-out / re-init). Best-effort, mock-safe. */
async function supabase_stopAutoRefresh(): Promise<void> {
  try {
    const auth = getClient().auth as { stopAutoRefresh?: () => Promise<void> };
    await auth.stopAutoRefresh?.();
  } catch { /* best-effort */ }
}

export async function initJwtBridge(supervisor: BotSupervisor): Promise<void> {
  // BL-02: bootstrap() can run more than once on macOS (app.on('activate')
  // re-entry). Drop the prior subscription before re-binding so we don't
  // accumulate auth-event subscribers (each of which would re-fire
  // supervisor.updateJwt on every event) on each reopen.
  subscription?.unsubscribe();
  subscription = null;
  void supabase_stopAutoRefresh();
  supervisorRef = supervisor;
  const supabase = getClient();

  // Push the initial token so supervisor.updateJwt has a value before the
  // first summon. 261029: NOT awaited. getSession() refreshes an expired token
  // and first waits for supabase-js's startup refresh, ~51 s offline, and the
  // bootstrap steps after this one (the loopback auth-callback server among
  // them) used to wait with it. Applied only if no auth event has delivered a
  // token first (INITIAL_SESSION carries the same answer), so a late result
  // never overwrites a newer one.
  let eventSeen = false;
  void supabase.auth
    .getSession()
    .then(({ data }) => {
      if (!eventSeen && supervisorRef === supervisor) supervisor.updateJwt(data?.session?.access_token ?? null);
    })
    .catch(() => { /* the auth events below deliver the token */ });

  // CRITICAL (260617 expired_jwt incident): `autoRefreshToken: true` is NOT
  // self-starting outside a browser. supabase-js only arms its refresh ticker
  // automatically via `visibilitychange`/focus events, which don't exist in
  // Electron's main process — so the JWT silently expired ~1h after sign-in,
  // `TOKEN_REFRESHED` never fired, and a live bot 401'd mid-session with no
  // recovery (it spent 40s hammering a dead token, then dropped). Start the
  // ticker explicitly: it checks every ~10s and rotates the JWT before expiry,
  // which fires TOKEN_REFRESHED below and pushes the fresh token to the bot.
  // Optional-chained so the lightweight test mocks (no startAutoRefresh) no-op.
  startAutoRefreshSafely();

  // Pitfall A4: TOKEN_REFRESHED fires whenever Supabase rotates the JWT
  // (~5 min before expiry; default JWT lifetime 1h). Without forwarding
  // here, a long-running bot would carry a stale JWT until the next sign-in.
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    eventSeen = true;
    if (!supervisorRef) return;
    switch (event) {
      case 'SIGNED_IN':
      // A password-reset session arrives as PASSWORD_RECOVERY with no
      // SIGNED_IN (verifyOtp type 'recovery'), and it is a sign-in too (261029).
      case 'PASSWORD_RECOVERY':
        // A fresh sign-in (re)arms the refresh ticker — a prior SIGNED_OUT may
        // have stopped it.
        startAutoRefreshSafely();
        supervisorRef.updateJwt(session?.access_token ?? null);
        break;
      case 'TOKEN_REFRESHED':
      case 'INITIAL_SESSION':
      case 'USER_UPDATED':
        supervisorRef.updateJwt(session?.access_token ?? null);
        break;
      case 'SIGNED_OUT':
        void supabase_stopAutoRefresh();
        supervisorRef.updateJwt(null);
        break;
    }
  });
  subscription = sub.subscription;
}

/** TEST-ONLY: directly invoke the push path without going through Supabase. */
export function pushJwtToUtility(jwt: string | null): void {
  supervisorRef?.updateJwt(jwt);
}

/** TEST-ONLY: reset for clean test isolation. */
export function _disposeForTests(): void {
  subscription?.unsubscribe();
  subscription = null;
  supervisorRef = null;
  void supabase_stopAutoRefresh();
}
