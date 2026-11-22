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

/* â”€â”€ Follow-up detail (261012) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   59 of 107 new installs in 261008-261011 answered "AI assistant", and we had
   no way to tell WHICH assistant, or whether a Google visit was someone
   searching the brand name after an AI answer. So those two answers get one
   optional follow-up tap. The main answer is sent the moment it is tapped
   (before the follow-up exists), so the detail is its own small event rather
   than a late property on `onboarding_attribution`, whose name and `source`
   prop stay exactly as they were for the existing dashboards. */

/** PostHog event name. Props: `{ source, heard_from_detail }`. */
export const ATTRIBUTION_DETAIL_EVENT = 'onboarding_attribution_detail';

/** Event property carrying the follow-up answer (or 'skipped'). */
export const ATTRIBUTION_DETAIL_PROP = 'heard_from_detail';

/** Person property set (once) from a real follow-up answer, never a skip. */
export const ATTRIBUTION_DETAIL_PERSON_PROP = 'attribution_detail';

/**
 * The follow-up choices per main answer. Values are unique across all lists,
 * so a flat breakdown on `heard_from_detail` alone is unambiguous.
 */
export const ATTRIBUTION_DETAILS = {
  ai_assistant: ['chatgpt', 'google_ai', 'copilot', 'perplexity', 'claude', 'other_ai'],
  google_search: ['searched_name', 'searched_topic', 'not_sure'],
} as const satisfies Partial<Record<AttributionSource, readonly string[]>>;

export type AttributionDetailSource = keyof typeof ATTRIBUTION_DETAILS;
export type AttributionDetail = (typeof ATTRIBUTION_DETAILS)[AttributionDetailSource][number];

/** True when this main answer gets a follow-up question. */
export function hasAttributionDetail(source: unknown): source is AttributionDetailSource {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(ATTRIBUTION_DETAILS, source);
}

/** True when `detail` is one of the follow-up values offered for `source`. */
export function isAttributionDetail(source: unknown, detail: unknown): detail is AttributionDetail {
  if (!hasAttributionDetail(source) || typeof detail !== 'string') return false;
  return (ATTRIBUTION_DETAILS[source] as readonly string[]).includes(detail);
}




