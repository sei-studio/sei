/**
 * Game dashboard service (main process, M0 260908): the per-game dispatch in
 * front of the dashboard telemetry a bot session posts as {type:'dashboard'}.
 *
 * A Minecraft snapshot (game absent — older bots — or 'minecraft') goes to
 * mcDashboardService exactly as before (its own schema, cache and the
 * mcdash:snapshot push). Any other game's snapshot is validated against the
 * generic shape (src/shared/gameIpc.ts GenericGameDashboardSnapshot), cached
 * per character, and pushed over gamedash:snapshot. Zod strips undeclared
 * keys, so a game that ships extra fields must declare them: the generic
 * schema is `.passthrough()` for exactly that reason, bounded by a size cap.
 */
import { z } from 'zod';
import type { GameDashboardSnapshot, GenericGameDashboardSnapshot } from '../../shared/gameIpc';
import {
  publishMcDashboardSnapshot,
  getMcDashboardSnapshot,
  clearMcDashboard,
} from '../mcDashboard/mcDashboardService';

export interface GameDashboardDeps {
  pushSnapshot: (s: GenericGameDashboardSnapshot) => void;
}

let deps: GameDashboardDeps | null = null;

/** characterId -> latest sanitized non-Minecraft snapshot. */
const latest = new Map<string, GenericGameDashboardSnapshot>();

/** ~64 KB per snapshot: a minimap-sized payload fits, a runaway does not. */
const MAX_SNAPSHOT_BYTES = 65_536;

const GenericSnapshotSchema = z
  .object({
    game: z.enum(['stardew', 'dontstarve']),
    ts: z.number().finite(),
    activity: z.string().max(120).default('idle'),
    actionName: z.string().max(64).nullable().default(null),
  })
  .passthrough();

export function initGameDashboardService(d: GameDashboardDeps): void {
  deps = d;
}

/**
 * A telemetry snapshot arrived from a bot session. Dispatches on
 * `snapshot.game`; absent means an older bot, which is always Minecraft.
 */
export function publishGameDashboardSnapshot(characterId: string, raw: unknown): void {
  const game = (raw as { game?: unknown } | null)?.game;
  if (game === undefined || game === 'minecraft') {
    publishMcDashboardSnapshot(characterId, raw);
    return;
  }
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return;
  }
  if (size > MAX_SNAPSHOT_BYTES) return;
  const parsed = GenericSnapshotSchema.safeParse(raw);
  if (!parsed.success) return;
  const snapshot = { ...parsed.data, characterId } as GenericGameDashboardSnapshot;
  latest.set(characterId, snapshot);
  deps?.pushSnapshot(snapshot);
}

/** Latest snapshot for hydration, whichever game produced it. */
export function getGameDashboardSnapshot(characterId: string): GameDashboardSnapshot | null {
  const generic = latest.get(characterId);
  if (generic) return generic;
  const mc = getMcDashboardSnapshot(characterId);
  return mc ? { ...mc, game: 'minecraft' } : null;
}

/** Session ended: drop every game's cache for this character. */
export function clearGameDashboard(characterId: string): void {
  latest.delete(characterId);
  clearMcDashboard(characterId);
}
