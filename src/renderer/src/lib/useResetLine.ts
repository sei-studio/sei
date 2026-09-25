/**
 * The credit wall's pause line for the renderer (260926): "Free play resets in
 * 3 days (Wednesday, Sep 30)." from the credits store's `resets_at`, in the UI
 * language. null when the reset time is unknown (signed out, no usage row
 * yet, an old snapshot), so every caller simply omits the line.
 *
 * Wording lives in src/shared/freePlayReset.ts so main's chess notice and the
 * renderer surfaces say the same thing.
 */
import { formatResetLine } from '@shared/freePlayReset';
import { useCreditsStore } from './stores/useCreditsStore';
import { useLangStore, uiLanguage } from './i18n';

/** Subscribed: re-renders on a credits push or a language toggle. */
export function useResetLine(): string | null {
  const resetsAt = useCreditsStore((s) => s.resets_at);
  const plan = useCreditsStore((s) => s.plan);
  const lang = useLangStore((s) => s.lang);
  return formatResetLine(resetsAt, Date.now(), { lang, plan });
}

/** Non-subscribed read, for store code that builds a message string once. */
export function currentResetLine(): string | null {
  const { resets_at, plan } = useCreditsStore.getState();
  return formatResetLine(resets_at, Date.now(), { lang: uiLanguage(), plan });
}
