/**
 * The companion's in-game name in Stardew Valley. MIRROR of
 * src/main/games/stardew/index.ts effectiveStardewName and
 * src/bot/adapter/stardew/runtime.js botUsernameFor: readable display name,
 * spaces allowed, 24 chars, accents folded, 'Sei' as the last resort. All
 * three call names.js stardewNameFromRaw; keep the username/name choice in sync.
 */
import type { Character } from '@shared/characterSchema';
import { stardewNameFromRaw } from '../../../bot/names.js';

export function effectiveStardewName(c: Pick<Character, 'username' | 'name'>): string {
  const raw = (c.username ?? '').trim() || String(c.name || '');
  return stardewNameFromRaw(raw);
}
