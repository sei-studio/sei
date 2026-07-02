/**
 * Last-interaction helper (chat change #6/#7).
 *
 * A companion's "last active" moment is the most recent of an in-game session
 * (`last_launched`) OR an in-app chat (`last_chatted`). Both are ISO strings, so
 * a lexicographic max is the correct chronological max. Used for the card's
 * "last active" date and for ordering (Home grid + IconRail) so a plain chat
 * counts as an interaction, not just a summon.
 */

import type { Character } from '@shared/characterSchema';

type WithActivity = Pick<Character, 'last_launched' | 'last_chatted'>;

/** Most recent interaction ISO (summon or chat), or null if the companion has neither. */
export function lastInteractionAt(c: WithActivity): string | null {
  const launched = c.last_launched ?? '';
  const chatted = c.last_chatted ?? '';
  const max = launched > chatted ? launched : chatted;
  return max || null;
}
