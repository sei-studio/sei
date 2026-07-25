/**
 * Minecraft dashboard service (main process). Follows the watch/chess service
 * shape: module state initialized once with push deps, thin functions wired to
 * IPC handlers.
 *
 * The bot process is the producer: while summoned (and while the renderer
 * reports it is watching) it posts {type:'dashboard', snapshot} over the
 * supervisor port ~every 2s (src/bot/adapter/minecraft/dashboard/). The
 * supervisor forwards each snapshot here; this module sanitizes it (the bot is
 * a child process, but the payload still crosses a trust boundary into the
 * renderer), caches the latest per character, and pushes it over
 * mcdash:snapshot. Contract: src/shared/mcDashboardIpc.ts.
 */
import { z } from 'zod';
import type { McDashboardSnapshot } from '../../shared/mcDashboardIpc';
import { MC_DASH_MAP_SIZE } from '../../shared/mcDashboardIpc';

export interface McDashboardDeps {
  pushSnapshot: (s: McDashboardSnapshot) => void;
}

let deps: McDashboardDeps | null = null;

/** characterId -> latest sanitized snapshot (cleared when the session ends). */
const latest = new Map<string, McDashboardSnapshot>();

const ItemSchema = z.object({
  name: z.string().min(1).max(64),
  count: z.number().int().min(0).max(6400),
  slot: z.number().int().min(0).max(63),
});

// The map payload is size^2 bytes -> ceil(n/3)*4 base64 chars; 33x33 = 1452.
const RawSnapshotSchema = z.object({
  ts: z.number().finite(),
  dimension: z.string().max(32).default('overworld'),
  pos: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
  yaw: z.number().finite().default(0),
  health: z.number().min(0).max(20).default(0),
  food: z.number().min(0).max(20).default(0),
  held: z.string().max(64).nullable().default(null),
  items: z.array(ItemSchema).max(64).default([]),
  activity: z.string().max(120).default('idle'),
  actionName: z.string().max(64).nullable().default(null),
  map: z
    .object({
      size: z.number().int().min(3).max(MC_DASH_MAP_SIZE),
      cells: z.string().max(8192),
    })
    .nullable()
    .default(null),
});

export function initMcDashboardService(d: McDashboardDeps): void {
  deps = d;
}

/** A telemetry snapshot arrived from a bot session. Invalid payloads drop. */
export function publishMcDashboardSnapshot(characterId: string, raw: unknown): void {
  const parsed = RawSnapshotSchema.safeParse(raw);
  if (!parsed.success) return;
  const snapshot: McDashboardSnapshot = { characterId, ...parsed.data };
  latest.set(characterId, snapshot);
  deps?.pushSnapshot(snapshot);
}

/** Latest snapshot for hydration (null when none has arrived / cleared). */
export function getMcDashboardSnapshot(characterId: string): McDashboardSnapshot | null {
  return latest.get(characterId) ?? null;
}

/** Session ended: drop the cache so a later summon never hydrates stale data. */
export function clearMcDashboard(characterId: string): void {
  latest.delete(characterId);
}
