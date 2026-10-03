/**
 * backseatGamePref (260929): the one-time intro popup for a backseat game
 * tile ("Roblox is available via Backseat: ...").
 *
 * The popup shows on the FIRST click of a backseat game tile and never again
 * for that game on this account. Same storage shape and reasoning as
 * gamesTipPref: localStorage (a cosmetic flag is not worth config.json's
 * whole-config write hazard), defensive reads, best-effort writes, and a key
 * that carries the PROFILE SCOPE (account UUID or 'local') because
 * localStorage is one bucket for the whole app and does not move with an
 * account switch. The key also carries the game id, so Valorant's popup is
 * owed to someone who already saw Roblox's, and a version, so bumping it
 * re-announces without anyone clearing storage by hand.
 *
 * Either button retires it ("Continue" and "Not now"): the popup is an
 * explanation, not a question, and a player who read it once has it.
 */

import { useAuthStore } from './stores/useAuthStore';

const KEY_BASE = 'sei.backseatGameIntro.v1';

/** The active profile scope: the account UUID, or 'local' when signed out. */
function scope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

function key(gameId: string): string {
  return `${KEY_BASE}.${gameId}.${scope()}`;
}

/** True once the intro for `gameId` has been seen on THIS account. */
export function backseatGameIntroSeen(gameId: string): boolean {
  try {
    return localStorage.getItem(key(gameId)) === '1';
  } catch {
    // No storage (private mode): show it again. It is one popup.
    return false;
  }
}

/** Record that the intro for `gameId` was seen. Idempotent, best effort. */
export function markBackseatGameIntroSeen(gameId: string): void {
  try {
    localStorage.setItem(key(gameId), '1');
  } catch {
    /* private mode / quota: the popup just shows again next time */
  }
}
