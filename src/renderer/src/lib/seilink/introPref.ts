/**
 * The SeiLink first-link intro's memory (261105, T337): it plays once per
 * account, on the first move-in that works, and "Replay SeiLink intro" in the
 * companion menu plays it again on demand.
 *
 * localStorage, per profile scope (the account UUID or 'local'), like the
 * other one-time renderer flags (gamesTipPref has the why: config.json's
 * whole-config saves are not worth risking for a cosmetic flag). A lost flag
 * costs one more viewing of a skippable 11 s sequence.
 *
 * The light is the eclipse aurora, the only one since 261106 v4 (the mood
 * switch and its `sei.seilinkIntroMood` dev override are gone).
 */
import { useAuthStore } from '../stores/useAuthStore';

const KEY_BASE = 'sei.seilinkIntroSeen.v1';

/** The active profile scope: the account UUID, or 'local' when signed out. */
export function profileScope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

/** True once the intro has played to its end, or was skipped, on THIS account. */
export function introSeen(): boolean {
  try {
    return localStorage.getItem(`${KEY_BASE}.${profileScope()}`) === '1';
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(`${KEY_BASE}.${profileScope()}`, '1');
  } catch {
    /* private mode / quota: it may play once more */
  }
}

/**
 * Does this move-in play the intro? Only when it has not been seen on this
 * account. A failed move-in ends the intro early and leaves it unseen, so the
 * next working move-in still gets it (see FirstLinkIntro).
 */
export function shouldPlayFirstLink(input: { seen: boolean; failedStart?: boolean }): boolean {
  return !input.seen && input.failedStart !== true;
}
