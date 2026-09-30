/**
 * The companion's in-game name in Stardew Valley. MIRROR of
 * src/main/games/stardew/index.ts effectiveStardewName and
 * src/bot/adapter/stardew/runtime.js botUsernameFor: readable display name,
 * spaces allowed, 24 chars, 'Sei' as the last resort. Keep the three in sync.
 */
import type { Character } from '@shared/characterSchema';

export function effectiveStardewName(c: Pick<Character, 'username' | 'name'>): string {
  const raw = (c.username ?? '').trim() || String(c.name || '');
  const cleaned = raw.replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 24);
  return cleaned || 'Sei';
}
