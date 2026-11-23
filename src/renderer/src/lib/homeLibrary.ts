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
 *   - signed out + owner-stamped chars → hidden UNLESS explicitly invited
 *     (added_world_ids — 260728, the fresh-onboarding Sui seed). A merely
 *     cached copy of someone else's public character must never read as a
 *     party member — 260706: IconRail used to diverge here and showed them.
 */
import type { Character } from '@shared/characterSchema';
import { countsAsHomeSlot } from '@shared/characterSchema';
import { lastInteractionAt } from './lastInteraction';

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

/**
 * The rail's companion list: every party member, most recently active first
 * (summon or chat; none last), then newest. NOT capped at
 * MAX_COMPANION_SLOTS (261116): a party can hold more than the cap (an
 * import or a sync that landed before the limit was checked), and the Home
 * wall only has four panels, so a capped rail left the rest with no way in at
 * all, not even to unbind one and make room. The rail's avatar column
 * scrolls, so the extra circles always fit.
 */
export function railParty<T extends Character>(homeCharacters: readonly T[]): T[] {
  const copy = homeCharacters.slice();
  copy.sort((a, b) => {
    const aLast = lastInteractionAt(a) ?? '';
    const bLast = lastInteractionAt(b) ?? '';
    if (aLast !== bLast) {
      // Most-recently-active first; empty strings (no activity) sort last.
      if (!aLast) return 1;
      if (!bLast) return -1;
      return bLast.localeCompare(aLast);
    }
    return (b.created ?? '').localeCompare(a.created ?? '');
  });
  return copy;
}
