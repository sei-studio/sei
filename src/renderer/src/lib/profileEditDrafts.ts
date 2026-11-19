/**
 * Unsaved inline edits on your own companion's profile (261119).
 *
 * The profile tabs are the edit surface now. Switching tabs keeps every
 * draft (all tabs stay mounted), but leaving the page unmounts the editors:
 *
 *  - Voice, Name and description, and Chess save on the way out, as the old
 *    popup saved Voice and Basic when it closed.
 *  - A persona draft is NOT applied on the way out: Regenerate spends a
 *    generation and an Advanced save replaces the framework, so both need the
 *    player's own press. It is kept here and comes back, still unsaved, the
 *    next time the page opens.
 *  - A save that fails on the way out (an empty name, an error) keeps its
 *    draft here too.
 *
 * Module state on purpose (like feedbackDraft.ts): it survives the page
 * unmounting for the rest of the app session. Not persisted to disk.
 * Account-scoped: cleared, and the epoch bumped, when the account changes
 * (lib/scopeReset.ts), so a leave-save started by that change's own
 * navigation never writes into the next account.
 *
 * Released companions (261120): releasing or deleting a companion drops its
 * drafts and bumps its release count (`forgetEditDrafts`), so the leave-saves
 * of the editors that unmount on the way Home write nothing (a save would
 * bring the companion back).
 */

export type DraftSection = 'voice' | 'about' | 'persona' | 'chess';

const drafts = new Map<string, unknown>();
let epoch = 0;
const releases = new Map<string, number>();

const keyOf = (characterId: string, section: DraftSection): string => `${characterId}:${section}`;

export function getEditDraft<T>(characterId: string, section: DraftSection): T | null {
  return (drafts.get(keyOf(characterId, section)) as T | undefined) ?? null;
}

export function setEditDraft<T>(characterId: string, section: DraftSection, draft: T | null): void {
  if (draft === null) drafts.delete(keyOf(characterId, section));
  else drafts.set(keyOf(characterId, section), draft);
}

/** Bumped whenever the account changes; a leave-save checks it before writing. */
export function editDraftEpoch(): number {
  return epoch;
}

/** Drop every draft: the account changed, and one account's edits must not reach another. */
export function clearAllEditDrafts(): void {
  drafts.clear();
  epoch += 1;
}

/** How many times this companion was released this session; a leave-save checks it before writing. */
export function editReleaseCount(characterId: string): number {
  return releases.get(characterId) ?? 0;
}

/** The companion was released or deleted: drop its drafts, and the editors' pending leave-saves write nothing. */
export function forgetEditDrafts(characterId: string): void {
  for (const key of [...drafts.keys()]) {
    if (key.startsWith(`${characterId}:`)) drafts.delete(key);
  }
  releases.set(characterId, editReleaseCount(characterId) + 1);
}
