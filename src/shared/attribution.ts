/**
 * "Where did you hear about Sei?" (261001): the one-tap attribution question
 * in first-run onboarding. Downloads go to GitHub and the app mints a fresh
 * PostHog person, so there is no join from an ad click or a creator's link to
 * an install. A self-reported answer is the cheapest reliable attribution.
 *
 * Shared by the renderer (the options Sui offers) and main (which turns a
 * valid answer into a person property). The values are a closed enum: main
 * never writes a person property from anything else.
 */

/** PostHog event name. Props: `{ source: AttributionSource | 'skipped' }`. */
export const ATTRIBUTION_EVENT = 'onboarding_attribution';

/** Person property set (once) from a real answer, never from a skip. */
export const ATTRIBUTION_PERSON_PROP = 'attribution_source';

export const ATTRIBUTION_SOURCES = [
  'google_search',
  'youtube_creator',
  'ad',
  'reddit',
  'ai_assistant',
  'friend',
  'other',
] as const;

export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

/** The `source` sent when the player skips the question. */
export const ATTRIBUTION_SKIPPED = 'skipped';

export function isAttributionSource(v: unknown): v is AttributionSource {
  return typeof v === 'string' && (ATTRIBUTION_SOURCES as readonly string[]).includes(v);
}
