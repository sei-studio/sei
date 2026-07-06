/**
 * Home library filter (260703 procgen — the fixed-slot model). The SINGLE
 * membership rule for "is this character in the user's party", shared by the
 * Home party wall, the IconRail avatar list, and the World tab's slots
 * indicator so all three always count the same set:
 *   - bundled defaults → hidden UNLESS explicitly invited into a slot
 *     (UserConfig.added_default_ids).
 *   - foreign chars (owner stamped, doesn't match current user) → hidden
 *     UNLESS the id is in UserConfig.added_world_ids (invited from World).
 *   - legacy null-owner chars → shown for everyone.
 *   - own chars (owner === currentUserId) → shown.
 *   - signed out + owner-stamped chars → hidden. (A signed-out user can't
 *     invite from World, so a cached copy of someone else's public character
 *     must never read as a party member — 260706: IconRail used to diverge
 *     here and showed them.)
 */
import type { Character } from '@shared/characterSchema';
import { countsAsHomeSlot } from '@shared/characterSchema';

export function isHomeCharacter(
  c: Character,
  currentUserId: string | null,
  addedDefaultIds: Set<string>,
  addedWorldIds: Set<string>,
): boolean {
  // Delegates to the single shared rule so the Home/IconRail filter and the
  // main-process slot counter (libraryCharacterCount) can never diverge.
  return countsAsHomeSlot(c, { currentUserId, addedDefaultIds, addedWorldIds });
}
