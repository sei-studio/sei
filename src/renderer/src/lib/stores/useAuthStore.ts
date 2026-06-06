/**
 * useAuthStore — renderer-side mirror of main's AuthState, plus the
 * D-10 upgrade-modal framing micro-copy slot.
 *
 * Subscribes to main's auth-state push channel ONCE at App.tsx mount via the
 * exported subscriber below. Plans 04–09 read s.state to drive routing,
 * conditional Banners, and Account-panel visibility.
 *
 * Source: 10-CONTEXT D-06, D-10. 10-UI-SPEC §Inline upgrade modal.
 */
import { create } from 'zustand';
import { sei } from '../ipcClient';
import type { AuthState } from '@shared/ipc';

// LR-02 — Plan 11-12 has shipped (`sei.tosStatus()` is now part of RendererApi),
// so the parallel-worktree `TosStatusBridge` cast that used to live here is no
// longer load-bearing. Removed; sei is consumed directly.

/**
 * Plan 11-15 — pending share intent.
 *
 * When a signed-out user clicks the public/private toggle on a character page
 * (D-17), the toggle handler opens SignInModal with framingLabel='share this
 * character'. The character.id is captured in `pendingShareIntent` so that the
 * post-sign-in auth-state transition can fire `sei.charsSetShared({id, shared:true})`
 * automatically — completing the upgrade-to-share UX in one continuous flow.
 *
 * Lifecycle:
 *   - set by CharacterPage.onToggleShared when authState.kind !== 'signed_in'
 *   - consumed by subscribeAuthState on transition to signed_in AFTER tosAccepted
 *     resolves to true (Plan 11-13 ToS gate runs first; if ToS is pending, the
 *     pending intent stays parked until refreshTosStatus() flips tosAccepted=true,
 *     at which point the consumeShareIntent() helper fires)
 *   - cleared on transition to local (T-11-15-02 mitigation — no cross-session leak)
 *   - cleared on SignInModal dismissal without sign-in (MR-01) so a future
 *     unrelated sign-in does not unexpectedly toggle this character public
 *   - dropped at consume time if older than PENDING_SHARE_INTENT_TTL_MS
 *     (MR-01 defense-in-depth — an intent parked hours ago in a different
 *     context should not silently fire)
 *
 * `createdAt` is an epoch-ms timestamp captured at the moment the intent was
 * set. Null is treated as "no intent" by all consumers.
 */
export type PendingShareIntent = { characterId: string; createdAt: number } | null;

/**
 * MR-01 — share intents older than this are dropped at consume time. The
 * happy path completes within ~30s (sign-in form + email verify + ToS modal),
 * so 5 minutes is comfortably above legitimate timing while still bounding
 * "user dismissed the modal hours ago, signed in for an unrelated reason"
 * leakage. The same intent is also cleared on modal dismissal (see
 * CharacterPage.tsx); TTL is defense-in-depth for the path where the user
 * leaves the modal open and switches contexts via a different code path.
 */
export const PENDING_SHARE_INTENT_TTL_MS = 5 * 60 * 1000;

/**
 * D-10 framing micro-copy. Null when SignInModal is opened directly from
 * AuthChoiceScreen; set to one of the three feature labels when opened via
 * the inline-upgrade flow (plan 07+).
 */
export type UpgradeFraming =
  | null
  | 'browse public characters'
  | 'use cloud-hosted AI'
  | 'share this character'
  // Item 5 — a signed-out user tapping "Add to library" on a World character
  // gets the same sign-in modal as the share flow, framed for this action.
  | 'add this character to your library';

interface AuthStore {
  state: AuthState;
  upgradeFraming: UpgradeFraming;
  /**
   * Phase 11 D-26 — tristate gate for the blocking AcceptToSModal:
   *   - null  → status unknown (initial load, or a tosStatus() call failed)
   *   - true  → user has a current-version tos_acceptance row
   *   - false → user is signed in but lacks a current-version acceptance row;
   *             App.tsx mounts AcceptToSModal as a top-level overlay
   *
   * Refreshed by `refreshTosStatus` on every transition into signed_in and
   * after a successful sei.tosAccept() submit. Reset to null on signed_in →
   * local.
   */
  tosAccepted: boolean | null;
  /**
   * Plan 11-15 D-17 — pending share intent captured when a signed-out user
   * attempts to flip the public/private toggle to public. Consumed after the
   * subsequent sign-in (and ToS acceptance) transition; see `consumeShareIntent`.
   */
  pendingShareIntent: PendingShareIntent;
  /**
   * True after a password-reset link lands a recovery session (main pushes
   * auth:password-recovery). App.tsx mounts SetNewPasswordModal while true;
   * the modal flips it back to false on success or dismissal. Also cleared on
   * any transition to `local` so it can't survive a sign-out.
   */
  passwordRecovery: boolean;
  setUpgradeFraming: (v: UpgradeFraming) => void;
  refreshTosStatus: () => Promise<void>;
  setPendingShareIntent: (intent: PendingShareIntent) => void;
  setPasswordRecovery: (v: boolean) => void;
  _setState: (s: AuthState) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  // Until the first onAuthState push fires, default to local. Main always
  // pushes initial state during initAuthState — typically within a frame of
  // window load — so this default is short-lived.
  state: { kind: 'local' },
  upgradeFraming: null,
  tosAccepted: null,
  pendingShareIntent: null,
  passwordRecovery: false,
  setUpgradeFraming: (v) => set({ upgradeFraming: v }),
  refreshTosStatus: async (): Promise<void> => {
    try {
      const s = await sei.tosStatus();
      set({ tosAccepted: s.accepted });
      // Plan 11-15: a successful ToS acceptance unblocks any parked share
      // intent. Try to consume it now so the upgrade-to-share UX completes
      // without the user needing to re-toggle.
      if (s.accepted) {
        void consumeShareIntent();
      }
    } catch {
      // Fail-closed-but-non-blocking: leave tosAccepted as null. App.tsx only
      // mounts the modal when tosAccepted === false, so a null keeps existing
      // routes rendering; a transient network failure won't trap the user on
      // an empty screen. The next sign-in / explicit refresh tries again.
      set({ tosAccepted: null });
    }
  },
  setPendingShareIntent: (intent) => set({ pendingShareIntent: intent }),
  setPasswordRecovery: (v) => set({ passwordRecovery: v }),
  _setState: (s) => set({ state: s }),
}));

/**
 * Plan 11-15 — fire `sei.charsSetShared({id, shared:true})` for a parked share
 * intent, then clear it. Safe to call any time; no-op when there's no intent or
 * when the user isn't signed in / ToS-accepted.
 *
 * Idempotency (T-11-15-03): charsSetShared is a Postgres upsert; re-firing with
 * the same value is a no-op. We clear the intent unconditionally on the success
 * path so a transient renderer crash mid-handler doesn't leave a stuck intent.
 */
async function consumeShareIntent(): Promise<void> {
  const { pendingShareIntent, state, tosAccepted } = useAuthStore.getState();
  if (!pendingShareIntent) return;
  if (state.kind !== 'signed_in') return;
  if (tosAccepted !== true) return;
  // MR-01: drop stale intents. A user who toggled hours ago in a different
  // context, then signed in today for an unrelated reason, should NOT have
  // that old character silently flipped to public. The modal-dismissal clear
  // in CharacterPage handles the common case; this is defense-in-depth.
  if (Date.now() - pendingShareIntent.createdAt > PENDING_SHARE_INTENT_TTL_MS) {
    useAuthStore.setState({ pendingShareIntent: null });
    return;
  }
  try {
    await sei.charsSetShared({ id: pendingShareIntent.characterId, shared: true });
  } catch (err) {
    // Best-effort: the user can re-toggle from the character page. Surfacing
    // an error here would require a renderer-wide toast pipeline we don't have
    // yet for cloud-mirror failures; the sync-pill story in HomeScreen covers
    // the persistent-failure surface.
    console.warn(`[useAuthStore] pending share intent failed: ${(err as Error).message}`);
  } finally {
    useAuthStore.setState({ pendingShareIntent: null });
  }
}

/**
 * Subscribe once to main's auth:state push. Returns the unsubscribe function
 * so App.tsx can clean up on unmount (in practice App is never unmounted
 * during the app lifetime, but the cleanup keeps the contract honest under
 * Strict-Mode double-invoke).
 *
 * Phase 11 D-26 side-effect: every transition into `signed_in` triggers
 * refreshTosStatus() so App.tsx can decide whether to mount the blocking
 * AcceptToSModal. Every transition into `local` clears tosAccepted back to
 * null (a signed-out user has no acceptance state to surface).
 */
export function subscribeAuthState(): () => void {
  const unsubState = sei.onAuthState((s) => {
    const store = useAuthStore.getState();
    const prevKind = store.state.kind;
    store._setState(s);
    if (s.kind === 'signed_in' && prevKind !== 'signed_in') {
      // Refresh ToS status first; if accepted, refreshTosStatus chains into
      // consumeShareIntent() so the Plan 11-15 upgrade-to-share UX fires
      // automatically after sign-in.
      void store.refreshTosStatus();
    } else if (s.kind === 'local' && prevKind !== 'local') {
      // T-11-15-02 mitigation: clear any pending share intent on sign-out so
      // it can't leak across sessions (e.g. user A toggles share while signed
      // out, signs in as user B — the intent would otherwise point at user A's
      // local character id). Also drop any stale recovery-prompt flag.
      useAuthStore.setState({
        tosAccepted: null,
        pendingShareIntent: null,
        passwordRecovery: false,
      });
    }
  });
  // Password-reset link landed a recovery session — surface SetNewPasswordModal.
  // The recovery exchange in main also fired SIGNED_IN, so onAuthState above has
  // already routed the user into the app; this just raises the new-password
  // prompt on top.
  const unsubRecovery = sei.onPasswordRecovery(() => {
    useAuthStore.setState({ passwordRecovery: true });
  });
  return () => {
    unsubState();
    unsubRecovery();
  };
}
