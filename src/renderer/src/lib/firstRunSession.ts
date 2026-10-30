/**
 * First-run session (261029): whether this app session is someone's first
 * one, which holds the startup popup back until the next launch.
 *
 * Why a whole-session rule and not "wait until the tour is over": the first
 * session is a guided sequence (the Sui onboarding scene, the tour, then the
 * first moment in the companion's chat) with calm gaps the per-moment check
 * (popupUiReady) cannot see as part of it:
 *   - a tour that ends without a first moment (no companion to hand off to,
 *     or the seeded Sui never arrived) leaves the player on Home, calm, a
 *     second after the tour's goodbye;
 *   - after the first-moment card, the player's first trip back to Home is
 *     calm, and it is where they decide what to try next;
 *   - a tour quit mid-way resumes only once boot routing has read the config
 *     and loaded the characters, and for a signed-in profile the auth-state
 *     effect puts Home up before that. On a slow boot Home is calm long
 *     enough for the popup's first look (1.5 s), and the resumed tour then
 *     opens over it.
 * An operator announcement in any of those spots competes with onboarding.
 * Nothing is lost by waiting: the popup is only recorded as shown once it
 * really showed, so it is still owed and appears on the next launch.
 *
 * A session counts as first-run once any of these is seen:
 *   - the full Sui onboarding scene (view 'onboard' without `signin`; the
 *     sign-in variant is the everyday "Continue locally" screen of a
 *     signed-out profile and does not count), or the legacy 'onboarding'
 *     screen. The skin-setup screen does NOT count: since 260725 it is the
 *     first trip to Minecraft, not part of onboarding;
 *   - the tour running (useTutorialStore.active), including a resumed one;
 *   - the guided first moment armed (useFirstMomentStore.status);
 *   - a persisted, unfinished tour in config (`tutorial_state`), which boot
 *     routing is about to resume. StartupPopup reads the config and calls
 *     markFirstRunSession() before its first look, so the resume gap at boot
 *     is covered too.
 *
 * The store watch is installed when this module is first imported (App.tsx
 * imports StartupPopup, which imports this, at startup). It has to be module
 * level: StartupPopup itself is not mounted while the onboarding scene is up.
 * Never reset during the session (an account switch does not make it a
 * normal session); a relaunch starts clean.
 */
import { useFirstMomentStore } from './stores/useFirstMomentStore';
import { useTutorialStore } from './stores/useTutorialStore';
import { useUiStore, type View } from './stores/useUiStore';

let firstRun = false;

/** Views that only a first run (or an unfinished one) shows. */
export function isFirstRunView(view: View): boolean {
  if (view.kind === 'onboard') return view.signin !== true;
  return view.kind === 'onboarding';
}

/** True once this app session has shown onboarding, the tour or the first moment. */
export function isFirstRunSession(): boolean {
  return firstRun;
}

/** Hold the popup for the rest of this session. */
export function markFirstRunSession(): void {
  firstRun = true;
}

function check(): void {
  if (firstRun) return;
  if (
    isFirstRunView(useUiStore.getState().view) ||
    useTutorialStore.getState().active ||
    useFirstMomentStore.getState().status != null
  ) {
    firstRun = true;
  }
}

check();
useUiStore.subscribe(check);
useTutorialStore.subscribe(check);
useFirstMomentStore.subscribe(check);

/** Test seam: forget the flag (the store watch stays installed). */
export function _resetFirstRunSessionForTests(): void {
  firstRun = false;
}
