/**
 * worldlinkTipPref (261119): the one-time "New" tip's memory. The tip hangs
 * under the WorldLink button in the CHAT HEADER once, and then never again.
 *
 * It is the same card that announced Backseat (260803) and then the new games
 * (260929, gamesTipPref, key sei.gamesTipDone.v1.<scope>). That key is simply
 * no longer read: this key is new, so everyone sees the WorldLink tip once,
 * including every player who already dismissed the games one.
 *
 * WHY localStorage and not config.json. This is the established shape for a
 * one-time renderer UI flag (see gameLayoutPref, voice/modelPrefetch): reads
 * are defensive, writes are best effort, and a private-mode or quota failure
 * costs nothing worse than the tip showing again next launch (a dismissal is
 * also kept in memory, so it never returns in the same session). config.json
 * was rejected on purpose: it carries a known stale-wholesale-save hazard (a
 * screen that writes back a whole config it read earlier can revert unrelated
 * fields), and a cosmetic tip is not worth exposing every other setting to.
 *
 * WHAT RETIRES IT: "Got it", and opening WorldLink from ANY entry point (the
 * button it points at, the profile page, the tour, the dock): seilinkFlow
 * calls dismissWorldlinkTip on every entry. Unlike the games tip, using the
 * feature some other way does count here, because the news IS WorldLink.
 *
 * WHAT HIDES IT WITHOUT RETIRING IT (shouldShowWorldlinkTip), all so it never
 * talks over WorldLink's own onboarding:
 *   - the person already knows WorldLink: the first-link intro was seen,
 *     a companion lives on the desktop, or the guide's WorldLink tour is
 *     finished (answered Sure, completed, dropped, declined twice, or retired
 *     as already linked). Read from introPref / tourPref, so players who used
 *     WorldLink on an earlier build are never nagged even though this key is
 *     new to them.
 *   - the tour is running (useTutorialStore.active): it spotlights the very
 *     same button, and two pointers at one button is worse than either.
 *   - any WorldLink surface is up (the move-in sheet, the editor, the intro,
 *     the live hint, a move in progress), or any modal, so it never stacks
 *     over them, including the sheet and intro the button itself opens.
 *   - the call view, an open game surface, the guided first moment: the same
 *     reasons as the games tip (see the predicate).
 *
 * PER ACCOUNT, NOT PER MACHINE (260803). localStorage is one bucket for the
 * whole app and is not moved when the profile scope changes, so the key
 * carries the scope (the signed-in account's UUID, or 'local'), exactly as
 * `paths.setActiveScope` uses it. A second account on the same machine must
 * not inherit the first account's dismissal.
 */

import { create } from 'zustand';
import { useAuthStore } from './stores/useAuthStore';
import { introSeen } from './seilink/introPref';
import { readTourRecord } from './seilink/tourPref';

const KEY_BASE = 'sei.worldlinkTipDone.v1';

/** The active profile scope: the account UUID, or 'local' when signed out. */
function scope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

function key(): string {
  return `${KEY_BASE}.${scope()}`;
}

/** Dismissals this session, per scope: the fallback when storage is unavailable. */
const retiredThisSession = new Set<string>();
/** Scopes whose `shown` event was already sent this session. */
const shownThisSession = new Set<string>();

/**
 * Bumped on every dismissal so a mounted header re-reads `done` (the tour and
 * the profile page can retire the tip while the header stays mounted).
 */
export const useWorldlinkTipStore = create<{ rev: number }>(() => ({ rev: 0 }));

/** True once the player has retired the tip, on THIS account. */
export function worldlinkTipDone(): boolean {
  if (retiredThisSession.has(scope())) return true;
  try {
    return localStorage.getItem(key()) === '1';
  } catch {
    // No storage (private mode): not done. The worst case is that it returns next launch.
    return false;
  }
}

/** Retire the tip: "Got it", or WorldLink was opened. Idempotent, best effort. */
export function dismissWorldlinkTip(): void {
  const first = !retiredThisSession.has(scope());
  retiredThisSession.add(scope());
  try {
    localStorage.setItem(key(), '1');
  } catch {
    /* private mode / quota: the in-memory flag still holds for this session */
  }
  if (first) useWorldlinkTipStore.setState((s) => ({ rev: s.rev + 1 }));
}

/**
 * The person already knows WorldLink on this account: the first-link intro
 * played (or was skipped), or the guide's tour is finished. A companion living
 * on the desktop right now is live state, so the header passes that itself.
 */
export function worldlinkAlreadyKnown(): boolean {
  return introSeen() || readTourRecord().done === true;
}

/** True the first time this session the tip is shown on this account (the `shown` event). */
export function claimTipShown(): boolean {
  if (shownThisSession.has(scope())) return false;
  shownThisSession.add(scope());
  return true;
}

/**
 * Whether to render the tip right now. Pure so the predicate can be tested
 * without a DOM; ChatTopBar passes its live values.
 */
export function shouldShowWorldlinkTip(input: {
  /** worldlinkTipDone(). */
  done: boolean;
  /** WorldLink can run here (the button exists only then). */
  available: boolean;
  /** worldlinkAlreadyKnown(), or a companion lives on the desktop now. */
  alreadyKnown: boolean;
  /** The header is on the chat screen, not the fullscreen call view. */
  onChatScreen: boolean;
  /** A game surface is open in this chat: the card would cover the game. */
  gameOpen?: boolean;
  /** Any modal is open over the screen. */
  modalOpen: boolean;
  /** A WorldLink surface is up: the move-in sheet, editor, intro, live hint, or a move in progress. */
  seilinkOpen: boolean;
  /** A guided tour is running (the onboarding tour or the WorldLink tour). */
  tutorialActive: boolean;
  /** The guided first moment is pending or its card is up. */
  firstMomentLive?: boolean;
}): boolean {
  if (input.done) return false;
  if (!input.available) return false;
  if (input.alreadyKnown) return false;
  if (!input.onChatScreen) return false;
  if (input.gameOpen) return false;
  if (input.modalOpen) return false;
  if (input.seilinkOpen) return false;
  if (input.firstMomentLive) return false;
  return !input.tutorialActive;
}

/** Tests only. */
export function __resetWorldlinkTipSessionForTest(): void {
  retiredThisSession.clear();
  shownThisSession.clear();
  useWorldlinkTipStore.setState({ rev: 0 });
}
