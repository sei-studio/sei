/**
 * One save queue per character for the profile editors (261120).
 *
 * The inline editors (Voice, Name and description, Persona, Chess) each save
 * by reading the stored row and writing the whole row back (chars:save takes
 * a full Character). Run side by side, two of those read the same row and the
 * second write drops the first one's change, locally and in the cloud
 * mirror. That happened whenever two editors had unsaved drafts and the page
 * closed (every editor saves on leave at once), and when a ~30 s persona
 * Regenerate wrote the row it had read before expanding.
 *
 * So every editor write goes through `updateStoredCharacter`: steps for one
 * character run one at a time, each reads the stored row INSIDE its step,
 * and applies only its own fields onto that fresh row. A character that is
 * no longer stored (released, deleted) is never written: chars:save creates a
 * missing row, which brought a released companion back.
 */
import type { Character } from '@shared/characterSchema';
import { sei } from './ipcClient';

const tails = new Map<string, Promise<unknown>>();

/** Run `step` after every earlier step for `characterId` has settled (a failed step does not block the next). */
export function enqueueCharacterSave<T>(characterId: string, step: () => Promise<T>): Promise<T> {
  const prev = tails.get(characterId) ?? Promise.resolve();
  const run = prev.then(step, step);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(characterId, tail);
  void tail.then(() => {
    if (tails.get(characterId) === tail) tails.delete(characterId);
  });
  return run;
}

/**
 * In the character's queue: read the stored row, apply `apply` to it, and
 * save the result (no persona expansion). Resolves with the saved row, or
 * null when the character is no longer stored (nothing is written).
 */
export function updateStoredCharacter(
  characterId: string,
  apply: (latest: Character) => Character,
): Promise<Character | null> {
  return enqueueCharacterSave(characterId, async () => {
    const latest = await sei.getCharacter(characterId);
    if (!latest) return null;
    return await sei.saveCharacter(apply(latest), { skipExpansion: true });
  });
}

/**
 * Persona Regenerate: expand `source` (main writes nothing), then store the
 * new persona and the Standard mode on the row as it is AFTER the expansion,
 * so a save made during the ~30 s expansion is kept. Resolves with the saved
 * row, or null when the companion is no longer stored (nothing is written).
 */
export async function regenerateStoredPersona(
  characterId: string,
  source: string,
  expansionRequestId?: string,
): Promise<Character | null> {
  const before = await sei.getCharacter(characterId);
  if (!before) return null;
  const expansion = await sei.saveCharacter(
    {
      ...before,
      persona: { source, expanded: '' },
      metadata: { ...(before.metadata ?? {}), prompt_mode: 'standard' },
    },
    { skipExpansion: false, expandOnly: true, expansionRequestId },
  );
  return updateStoredCharacter(characterId, (latest) => ({
    ...latest,
    persona: { source, expanded: expansion.persona.expanded },
    // Regenerating means the player is back on the standard framework.
    metadata: { ...(latest.metadata ?? {}), prompt_mode: 'standard' },
  }));
}
