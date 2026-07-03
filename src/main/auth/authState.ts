/**
 * Auth state machine + Supabase auth-event subscription.
 *
 * Two-state model per CONTEXT D-06: `local` and `signed_in`. No third state
 * — AuthChoice gates the app before MainApp renders, so the resting state when
 * no session is loaded is `local`.
 *
 * Source of truth: Supabase's auth-event stream. We never set state by hand
 * except for testing or for the synchronous sign-out path in plan 06 (which
 * fires the supabase.auth.signOut() but doesn't await its SIGNED_OUT event
 * before tearing down the bot).
 *
 * Renderer subscription: src/preload/index.ts exposes onAuthState; React
 * subscribes once at App.tsx mount and re-renders on every push.
 *
 * Pitfall A6 (email-verification flip): when the user clicks the verification
 * link in their browser, Supabase fires USER_UPDATED on the next API call.
 * We re-derive emailVerified from the session's user-confirmed-at timestamp
 * on every USER_UPDATED and TOKEN_REFRESHED event.
 *
 * Sources:
 *   - 10-CONTEXT D-06 (two-state model)
 *   - 10-RESEARCH §Pitfall A6 (USER_UPDATED for email-verified flip)
 *   - src/main/index.ts line 214–219 (renderer-reload replay pattern)
 */
import type { BrowserWindow } from 'electron';
import type { Session, User } from '@supabase/supabase-js';
import { getClient } from './supabaseClient';
import { getTosAcceptance } from './tosGate';
import { IpcChannel, type AuthState, type AuthUser } from '../../shared/ipc';

let currentState: AuthState = { kind: 'local' };
let mainWindowRef: BrowserWindow | null = null;
let subscription: { unsubscribe: () => void } | null = null;

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email ?? '',
    emailVerified: user.email_confirmed_at != null,
    createdAt: user.created_at,
  };
}

function applySession(session: Session | null): void {
  if (session && session.user) {
    currentState = { kind: 'signed_in', user: toAuthUser(session.user) };
  } else {
    currentState = { kind: 'local' };
  }
}

export function getCurrentAuthState(): AuthState {
  return currentState;
}

/**
 * Item 3 (cross-device email verification). Supabase confirms an email
 * SERVER-SIDE the moment the verification link is clicked on ANY device — but
 * the loopback redirect only delivers the resulting session to the Sei device
 * itself, and `USER_UPDATED` only fires for a change made through THIS client.
 * So a user who signs up on the desktop and clicks the link on their phone gets
 * confirmed server-side, yet the desktop app never notices and keeps showing
 * "verify your email."
 *
 * Fix: while signed in and not-yet-verified, poll `getUser()` (a server
 * round-trip that reflects the authoritative email_confirmed_at). Once it flips,
 * refresh the local session so the JWT + persisted user agree, re-broadcast the
 * now-verified state, and stop polling. Cheap (only runs while the banner is up)
 * and fully offline-tolerant (a network blip just keeps polling).
 */
let emailPollTimer: ReturnType<typeof setInterval> | null = null;
const EMAIL_POLL_INTERVAL_MS = 10_000;

function stopEmailVerificationPoll(): void {
  if (emailPollTimer) {
    clearInterval(emailPollTimer);
    emailPollTimer = null;
  }
}

async function recheckEmailVerification(): Promise<void> {
  if (currentState.kind !== 'signed_in' || currentState.user.emailVerified) {
    stopEmailVerificationPoll();
    return;
  }
  try {
    const supabase = getClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return; // transient — keep polling
    if (data.user.email_confirmed_at != null) {
      // Confirmed (here or on another device). Refresh the local session so the
      // JWT + stored user reflect it (TOKEN_REFRESHED re-applies + re-broadcasts),
      // and update state immediately for snappy banner dismissal.
      try {
        await supabase.auth.refreshSession();
      } catch {
        /* best-effort — the explicit state update below still clears the banner */
      }
      currentState = { kind: 'signed_in', user: toAuthUser(data.user) };
      broadcastAuthState(mainWindowRef);
      stopEmailVerificationPoll();
    }
  } catch {
    /* network blip — keep polling */
  }
}

/** Start/stop the verification poll to match the current auth state. */
function syncEmailVerificationPolling(): void {
  if (currentState.kind === 'signed_in' && !currentState.user.emailVerified) {
    if (!emailPollTimer) {
      emailPollTimer = setInterval(() => {
        void recheckEmailVerification();
      }, EMAIL_POLL_INTERVAL_MS);
      // Kick one immediate check so a verification completed while the app was
      // closed is picked up on launch without waiting a full interval.
      void recheckEmailVerification();
    }
  } else {
    stopEmailVerificationPoll();
  }
}

/**
 * 260606 — cold-start session validation (auto sign-out of a dead session).
 *
 * `initAuthState`'s `getSession()` reads ONLY the local storage adapter
 * (session.bin), so a session whose user was deleted or revoked server-side
 * still resolves as `signed_in`. Without a proactive check the user is trapped
 * on a blocking gate (notably the ToS modal, which has no escape hatch) until
 * the access token happens to refresh and Supabase fires SIGNED_OUT on its own.
 *
 * `getUser()` round-trips to the auth server to validate the JWT:
 *   - auth-layer rejection (401/403 — user_not_found / bad_jwt / session gone)
 *     → the account is gone or revoked → force sign-out (clears session.bin via
 *       the storage adapter) and drop to `local`.
 *   - network / transport error, timeout, or any non-auth status → leave the
 *     session intact. Offline users MUST keep working; a genuine revocation
 *     resurfaces on the next online token refresh.
 *
 * Best-effort and fire-and-forget from initAuthState — never blocks launch.
 * Exported for unit testing.
 */
export async function validateSessionOrSignOut(): Promise<void> {
  const supabase = getClient();
  // getUser() has no built-in timeout; cap it so a hung network never strands
  // the check. On timeout we KEEP the session (inconclusive → offline-tolerant).
  const TIMEOUT = Symbol('timeout');
  let res: Awaited<ReturnType<typeof supabase.auth.getUser>> | typeof TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      supabase.auth.getUser(),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), 10_000);
      }),
    ]);
  } catch (err) {
    // Thrown transport failure — stay signed in (offline-tolerant).
    console.warn(`[sei] session validation skipped (network): ${(err as Error).message}`);
    return;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (res === TIMEOUT) {
    console.warn('[sei] session validation timed out; keeping session');
    return;
  }
  const error = (res as { error: { status?: number } | null }).error;
  if (!error) return; // valid session
  // Only an auth-layer rejection means "account gone/revoked". A status of 0 or
  // undefined is a transport hiccup → keep the session.
  const status = error.status;
  if (status !== 400 && status !== 401 && status !== 403) {
    console.warn(`[sei] session validation inconclusive (status ${status ?? 'none'}); keeping session`);
    return;
  }
  console.warn('[sei] persisted session invalid (user deleted/revoked) — signing out');
  try {
    await supabase.auth.signOut();
  } catch {
    // Ignore — the forced local transition below is the real sign-out.
  }
  transitionToLocal();
}

export function broadcastAuthState(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IpcChannel.auth.state, currentState);
}

// Named handler for the did-finish-load listener so initAuthState can
// removeListener() on macOS re-bootstrap (BL-02 / IN-05).
function broadcastOnDidFinishLoad(): void {
  broadcastAuthState(mainWindowRef);
}

/**
 * Wire up the Supabase auth-event subscription and replay current state on
 * window refresh. Called ONCE from main/index.ts bootstrap, after the
 * BrowserWindow exists.
 */
export async function initAuthState(window: BrowserWindow): Promise<void> {
  // BL-02: bootstrap() can run more than once on macOS — app.on('activate')
  // calls it again when all windows have been closed and the dock icon is
  // clicked. Drop any prior subscription + did-finish-load listener before
  // rebinding so we don't accumulate auth-event subscribers on each reopen.
  subscription?.unsubscribe();
  subscription = null;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.removeListener('did-finish-load', broadcastOnDidFinishLoad);
  }
  mainWindowRef = window;

  const supabase = getClient();

  // Load the initial session so currentState is correct before the first
  // auth event arrives. getSession() reads from the storage adapter
  // (sessionStore — already wired by bootstrap).
  const { data: { session } } = await supabase.auth.getSession();
  applySession(session);
  // Item 3: begin polling for a cross-device email confirmation if this cold
  // start restored a signed-in-but-unverified session.
  syncEmailVerificationPolling();
  // Fire-and-forget reconciliation on cold-start sign-in. The subscription
  // below detects user-swaps mid-session; this branch handles app-launch
  // with a persisted session, which the onAuthStateChange transition guard
  // would otherwise treat as a no-op.
  if (currentState.kind === 'signed_in') {
    const userId = currentState.user.id;
    // 260606 — proactively validate the persisted session against the server.
    // If the account was deleted/revoked, this auto-signs-out so the user can't
    // get trapped on a blocking gate (e.g. the ToS modal). Fire-and-forget so
    // launch isn't blocked; the renderer briefly shows signed_in then drops to
    // AuthChoice on the broadcast from transitionToLocal().
    void validateSessionOrSignOut();
    void (async () => {
      try {
        const { reconcileLocalOwnershipOnSignIn } = await import(
          '../cloud/reconcileLocalOwnership'
        );
        await reconcileLocalOwnershipOnSignIn(userId);
      } catch (err) {
        console.warn(`[sei] cold-start reconcile failed: ${(err as Error).message}`);
      }
    })();
  }

  // Subscribe.
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    // Events we care about: SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION.
    // PASSWORD_RECOVERY: a reset link landed a recovery session. The normal path
    // is the loopback callback's recovery-flag detection (→ auth:password-recovery
    // push); this event is a belt-and-suspenders fallback for the case where the
    // app restarted between requesting the reset and clicking the link, dropping
    // the in-memory flag. Idempotent with the loopback push (renderer just sets a
    // boolean). It does NOT fire on ordinary launches — only when supabase-js
    // detects a fresh recovery — so there are no false positives.
    if (event === 'PASSWORD_RECOVERY' && mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send(IpcChannel.auth.passwordRecovery);
    }
    const prevUserId = currentState.kind === 'signed_in' ? currentState.user.id : null;
    applySession(session);
    broadcastAuthState(mainWindowRef);
    // Item 3: (re)evaluate the cross-device verification poll on every auth
    // event — start it on a fresh unverified sign-in, stop it once verified or
    // signed out.
    syncEmailVerificationPolling();
    const nextKind = currentState.kind;
    const nextUserId = currentState.kind === 'signed_in' ? currentState.user.id : null;
    // The effective profile scope is the user id (or 'local' when null). A
    // TOKEN_REFRESHED / USER_UPDATED for the SAME user leaves it unchanged.
    const scopeChanged = (prevUserId ?? null) !== (nextUserId ?? null);
    if (scopeChanged) {
      void (async () => {
        // 260603: re-point the local data scope FIRST (tears down the bot,
        // switches paths, seeds a brand-new profile, pushes app:scope-changed)
        // so the reconcile below — and the renderer's re-bootstrap — operate on
        // the new account's bucket, not the previous one.
        try {
          const { switchScopeForAuth } = await import('../profile/profileScope');
          await switchScopeForAuth(nextUserId);
        } catch (err) {
          console.warn(`[sei] scope switch failed: ${(err as Error).message}`);
        }
        // Reconcile only on a genuine sign-in (now within the new scope's dir).
        if (nextKind === 'signed_in' && nextUserId) {
          // 260606 — default the freshly signed-in user to cloud billing. This
          // MUST run here, after switchScopeForAuth, not in the auth handlers:
          // config.json is per-profile (paths.configPath → profileRootDir), and
          // at sign-in/up time the active scope is still 'local', so a write
          // there lands in the wrong profile and is shadowed when the user's
          // profile is seeded with its default ('local'). Gated on scopeChanged
          // so it fires on a genuine sign-in transition — NOT on launch
          // session-restore (same user → scopeChanged false), so a user who
          // deliberately switched to BYOK isn't re-flipped on every reopen.
          // Best-effort: a config write failure must never block sign-in.
          // 260703: routed through applyCloudDefaultForSignIn — an explicit
          // BYOK choice (ai_backend_kind_source === 'user', or a legacy
          // 'local' with a stored key) survives re-login instead of being
          // force-flipped back to cloud billing.
          try {
            const { applyCloudDefaultForSignIn } = await import('../apiKeyStore');
            await applyCloudDefaultForSignIn();
          } catch (err) {
            console.warn(`[sei] sign-in cloud-default failed: ${(err as Error).message}`);
          }
          try {
            const { reconcileLocalOwnershipOnSignIn } = await import(
              '../cloud/reconcileLocalOwnership'
            );
            await reconcileLocalOwnershipOnSignIn(nextUserId);
          } catch (err) {
            console.warn(`[sei] sign-in reconcile failed: ${(err as Error).message}`);
          }
          // Item 7: backfill the public profiles row from the account's local
          // preferred_name on sign-in, so users who onboarded before the
          // profiles table existed still show "by <name>" on Browse. Best-effort.
          try {
            const { loadConfig } = await import('../configStore');
            const cfg = await loadConfig();
            const name = (cfg.preferred_name ?? '').trim();
            if (name) {
              const { upsertMyProfile } = await import('../cloud/cloudCharacterClient');
              await upsertMyProfile(name);
            }
          } catch (err) {
            console.warn(`[sei] sign-in profile backfill failed: ${(err as Error).message}`);
          }
        }
      })();
    }
  });
  subscription = sub.subscription;

  // Replay on renderer reload (same pattern as latestLanState in src/main/index.ts).
  // Use a named handler so we can removeListener() on re-bootstrap (BL-02).
  window.webContents.on('did-finish-load', broadcastOnDidFinishLoad);

  // Initial broadcast so renderer's first onAuthState subscription receives state immediately.
  broadcastAuthState(window);
}

/**
 * Forcibly transition to local. Used by plan 06's synchronous sign-out path
 * AFTER it has called supabase.auth.signOut() and does not want to wait for
 * the SIGNED_OUT event. Tests also call this directly.
 */
export function transitionToLocal(): void {
  currentState = { kind: 'local' };
  broadcastAuthState(mainWindowRef);
}

/**
 * Forcibly transition to signed_in. Reserved for tests; normal flow always
 * goes through the Supabase auth-event stream.
 */
export function transitionToSignedIn(user: AuthUser): void {
  currentState = { kind: 'signed_in', user };
  broadcastAuthState(mainWindowRef);
}

/**
 * Phase 11 (Plan 11-14) — defense-in-depth UX gate for cloud writes.
 *
 * Returns `true` ONLY when ALL of:
 *   - auth state is `signed_in`
 *   - user.emailVerified === true (Phase 10 D-04 + 11-RESEARCH §Pitfall 8 —
 *     verification doesn't block sign-in but DOES block cloud-write)
 *   - tos_acceptance row exists at the current TOS_VERSION + PRIVACY_VERSION
 *     (D-26 / D-27; queried via tosGate.isTosAccepted, Plan 11-12)
 *
 * Fails CLOSED on any error (matches tosGate.isTosAccepted semantics).
 *
 * Note on layered defenses:
 *   - RLS on `characters` / `tos_acceptance` is the SECURITY gate at the DB.
 *   - This function is the UX gate that prevents misleading "syncing…" pills
 *     when the user can't actually sync.
 *
 * Plan 11-08 (syncQueue.processNext) lazy-imports this as its drain-eligibility
 * check, so every cloud-mirror code path consults this single helper.
 *
 * The `isTosAccepted` round-trip is cached for {@link TOS_CACHE_TTL_MS} so that
 * the queue drainer's tick loop doesn't hammer Supabase on every queue item;
 * Plan 11-12's `tos:accept` IPC handler calls {@link invalidateTosCache} after
 * a successful recordAcceptance so the next call re-queries (no stale window).
 */
const TOS_CACHE_TTL_MS = 60_000;
let tosCache: { userId: string; accepted: boolean; cachedAt: number } | null = null;

/**
 * Invalidate the TOS cache. Plan 11-12's `tos:accept` IPC handler MUST call
 * this after recordAcceptance() succeeds so the next isCloudWriteAllowed call
 * re-queries the tos_acceptance table (no stale 60s window in which the user
 * just accepted but the drainer still thinks they haven't).
 */
export function invalidateTosCache(): void {
  tosCache = null;
}

function logCloudWriteDenied(
  reason: 'not_signed_in' | 'email_unverified' | 'tos_not_accepted',
): void {
  // Trace-level logging — keep low-noise. Console is fine for v1.0.
  // T-11-14-04 mitigation: reason carries NO userId / no PII.
  console.log(`[sei] isCloudWriteAllowed: false (reason: ${reason})`);
}

export async function isCloudWriteAllowed(): Promise<boolean> {
  if (currentState.kind !== 'signed_in') {
    logCloudWriteDenied('not_signed_in');
    return false;
  }
  // Email verification check — Pitfall 8.
  // AuthUser.emailVerified is derived from user.email_confirmed_at != null
  // (see toAuthUser above; Supabase normalizes verified=true on USER_UPDATED).
  if (!currentState.user.emailVerified) {
    logCloudWriteDenied('email_unverified');
    return false;
  }

  const userId = currentState.user.id;
  const now = Date.now();

  // Per-user TTL cache. Switching users (userId mismatch) bypasses the cache
  // so a stale entry for a previous account can't suppress the query.
  if (
    tosCache &&
    tosCache.userId === userId &&
    now - tosCache.cachedAt < TOS_CACHE_TTL_MS
  ) {
    if (!tosCache.accepted) logCloudWriteDenied('tos_not_accepted');
    return tosCache.accepted;
  }

  let status: Awaited<ReturnType<typeof getTosAcceptance>>;
  try {
    status = await getTosAcceptance(userId);
  } catch {
    // Fail closed — mirror tosGate's own contract.
    status = 'unknown';
  }
  const accepted = status === 'accepted';
  // 260610 — only cache DEFINITIVE answers. Caching an 'unknown' (offline /
  // DNS hiccup) as false would keep blocking cloud writes for up to 60s after
  // connectivity returns; leaving the cache empty re-queries on the next call.
  if (status !== 'unknown') {
    tosCache = { userId, accepted, cachedAt: now };
  }
  if (!accepted) logCloudWriteDenied('tos_not_accepted');
  return accepted;
}

/** TEST-ONLY helper: tear down the subscription. */
export function _disposeForTests(): void {
  subscription?.unsubscribe();
  subscription = null;
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.removeListener('did-finish-load', broadcastOnDidFinishLoad);
  }
  mainWindowRef = null;
  currentState = { kind: 'local' };
  // Drop any cached TOS state so the next test starts from a known empty cache.
  tosCache = null;
}
