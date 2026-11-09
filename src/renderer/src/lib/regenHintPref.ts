/**
 * regenHintPref (261107, product call): the one-time "Not happy with the
 * look? Regenerate" hint on a companion's profile.
 *
 * The card image can be regenerated, but the control sits two clicks deep
 * (the profile's settings gear, then "Card image", or the editor's
 * Appearance section), so most players never find it. The hint hangs over
 * the gear the first time a player opens a profile where regenerating is
 * actually possible, and its own Regenerate button opens the card image
 * popup (versions + Regenerate). It does not start a regeneration by itself:
 * each companion has a few lifetime regenerations, and the popup says how
 * many are left before one is spent.
 *
 * ONCE PER PLAYER, EVER, not once per companion. The flag is written the
 * moment the hint shows, not when it is dismissed, so a quit or a navigation
 * while it is up does not bring it back. Same storage shape as gamesTipPref:
 * localStorage per profile scope (the account UUID, or 'local' when signed
 * out), defensive reads, best-effort writes. See gamesTipPref for why
 * config.json was rejected for cosmetic one-time flags, and why the key
 * carries the scope. A lost record costs one more showing at worst.
 *
 * ELIGIBLE only where the Regenerate button would work:
 *   - a companion the player owns (not a bundled default, not someone else's
 *     World companion). This is CharacterPage's `canShare` predicate, the
 *     same one that gates the gear's "Card image" item. Awakened ('unique')
 *     companions count: they are owned and have AI portraits.
 *   - signed in: image generation rides the proxy in every backend mode.
 *   - it has real portrait art (the "look" the copy talks about).
 *   - at least one regeneration left (known only after the versions read).
 *   - the image showing is not one the player uploaded (product call
 *     261110): a custom card image is theirs as made, so there is nothing
 *     to "regenerate" and the hint would be noise.
 * An ineligible profile does NOT use up the hint; it waits for one that is.
 *
 * SUPPRESSED (also without using it up) while something else has the
 * player's attention: the guided tour (whose first step is a companion's
 * profile), the first moment, any modal or popup, the gear menu itself, or
 * the page leaving.
 *
 * Analytics, shape only: regen_hint_shown, regen_hint_dismissed (how:
 * close | outside | regenerate), regen_hint_regenerate_clicked.
 */

import { sei } from './ipcClient';
import { useAuthStore } from './stores/useAuthStore';

const KEY_BASE = 'sei.regenHintSeen.v1';

/** The active profile scope: the account UUID, or 'local' when signed out. */
function scope(): string {
  const state = useAuthStore.getState().state;
  return state.kind === 'signed_in' ? state.user.id : 'local';
}

/** The localStorage key for the active scope. Exported for tests and the harness. */
export function regenHintKey(): string {
  return `${KEY_BASE}.${scope()}`;
}

/** True once the hint has been shown to this account. */
export function regenHintSeen(): boolean {
  try {
    return localStorage.getItem(regenHintKey()) === '1';
  } catch {
    // No storage (private mode): treat as not seen. Worst case it shows again.
    return false;
  }
}

/** Record that the hint has been shown. Idempotent, best effort. */
export function markRegenHintSeen(): void {
  try {
    localStorage.setItem(regenHintKey(), '1');
  } catch {
    /* private mode / quota: the hint may show once more */
  }
}

/** The character fields the eligibility rule reads. */
export interface RegenHintCharacter {
  is_default: boolean;
  owner?: string | null;
}

/**
 * Whether Regenerate would work on this profile. Pure; CharacterPage passes
 * live values. `regensLeft` is null until the versions read answers (or when
 * it failed), which counts as not eligible.
 */
export function isRegenHintEligible(input: {
  character: RegenHintCharacter;
  /** The signed-in account's id, or null when signed out. */
  currentUserId: string | null;
  /** portraitSrc(character.portrait_image) is non-null. */
  hasPortrait: boolean;
  regensLeft: number | null;
  /** The active card image is one the player uploaded (cardImageOrigin 'uploaded'). */
  customImage?: boolean;
}): boolean {
  const { character, currentUserId } = input;
  if (input.customImage) return false;
  if (character.is_default) return false;
  // Foreign-owned (a World companion, added or previewed): not ours to redraw.
  if (character.owner && character.owner !== currentUserId) return false;
  if (currentUserId === null) return false;
  if (!input.hasPortrait) return false;
  return input.regensLeft !== null && input.regensLeft > 0;
}

/** Whether to put the hint up right now. Pure. */
export function shouldShowRegenHint(input: {
  /** regenHintSeen() at mount (re-read on an account switch). */
  seen: boolean;
  eligible: boolean;
  /** The guided tour (onboarding or SeiLink) is running. */
  tutorialActive: boolean;
  /** The guided first moment is pending or its card is up. */
  firstMomentLive: boolean;
  /** Any modal, popup or the gear menu is open over the page. */
  overlayOpen: boolean;
  /** The page is playing its exit animation. */
  leaving: boolean;
}): boolean {
  if (input.seen || !input.eligible) return false;
  if (input.tutorialActive || input.firstMomentLive) return false;
  if (input.overlayOpen || input.leaving) return false;
  return true;
}

export type RegenHintDismissHow = 'close' | 'outside' | 'regenerate';

function track(event: string, props: Record<string, string | number>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never disrupt the page */
  }
}

/** The hint rendered. `characterKind` is 'custom' or 'unique'. */
export function trackRegenHintShown(characterKind: string, regensLeft: number): void {
  track('regen_hint_shown', { character_kind: characterKind, regens_left: regensLeft });
}

/** The hint went away; `visibleMs` is how long it was up. */
export function trackRegenHintDismissed(how: RegenHintDismissHow, visibleMs: number): void {
  track('regen_hint_dismissed', { how, visible_ms: Math.max(0, Math.round(visibleMs)) });
}

/** The hint's own Regenerate button (opens the card image popup). */
export function trackRegenHintRegenerateClicked(characterKind: string, regensLeft: number): void {
  track('regen_hint_regenerate_clicked', { character_kind: characterKind, regens_left: regensLeft });
}
