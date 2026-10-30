/**
 * 261029 (login lock on restart): when the onboarding sign-in panel may move
 * on. A sign-in is done for the panel once main is signed in as that account
 * AND the active profile is that account's: the scene then reads the
 * account's config (has it set up before?) and the scope-changed reload has
 * already run.
 *
 * Two signals say the profile is live: the `app:scope-changed` push, and
 * main's snapshot (for a panel that mounted after the push, or when no push
 * is coming because the profile was already right). Both must name THIS
 * account: a move onto account A says nothing about a sign-in as B (review,
 * 261029: the old check was only `reason !== 'sign-out'`).
 *
 * Plain object over refs so OnboardApp keeps reading `authRef.current` /
 * `scopeReadyRef.current` where it always did, and so the rules are testable
 * without a DOM.
 */
import type { AuthSnapshot, AuthState, ScopeChangedEvent } from '@shared/ipc';

export interface MutableRef<T> {
  current: T;
}

/** True when `scope` is the profile of the signed-in account in `auth`. */
export function scopeIsAccount(scope: string | null | undefined, auth: AuthState): boolean {
  return auth.kind === 'signed_in' && typeof scope === 'string' && scope.toLowerCase() === auth.user.id.toLowerCase();
}

/** The snapshot shows main signed in as `auth`'s account, on that account's profile. */
export function snapshotConfirmsAccount(snap: AuthSnapshot | null, auth: AuthState): boolean {
  if (!snap || auth.kind !== 'signed_in' || snap.state.kind !== 'signed_in') return false;
  if (snap.state.user.id.toLowerCase() !== auth.user.id.toLowerCase()) return false;
  return snap.scopeReady && scopeIsAccount(snap.scope, auth);
}

export interface SignInScopeGate {
  /** An `auth:state` push. */
  onAuth(s: AuthState): void;
  /** An `app:scope-changed` push. */
  onScopeChanged(ev: ScopeChangedEvent): void;
  /** Ask main whether the signed-in account's profile is live (single-flight, bounded retries). */
  confirm(): void;
  dispose(): void;
}

export const CONFIRM_RETRY_MS = 500;
export const CONFIRM_RETRIES = 40;

export function createSignInScopeGate(deps: {
  auth: MutableRef<AuthState>;
  ready: MutableRef<boolean>;
  readSnapshot: () => Promise<AuthSnapshot | null>;
  /** Re-render: the auth state or readiness changed. */
  onChange: () => void;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}): SignInScopeGate {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = deps.retries ?? CONFIRM_RETRIES;
  let disposed = false;
  let confirming = false;

  const confirm = (): void => {
    if (disposed || confirming || deps.ready.current || deps.auth.current.kind !== 'signed_in') return;
    confirming = true;
    void (async () => {
      try {
        for (let i = 0; i <= retries; i++) {
          if (i > 0) await sleep(CONFIRM_RETRY_MS);
          const snap = await deps.readSnapshot();
          if (disposed || deps.ready.current) return;
          const auth = deps.auth.current;
          if (auth.kind !== 'signed_in') return;
          if (snapshotConfirmsAccount(snap, auth)) {
            deps.auth.current = snap!.state;
            deps.ready.current = true;
            deps.onChange();
            return;
          }
          // No bridge, or main is not signed in at all: the next auth push
          // asks again. Otherwise a switch is still moving: ask again shortly.
          if (!snap || (snap.loaded && snap.state.kind !== 'signed_in')) return;
        }
      } finally {
        confirming = false;
      }
    })();
  };

  return {
    onAuth(s) {
      const prev = deps.auth.current;
      deps.auth.current = s;
      const sameAccount =
        s.kind === 'signed_in' && prev.kind === 'signed_in' && prev.user.id.toLowerCase() === s.user.id.toLowerCase();
      if (!sameAccount) deps.ready.current = false;
      deps.onChange();
      confirm();
    },
    onScopeChanged(ev) {
      const mine = scopeIsAccount(ev.scope, deps.auth.current);
      if (mine === deps.ready.current) return;
      deps.ready.current = mine;
      deps.onChange();
    },
    confirm,
    dispose() {
      disposed = true;
    },
  };
}
