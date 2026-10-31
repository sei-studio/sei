/**
 * The first view after launch (App.tsx's boot effect), as plain functions so
 * the auth part of the decision is testable without rendering App.
 *
 * Pitfall A8 routing (Phase 10) plus 260603 / 260728 / 260729:
 *   signed in, profile has no preferred_name -> onboarding scene (fresh account)
 *   signed in, skin setup still pending      -> skin-setup
 *   signed in, onboarded                     -> home (or a saved tutorial step)
 *   signed out, nothing configured           -> onboarding scene (fresh install)
 *   signed out, onboarded                    -> the scene's sign-in panel
 *
 * T283: a profile with no name that main says was set up before (`returning`:
 * its settings were recovered to defaults) is never sent to onboarding:
 * signed in it goes home, signed out to the sign-in panel.
 */
import type { AuthSnapshot, AuthState } from '@shared/ipc';

export type BootDestination = 'onboard' | 'skin-setup' | 'home' | 'signin';

export interface BootProfile {
  onboardedName: string;
  skinPending: boolean;
  /** T283: set up before even though the config has no name (lib/profileSetUp.ts). */
  returning?: boolean;
}

export function bootDestination(auth: AuthState, profile: BootProfile): BootDestination {
  const setUp = Boolean(profile.onboardedName) || profile.returning === true;
  if (auth.kind === 'signed_in') {
    if (!profile.onboardedName) return setUp ? 'home' : 'onboard';
    return profile.skinPending ? 'skin-setup' : 'home';
  }
  return setUp ? 'signin' : 'onboard';
}

export interface BootRouteDeps {
  /** authBoot.waitForAuthScope, already bound to the boot's cancel flag. */
  waitForScope: () => Promise<{ snapshot: AuthSnapshot | null; waited: boolean }>;
  /** Apply main's state to the renderer store (useAuthStore.applyAuthState). */
  applyAuthState: (s: AuthState) => void;
  /** The renderer store's state (main's pushes). */
  currentAuth: () => AuthState;
  /** Read the active profile again; false = the boot was cancelled. */
  rehydrate: () => Promise<boolean>;
  /** An app:scope-changed push landed after the boot first read the profile. */
  scopeChangedSinceHydrate: () => boolean;
  /** What the (latest) profile read found. */
  profile: () => BootProfile;
  isCancelled: () => boolean;
}

/**
 * Where the boot routing goes, or null when the boot was cancelled.
 *
 * 261029: routes on MAIN's auth state, not on the store's `local` default plus
 * whatever pushes happened to land by then. A snapshot main gave before it had
 * loaded its own state (`loaded: false`, the bound passed) is never applied:
 * its `local` is a default, and applying it would overwrite a signed-in push.
 * The pushes in the store are what is left to route on then. When the profile
 * may have moved while the boot waited, it is read again first, or the route
 * is decided on the previous profile.
 */
export async function resolveBootRoute(deps: BootRouteDeps): Promise<BootDestination | null> {
  const { snapshot, waited } = await deps.waitForScope();
  if (deps.isCancelled()) return null;
  if (snapshot && snapshot.loaded) deps.applyAuthState(snapshot.state);
  if ((waited || deps.scopeChangedSinceHydrate()) && !(await deps.rehydrate())) return null;
  if (deps.isCancelled()) return null;
  return bootDestination(deps.currentAuth(), deps.profile());
}
