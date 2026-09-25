/**
 * Unsent feedback drafts, per form (260926).
 *
 * A failed send must never cost the player their text. The form already keeps
 * the text on a failed submit, but closing the modal (the natural reaction to
 * an error) threw it away, and 7 submissions from 5 people were lost this way
 * during the 09-03 cert outage. Module state on purpose: it survives the
 * modal unmounting for the rest of the app session and is cleared only by a
 * successful send. Not persisted to disk; the text is the player's own words
 * and a quit is a deliberate exit.
 */
const drafts = new Map<string, string>();

export function getFeedbackDraft(key: string): string {
  return drafts.get(key) ?? '';
}

export function setFeedbackDraft(key: string, body: string): void {
  if (body.length === 0) drafts.delete(key);
  else drafts.set(key, body);
}

export function clearFeedbackDraft(key: string): void {
  drafts.delete(key);
}

/** Drop every draft: the account changed (app:scope-changed), and one
 *  account's unsent words must not appear in another's form. */
export function clearAllFeedbackDrafts(): void {
  drafts.clear();
}
