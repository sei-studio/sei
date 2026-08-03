/**
 * backseatTipPref (260803) : the one-time "Backseat is here" tip's memory.
 *
 * Backseat is in beta and effectively undiscoverable. The tip points at the
 * Backseat button in the CHAT HEADER once, and then never again.
 *
 * The header and not the call controls (260803). It pointed at the share pill
 * there first, which was the wrong end of the funnel: those controls only exist
 * once you are on a call, and someone already on a call does not need to be
 * told a call feature exists. The chat screen is where a player starts.
 *
 * WHY localStorage and not config.json. This is the established shape for a
 * one-time renderer UI flag (see gameLayoutPref, voice/modelPrefetch): reads
 * are defensive, writes are best effort, and a private-mode or quota failure
 * costs nothing worse than the tip showing again. config.json was rejected on
 * purpose: it carries a known stale-wholesale-save hazard (a screen that
 * writes back a whole config it read earlier can revert unrelated fields), and
 * a cosmetic tip is not worth exposing every other setting to that.
 *
 * "GOT IT" IS THE ONLY THING THAT RETIRES IT (revised 260803). The first
 * version also retired the tip on any successful share, reasoning that someone
 * who had already found the feature would read the tip as the app not noticing
 * what they just did. Tried live, that was wrong in the one case that matters
 * most: everybody who used backseat in an earlier build had the flag written
 * the first time they shared, and so was never shown the announcement of the
 * thing they had been using. A beta notice is for exactly those people. It
 * costs one click to dismiss and it does not render over a running share, so
 * the cost of showing it to someone who already knows is close to nothing,
 * while the cost of the other error is that the notice reaches nobody.
 *
 * The key carries a version for the same reason. Bumping it re-announces to
 * everyone, including anyone the previous rule had already silenced, without
 * asking them to clear anything by hand.
 *
 * PER ACCOUNT, NOT PER MACHINE (260803). localStorage is one bucket for the
 * whole app: it belongs to the renderer's origin, and unlike every per-account
 * store in main it is not moved when the profile scope changes. So the key
 * carries the scope, which is the signed-in account's UUID or 'local' when
 * signed out, exactly as `paths.setActiveScope` uses it. Without that, signing
 * into a second account on the same machine would inherit the first account's
 * dismissal and the new account would never be told the feature exists, which
 * is the same failure the share-retires-it rule had.
 *
 * The scope is read from useAuthStore, the renderer's mirror of main's
 * AuthState, so it changes with the account within one session and needs no
 * new IPC. Its `user.id` IS the profile scope main partitions on.
 */

import { useAuthStore } from './stores/useAuthStore';

const KEY_BASE = 'sei.backseatTipDone.v2';

/** The active profile scope: the account UUID, or 'local' when signed out. */
function scope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

function key(): string {
  return `${KEY_BASE}.${scope()}`;
}

/** True once the player has dismissed the tip with "Got it", on THIS account. */
export function backseatTipDone(): boolean {
  try {
    return localStorage.getItem(key()) === '1';
  } catch {
    // No storage (private mode): treat it as not-done. The tip is dismissable
    // in-session either way, so the worst case is that it returns next launch.
    return false;
  }
}

/** Record that the tip is finished with. Idempotent, best effort. */
function setDone(): void {
  try {
    localStorage.setItem(key(), '1');
  } catch {
    /* private mode / quota: the tip just won't stay dismissed */
  }
}

/** "Got it" was pressed. */
export function dismissBackseatTip(): void {
  setDone();
}

/**
 * Whether to render the tip right now. Pure so the predicate can be tested
 * without a DOM; ChatTopBar passes its live values.
 *
 * Every suppression here is about not talking over something else. The header
 * is shared by the chat screen and the call view, and on the call view the
 * player is already past the point the tip is for. A modal (including the
 * source picker the button itself opens) means the header is behind a scrim.
 * The tutorial has its own Backseat step with its own spotlight, and two
 * pointers at one button is worse than either alone.
 */
export function shouldShowBackseatTip(input: {
  /** backseatTipDone() at mount, or true once dismissed this session. */
  done: boolean;
  /** The header is on the chat screen, not the fullscreen call view. */
  onChatScreen: boolean;
  /** A share is already running. */
  sharing: boolean;
  /** Any modal is open over the screen. */
  modalOpen: boolean;
  /** The guided tour is running. */
  tutorialActive: boolean;
}): boolean {
  if (input.done) return false;
  if (!input.onChatScreen) return false;
  if (input.sharing) return false;
  if (input.modalOpen) return false;
  return !input.tutorialActive;
}
