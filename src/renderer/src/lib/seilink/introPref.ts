/**
 * The SeiLink first-link intro's memory (261105, T337): it plays once per
 * account, on the first move-in that works, and "Replay SeiLink intro" in the
 * companion menu plays it again on demand.
 *
 * localStorage, per profile scope (the account UUID or 'local'), like the
 * other one-time renderer flags (gamesTipPref has the why: config.json's
 * whole-config saves are not worth risking for a cosmetic flag). A lost flag
 * costs one more viewing of a skippable 10 s sequence.
 *
 * Which light plays (`introStyle`) is fixed in code: aurora (261106), the
 * softest of the three and the one that reads best over her room as it opens.
 * bloom and tide stay switchable for comparison; a dev build (and the
 * harness) can pick one with `localStorage['sei.seilinkIntroStyle']`.
 */
import { INTRO_STYLES, type IntroStyle } from '@shared/seilinkIntroTelemetry';
import { useAuthStore } from '../stores/useAuthStore';

const KEY_BASE = 'sei.seilinkIntroSeen.v1';
const STYLE_OVERRIDE_KEY = 'sei.seilinkIntroStyle';

/** The light that ships. */
export const DEFAULT_INTRO_STYLE: IntroStyle = 'aurora';

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

export function introStyle(): IntroStyle {
  try {
    const v = localStorage.getItem(STYLE_OVERRIDE_KEY);
    if (v && (INTRO_STYLES as readonly string[]).includes(v)) return v as IntroStyle;
  } catch {
    /* default */
  }
  return DEFAULT_INTRO_STYLE;
}
