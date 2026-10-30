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
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { dropSessionLocally, getClient, readPersistedSession } from './supabaseClient';
import { getTosAcceptance } from './tosGate';
import { getActiveScope, SCOPE_LOCAL } from '../paths';
import { isScopeSwitchPending } from '../profile/scopeBarrier';
import { IpcChannel, type AuthSnapshot, type AuthState, type AuthUser } from '../../shared/ipc';

let currentState: AuthState = { kind: 'local' };
let mainWindowRef: BrowserWindow | null = null;
let subscription: { unsubscribe: () => void } | null = null;

/**
 * 261029 (login lock on restart). The profile scope the auth layer last asked
 * for, and the switch moving the data scope there. See followAuthScope.
 */
let requestedScope: string | null = null;
let scopeSwitchInFlight: Promise<void> | null = null;
/**
 * Number of the latest followAuthScope request. A request's follow-up steps
 * run only while it is still the latest one, so sign-in A, sign-out, sign-in A
 * in quick succession runs them once, for the last request, and never for a
 * request whose profile move another one has since replaced.
 */
let scopeRequestSeq = 0;
/** Follow-up passes still running (tests wait on these). */
const followUps = new Set<Promise<void>>();
/**
 * The account a real sign-in (a new session, not the stored one coming back)
 * still owes its sign-in steps to: cloud default, profile backfill, the
 * `signed_in` event, the roster sync. Consumed by the first follow-up pass
 * that runs on that account's profile, whether or not the profile had to move.
 */
let signInStepsOwed: string | null = null;
/** The stored session's access token at init, and the newest one seen since. */
let restoredAccessToken: string | null = null;
let lastAccessToken: string | null = null;
/** Bumped on every auth event, so an async check can tell a newer event landed. */
let authEventSeq = 0;
/** The next sign-out is one the user asked for (noteUserSignOut). */
let userSignOutRequested = false;

/**
 * 261029: the user asked to sign out (the sign-out button, account deletion).
 * Call before supabase signOut(); every other sign-out is tagged
 * `reason: 'session_rejected'` in analytics.
 */
export function noteUserSignOut(): void {
  userSignOutRequested = true;
}

/** Resolves once initAuthState has loaded the persisted session (or failed to). */
let authLoaded = false;
let resolveAuthInit: () => void = () => {};
let authInit: Promise<void> = new Promise<void>((r) => {
  resolveAuthInit = r;
});

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
 * `initAuthState`'s first state is read from the local storage adapter alone
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
    const { error: signOutError } = await supabase.auth.signOut();
    // 261029: signOut() reports a failed logout request in its result, it
    // does not throw, and then it keeps the stored session. Drop it here.
    if (signOutError) await dropSessionLocally({ client: supabase });
  } catch {
    await dropSessionLocally({ client: supabase });
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

/** The profile scope an auth state belongs in: the user's id, or null for 'local'. */
function scopeFor(state: AuthState): string | null {
  return state.kind === 'signed_in' ? state.user.id.toLowerCase() : null;
}

function activeScopeUser(): string | null {
  const scope = getActiveScope();
  return scope === SCOPE_LOCAL ? null : scope;
}

/**
 * Move the data scope to where the current auth state says it belongs, when it
 * is not there already (or on its way there). Returns true when it started a
 * switch. Never throws; a failed switch is retried by the next auth event,
 * since the scope still disagrees with the state then.
 *
 * `restored` marks a move that is not someone signing in or out (cold start, a
 * token refresh that brought back a session the boot read missed): the push
 * says so, so the renderer offers no local import, and a move to 'local' sends
 * no `signed_out`. Sign-in steps run only when a real sign-in owes them
 * (signInStepsOwed), wherever the move came from.
 */
function followAuthScope(opts: { restored: boolean }): boolean {
  const target = scopeFor(currentState);
  const current = scopeSwitchInFlight ? requestedScope : activeScopeUser();
  if (current === target) return false;
  const seq = ++scopeRequestSeq;
  requestedScope = target;
  const restoredMove = target ? signInStepsOwed !== target : opts.restored;
  const switched = (async (): Promise<boolean> => {
    try {
      const { switchScopeForAuth } = await import('../profile/profileScope');
      await switchScopeForAuth(target, { restored: restoredMove });
      return true;
    } catch (err) {
      console.warn(`[sei] scope switch failed: ${(err as Error).message}`);
      return false;
    }
  })();
  const tracked: Promise<void> = switched.then(
    () => {},
    () => {},
  );
  scopeSwitchInFlight = tracked;
  void tracked.finally(() => {
    if (scopeSwitchInFlight === tracked) scopeSwitchInFlight = null;
  });
  trackFollowUp(
    switched.then(async (ok) => {
      // The move threw (the next auth event retries it), a later request
      // replaced this one (its own pass runs), or the scope is not where this
      // request asked for: nothing to follow up here.
      if (!ok || seq !== scopeRequestSeq || activeScopeUser() !== target) return;
      await afterScopeSwitch(target, opts);
    }),
  );
  return true;
}

function trackFollowUp(p: Promise<void>): void {
  const t = p.catch((err) => console.warn(`[sei] auth follow-up failed: ${(err as Error).message}`));
  followUps.add(t);
  void t.finally(() => followUps.delete(t));
}

/**
 * A real sign-in landed on an account whose profile is already active (or
 * already on its way there): no move will run its steps, so run them here.
 * When a move to it is in flight, that move's pass consumes them instead.
 */
function runOwedSignInSteps(): void {
  const target = scopeFor(currentState);
  if (!target || signInStepsOwed !== target) return;
  if (scopeSwitchInFlight || activeScopeUser() !== target) return;
  const seq = scopeRequestSeq;
  trackFollowUp(
    (async () => {
      if (seq !== scopeRequestSeq || activeScopeUser() !== target) return;
      await afterScopeSwitch(target, { restored: false });
    })(),
  );
}

/** What a sign-in or sign-out does once the data scope points at the new account. */
async function afterScopeSwitch(target: string | null, opts: { restored: boolean }): Promise<void> {
  if (target) {
    // Sign-in steps once per real sign-in (signInStepsOwed); a restored
    // session only gets the reconcile passes.
    const signIn = signInStepsOwed === target;
    if (signIn) signInStepsOwed = null;
    // 260606: default the freshly signed-in user to cloud billing, after the
    // switch (config.json is per-profile). An explicit BYOK choice survives
    // (applyCloudDefaultForSignIn, 260703). profileScope's switch runs the same
    // call before its push; this one is the backstop (and the only one when
    // the profile did not have to move). Best-effort.
    if (signIn) {
      try {
        const { applyCloudDefaultForSignIn } = await import('../apiKeyStore');
        await applyCloudDefaultForSignIn();
      } catch (err) {
        console.warn(`[sei] sign-in cloud-default failed: ${(err as Error).message}`);
      }
    }
    // Reconcile within the new scope's dir (also the cold-start reconcile for
    // a restored session, which initAuthState leaves to this pass when the
    // scope had to move first).
    try {
      const { reconcileLocalOwnershipOnSignIn } = await import('../cloud/reconcileLocalOwnership');
      await reconcileLocalOwnershipOnSignIn(target);
    } catch (err) {
      console.warn(`[sei] sign-in reconcile failed: ${(err as Error).message}`);
    }
    // Auto-remoderate-on-reset: restore any shared characters whose
    // moderation_status was reset to null. Fire-and-forget, no-op while
    // moderation is off. Never blocks the sign-in transition.
    try {
      const { remoderateResetSharedCharactersOnSignIn } = await import('../ipc');
      void remoderateResetSharedCharactersOnSignIn(target);
    } catch (err) {
      console.warn(`[sei] sign-in remoderate-on-reset failed: ${(err as Error).message}`);
    }
    if (!signIn) return;
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
    // Analytics (260707): identify the account (aliases the prior
    // anonymous install id into it) and mark a genuine sign-in.
    try {
      const { identifyUser, capture } = await import('../analytics');
      identifyUser(target);
      capture('signed_in');
    } catch { /* best-effort */ }
    // Roster mirror (260801): reconcile the whole Home roster, not just
    // the deltas the four library IPC handlers report. This is the pass
    // that backfills an install whose roster predates the
    // character_library table, and the safety net for every other writer
    // (the one-shot config migrations, onboarding's Sui seed, the
    // unpublish reconcile sweep), none of which has to know this
    // mirror exists.
    try {
      void (await import('../cloud/librarySync')).syncLibraryRoster('sign-in');
    } catch { /* best-effort */ }
  } else {
    // Sign-out transition: mark it, then detach from the account so
    // subsequent events revert to the anonymous install id.
    try {
      const { capture, resetUser } = await import('../analytics');
      // A sign-out nobody asked for (the auth server refused the session at
      // launch or on a refresh, or the account was revoked) is tagged, so it
      // does not read as a user signing out.
      if (!opts.restored) {
        const byUser = userSignOutRequested;
        userSignOutRequested = false;
        capture('signed_out', byUser ? undefined : { reason: 'session_rejected' });
      }
      resetUser();
    } catch { /* best-effort */ }
  }
}

/**
 * 261029: what the renderer needs to route at boot without racing main's
 * pushes. `scopeReady` is true once the data scope matches the auth state and
 * no switch is pending, i.e. the app:scope-changed push for this state (if one
 * was needed) has already gone out. `scope` is the active profile scope, so a
 * caller can check it is the account it expects. Waits for initAuthState's
 * first state (`loaded`), which comes from storage and needs no network, so
 * the bound only matters when bootstrap has not reached initAuthState yet.
 */
export async function getAuthSnapshot(waitMs = 30_000): Promise<AuthSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    authInit,
    new Promise<void>((r) => {
      timer = setTimeout(r, waitMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const scopeReady =
    authLoaded &&
    scopeSwitchInFlight === null &&
    !isScopeSwitchPending() &&
    activeScopeUser() === scopeFor(currentState);
  return { state: currentState, scopeReady, loaded: authLoaded, scope: getActiveScope() };
}

/**
 * Wire up the Supabase auth-event subscription and replay current state on
 * window refresh. Called ONCE from main/index.ts bootstrap, after the
 * BrowserWindow exists.
 */
export async function initAuthState(window: BrowserWindow): Promise<void> {
  try {
    await initAuthStateInner(window);
  } finally {
    // getAuthSnapshot callers wait for this, success or not.
    authLoaded = true;
    resolveAuthInit();
  }
}

async function initAuthStateInner(window: BrowserWindow): Promise<void> {
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

  // 261029 review: the first state comes from the STORED session, with no
  // network. `auth.getSession()` refreshes an expired access token (the usual
  // state after a restart) and waits for supabase-js's own startup refresh
  // first: offline that measured ~51 s (two full ~25 s retry windows), during
  // which the renderer had nothing to route on and the subscription below did
  // not exist yet, so a sign-in made then was lost. Offline users must keep
  // working (validateSessionOrSignOut's rule), so a stored session is signed
  // in until the auth server says otherwise; supabase-js's session load
  // reports that through the subscription (SIGNED_OUT, or the INITIAL_SESSION
  // handled in onAuthEvent).
  let stored: Awaited<ReturnType<typeof readPersistedSession>> = null;
  try {
    stored = await readPersistedSession({ client: supabase });
  } catch (err) {
    console.warn(`[sei] reading the stored session failed: ${(err as Error).message}`);
  }
  restoredAccessToken = stored?.accessToken ?? null;
  lastAccessToken = restoredAccessToken;
  currentState = stored ? { kind: 'signed_in', user: toAuthUser(stored.user) } : { kind: 'local' };

  // Subscribe before anything waits on the network.
  const { data: sub } = supabase.auth.onAuthStateChange(onAuthEvent);
  subscription = sub.subscription;

  // Replay on renderer reload (same pattern as latestLanState in src/main/index.ts).
  // Use a named handler so we can removeListener() on re-bootstrap (BL-02).
  window.webContents.on('did-finish-load', broadcastOnDidFinishLoad);

  // Initial broadcast so renderer's first onAuthState subscription receives state immediately.
  broadcastAuthState(window);

  // Item 3: begin polling for a cross-device email confirmation if this cold
  // start restored a signed-in-but-unverified session.
  syncEmailVerificationPolling();
  if (currentState.kind === 'signed_in') {
    const userId = currentState.user.id;
    // Analytics (260707): attribute this restored session to the account so
    // events (incl. app_opened, fired just after init) carry the user id.
    void import('../analytics').then((a) => a.identifyUser(userId)).catch(() => {});
    // 260606 — proactively validate the persisted session against the server.
    // If the account was deleted/revoked, this auto-signs-out so the user can't
    // get trapped on a blocking gate (e.g. the ToS modal). Fire-and-forget so
    // launch isn't blocked; the renderer briefly shows signed_in then drops to
    // the sign-in panel on the broadcast from transitionToLocal().
    void validateSessionOrSignOut();
  }
  // 261029: the boot scope (main/index.ts step 0a) reads the same stored
  // session, so normally this is a no-op. Builds before 261029 picked it with
  // a refresh of their own that could fail; anything else that left the scope
  // off the state is corrected here. The switch pushes app:scope-changed and
  // runs the reconcile below itself.
  const switching = followAuthScope({ restored: true });
  if (currentState.kind === 'signed_in' && !switching) {
    const userId = currentState.user.id;
    void (async () => {
      try {
        const { reconcileLocalOwnershipOnSignIn } = await import(
          '../cloud/reconcileLocalOwnership'
        );
        await reconcileLocalOwnershipOnSignIn(userId);
      } catch (err) {
        console.warn(`[sei] cold-start reconcile failed: ${(err as Error).message}`);
      }
      // Auto-remoderate-on-reset: restore any of this user's shared characters
      // whose moderation_status was reset to null. Fire-and-forget (may call
      // moderation Edge Functions when enabled) and a no-op while moderation is
      // off. Never blocks launch.
      try {
        const { remoderateResetSharedCharactersOnSignIn } = await import('../ipc');
        void remoderateResetSharedCharactersOnSignIn(userId);
      } catch (err) {
        console.warn(`[sei] cold-start remoderate-on-reset failed: ${(err as Error).message}`);
      }
    })();
  }
}

function onAuthEvent(event: AuthChangeEvent, session: Session | null): void {
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
  const seq = ++authEventSeq;
  // 261029 review: supabase-js answers INITIAL_SESSION with null when its
  // session load FAILED, too (an offline refresh), not only when there is no
  // session. A refresh that failed for a network reason keeps the session in
  // storage; one the server refused removes it (and emits SIGNED_OUT). So the
  // storage says which: still there means offline, and the user stays signed
  // in on their own profile until a later refresh gets through.
  if (event === 'INITIAL_SESSION' && !session && currentState.kind === 'signed_in') {
    void (async () => {
      let still: Awaited<ReturnType<typeof readPersistedSession>> = null;
      try {
        still = await readPersistedSession({ client: getClient() });
      } catch {
        still = null;
      }
      if (seq !== authEventSeq) return; // a newer event already decided
      if (still && currentState.kind === 'signed_in' && still.userId === currentState.user.id.toLowerCase()) {
        console.warn('[sei] session load failed (offline?); keeping the stored session');
        return;
      }
      applyAuthEvent(event, null);
    })();
    return;
  }
  applyAuthEvent(event, session);
}

function applyAuthEvent(event: AuthChangeEvent, session: Session | null): void {
  const token = session?.access_token ?? null;
  // A real sign-in brings a session this process has not seen. supabase-js
  // also emits SIGNED_IN for the stored session coming back (its startup
  // recovery), which is not someone signing in. A password-reset session
  // arrives as PASSWORD_RECOVERY instead of SIGNED_IN (verifyOtp type
  // 'recovery', and a PKCE recovery link), and it is a sign-in too.
  const realSignIn =
    (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') &&
    token !== null &&
    token !== restoredAccessToken &&
    token !== lastAccessToken;
  if (token) lastAccessToken = token;
  applySession(session);
  if (currentState.kind !== 'signed_in') {
    signInStepsOwed = null;
    lastAccessToken = null;
  } else if (realSignIn) {
    signInStepsOwed = currentState.user.id.toLowerCase();
    userSignOutRequested = false;
  }
  broadcastAuthState(mainWindowRef);
  // Item 3: (re)evaluate the cross-device verification poll on every auth
  // event — start it on a fresh unverified sign-in, stop it once verified or
  // signed out.
  syncEmailVerificationPolling();
  // 261029: the data scope follows the auth state itself, not the change
  // between two auth events. The old test (previous user !== next user)
  // missed every case where the scope was already wrong when the event
  // arrived, e.g. main/index.ts step 0a set 'local' because its token
  // refresh failed while initAuthState's succeeded, which left the app
  // signed in with no app:scope-changed push and the sign-in panel waiting
  // for one forever. A TOKEN_REFRESHED / USER_UPDATED for the same user with
  // the scope already on that user is still a no-op. Only a real sign-in
  // (SIGNED_IN or PASSWORD_RECOVERY with a new token) and SIGNED_OUT are
  // someone signing in or out; any other event that moves the scope is a
  // session coming back (a refresh after an offline launch).
  const moved = followAuthScope({ restored: !realSignIn && event !== 'SIGNED_OUT' });
  // A real sign-in onto the profile that is already active still runs its
  // sign-in steps (cloud default, backfill, signed_in, roster sync) once.
  if (!moved && realSignIn) runOwedSignInSteps();
}

/**
 * Forcibly transition to local. Used by plan 06's synchronous sign-out path
 * AFTER it has called supabase.auth.signOut() and does not want to wait for
 * the SIGNED_OUT event. Tests also call this directly.
 */
export function transitionToLocal(): void {
  currentState = { kind: 'local' };
  signInStepsOwed = null;
  lastAccessToken = null;
  broadcastAuthState(mainWindowRef);
  syncEmailVerificationPolling();
  // 261029: a forced sign-out must move the scope too. Normally signOut()'s
  // SIGNED_OUT event already did (then this is a no-op); when signOut() failed
  // before emitting it, the scope stayed on the old account, and a later
  // sign-in as that same account found nothing to switch.
  followAuthScope({ restored: false });
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
  stopEmailVerificationPoll();
  requestedScope = null;
  scopeSwitchInFlight = null;
  followUps.clear();
  scopeRequestSeq = 0;
  signInStepsOwed = null;
  restoredAccessToken = null;
  lastAccessToken = null;
  authEventSeq = 0;
  userSignOutRequested = false;
  authLoaded = false;
  authInit = new Promise<void>((r) => {
    resolveAuthInit = r;
  });
}

/** TEST-ONLY: resolves once the scope switch in flight (if any) and its follow-up steps have finished. */
export async function _scopeSwitchSettledForTests(): Promise<void> {
  for (let i = 0; i < 10 && (scopeSwitchInFlight || followUps.size > 0); i++) {
    await scopeSwitchInFlight;
    await Promise.all([...followUps]);
  }
}
