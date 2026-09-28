/**
 * gamesTipPref (260929) : the one-time "Play games together" tip's memory.
 *
 * The tip hangs under the games (gamepad) button in the CHAT HEADER once, and
 * then never again. It names what the games picker holds, including the two
 * newest games (Stardew Valley and Don't Starve Together, beta), because the
 * picker is one click away and still easy to never open.
 *
 * It replaced the one-time Backseat tip (260803), which lived under the
 * header's Backseat button with the same card, the same rules and the same
 * storage shape. That tip's history is why the rules below are what they are.
 * Its key (sei.backseatTipDone.v2.<scope>) is simply no longer read: this key
 * is new, so everyone sees the games tip once, including every player who
 * already dismissed the Backseat one.
 *
 * WHY localStorage and not config.json. This is the established shape for a
 * one-time renderer UI flag (see gameLayoutPref, voice/modelPrefetch): reads
 * are defensive, writes are best effort, and a private-mode or quota failure
 * costs nothing worse than the tip showing again. config.json was rejected on
 * purpose: it carries a known stale-wholesale-save hazard (a screen that
 * writes back a whole config it read earlier can revert unrelated fields), and
 * a cosmetic tip is not worth exposing every other setting to that.
 *
 * TWO THINGS RETIRE IT: "Got it", and clicking the games button itself. The
 * button click is the player finding exactly what the tip points at, so a tip
 * still hanging there when they close the picker would read as the app not
 * noticing. Nothing else does. In particular, opening a game some other way
 * (the first-moment card, the companion's launch tool) does not: the Backseat
 * tip once retired itself on any use of the feature, and that silenced exactly
 * the players who had used it in an earlier build and were owed the notice of
 * what was new. The same holds here, since the news is the two new games.
 *
 * The key carries a version for the same reason. Bumping it re-announces to
 * everyone, including anyone who already dismissed this version, without
 * asking them to clear anything by hand.
 *
 * PER ACCOUNT, NOT PER MACHINE (260803). localStorage is one bucket for the
 * whole app: it belongs to the renderer's origin, and unlike every per-account
 * store in main it is not moved when the profile scope changes. So the key
 * carries the scope, which is the signed-in account's UUID or 'local' when
 * signed out, exactly as `paths.setActiveScope` uses it. Without that, signing
 * into a second account on the same machine would inherit the first account's
 * dismissal and the new account would never be told.
 *
 * The scope is read from useAuthStore, the renderer's mirror of main's
 * AuthState, so it changes with the account within one session and needs no
 * new IPC. Its `user.id` IS the profile scope main partitions on.
 */

import { useAuthStore } from './stores/useAuthStore';

const KEY_BASE = 'sei.gamesTipDone.v1';

/** The active profile scope: the account UUID, or 'local' when signed out. */
function scope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

function key(): string {
  return `${KEY_BASE}.${scope()}`;
}

/** True once the player has retired the tip, on THIS account. */
export function gamesTipDone(): boolean {
  try {
    return localStorage.getItem(key()) === '1';
  } catch {
    // No storage (private mode): treat it as not-done. The tip is dismissable
    // in-session either way, so the worst case is that it returns next launch.
    return false;
  }
}

/**
 * Record that the tip is finished with: "Got it" was pressed, or the games
 * button was clicked. Idempotent, best effort.
 */
export function dismissGamesTip(): void {
  try {
    localStorage.setItem(key(), '1');
  } catch {
    /* private mode / quota: the tip just won't stay dismissed */
  }
}

/**
 * Whether to render the tip right now. Pure so the predicate can be tested
 * without a DOM; ChatTopBar passes its live values.
 *
 * Every suppression here is about not talking over something else. The header
 * is shared by the chat screen and the call view, and on the call view the
 * player is already past the point the tip is for. A modal (including the
 * games picker the button itself opens) means the header is behind a scrim.
 * The tutorial has its own games step with its own spotlight, and two
 * pointers at one button is worse than either alone. The guided first moment
 * (260926) offers its own games under the first greeting, and a second card
 * saying the same thing would compete with it. An open game surface (chess,
 * Draw!, a launch panel or a live dashboard) sits right under the header, so
 * the card would cover the game, and the player is already playing one.
 *
 * The Backseat tip also hid while a screen share ran, because the share WAS
 * the feature it announced. That does not apply to games, so it is gone.
 */
export function shouldShowGamesTip(input: {
  /** gamesTipDone() at mount, or true once retired this session. */
  done: boolean;
  /** The header is on the chat screen, not the fullscreen call view. */
  onChatScreen: boolean;
  /** A game surface is open in this chat (chess, launch panel, dashboard...). */
  gameOpen?: boolean;
  /** Any modal is open over the screen. */
  modalOpen: boolean;
  /** The guided tour is running. */
  tutorialActive: boolean;
  /** The guided first moment is pending or its card is up. */
  firstMomentLive?: boolean;
}): boolean {
  if (input.done) return false;
  if (!input.onChatScreen) return false;
  if (input.gameOpen) return false;
  if (input.modalOpen) return false;
  if (input.firstMomentLive) return false;
  return !input.tutorialActive;
}
