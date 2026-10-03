/**
 * attributionPref (261001): "Where did you hear about Sei?" is asked ONCE per
 * machine, during first-run onboarding.
 *
 * Why per machine, not per account: the question is about how this install
 * came to exist. It is asked before sign-in (the scope is still 'local' at
 * that point), and a second account on the same machine arrived the same way
 * or was told by the first. So the key carries no scope, unlike gamesTipPref.
 *
 * Why localStorage: same reasoning as gamesTipPref. A one-time renderer flag,
 * defensive reads, best-effort writes. The failure mode (storage unavailable)
 * is that the question can appear again on a replayed onboarding, which is
 * harmless: every answer is one event and the person property is set once.
 *
 * The flag is written when the question is SHOWN, not when it is answered: a
 * player who quits on that line and relaunches is not asked twice.
 */
import {
  ATTRIBUTION_EVENT,
  ATTRIBUTION_SKIPPED,
  type AttributionSource,
} from '@shared/attribution';

export const ATTRIBUTION_ASKED_KEY = 'sei.attributionAsked.v1';

/** The options Sui offers, in display order. Labels are i18n keys. */
export const ATTRIBUTION_OPTIONS: Array<{ value: AttributionSource; label: string }> = [
  { value: 'google_search', label: 'Google search' },
  { value: 'youtube_creator', label: 'YouTube or a creator' },
  { value: 'ad', label: 'An ad' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'ai_assistant', label: 'ChatGPT or another AI' },
  { value: 'friend', label: 'A friend' },
  { value: 'other', label: 'Other' },
];

/** True when this machine has not been asked yet. Unreadable storage asks. */
export function shouldAskAttribution(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(ATTRIBUTION_ASKED_KEY) !== '1';
  } catch {
    return true;
  }
}

/** Record that the question was shown. Idempotent, best effort. */
export function markAttributionAsked(storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(ATTRIBUTION_ASKED_KEY, '1');
  } catch {
    /* private mode / quota: at worst the question shows again */
  }
}

/** The analytics payload for an answer or a skip. */
export function attributionEvent(
  answer: AttributionSource | null,
): { event: string; props: { source: string } } {
  return { event: ATTRIBUTION_EVENT, props: { source: answer ?? ATTRIBUTION_SKIPPED } };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
