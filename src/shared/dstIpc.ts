/**
 * Don't Starve Together adapter: shared contracts (game-adapters M2, 260908).
 *
 * Three parties talk here and this file names every shape that crosses a
 * process boundary main validates:
 *
 *   mod (Lua, native/dst-mod/sei)  --heartbeat-->  main watcher (fixed port)
 *   mod                           <--obs/cmd/event-->  bot runtime (ephemeral port)
 *   bot runtime  --{type:'dst-listen'}-->  main supervisor  -->  watcher.setSummonOffer
 *   main  <--dst:* IPC-->  renderer
 *
 * The wire protocol itself is documented in native/dst-mod/PROTOCOL.md; the
 * zod schemas below are the main-process side of it (heartbeat query, summon
 * offer, the dst-listen port message). The bot side is plain JS and mirrors
 * these shapes in src/bot/adapter/dontstarve/protocol.js.
 */
import { z } from 'zod';

/** The fixed discovery port the mod heartbeats to (UserConfig.dst_port overrides). */
export const DST_DEFAULT_PORT = 27424;
/** Heartbeat cadence the mod uses (seconds); the watcher's stale window is 3x. */
export const DST_HEARTBEAT_S = 2;
export const DST_HEARTBEAT_STALE_MS = 6_000;
/** Steam app id of Don't Starve Together. */
export const DST_STEAM_APP_ID = 322330;

/* ── Heartbeat (mod → main watcher, GET /hello?q=<json>) ────────────────── */

export const DstHeartbeatPlayerSchema = z.object({
  userid: z.string().max(64).default(''),
  name: z.string().max(64).default(''),
  prefab: z.string().max(32).optional(),
});

export const DstHeartbeatSchema = z.object({
  /** TheNet:GetSessionIdentifier(); the world fingerprint. */
  session: z.string().max(64).default(''),
  /** World name (cluster name). */
  world: z.string().max(80).default(''),
  day: z.number().int().nonnegative().default(1),
  season: z.string().max(16).default(''),
  phase: z.string().max(16).default(''),
  players: z.array(DstHeartbeatPlayerSchema).max(64).default([]),
  ismastersim: z.boolean().default(true),
  caves: z.boolean().default(false),
  /** Mod version string (modinfo.lua). */
  mod: z.string().max(32).optional(),
  /** Game build, when the mod can read it. */
  build: z.string().max(32).optional(),
  /** GUID of the live companion body, when one is spawned. */
  bot: z.number().optional(),
});
export type DstHeartbeat = z.infer<typeof DstHeartbeatSchema>;

/* ── Summon offer (main watcher → mod, the /hello response) ─────────────── */

/**
 * What the watcher hands the mod once the bot runtime is listening: where to
 * POST observations, the per-summon token, and who to spawn next to.
 */
export const DstSummonOfferSchema = z.object({
  token: z.string().min(8).max(128),
  botPort: z.number().int().min(1).max(65535),
  /** The companion's display name (inst.name). */
  name: z.string().min(1).max(32),
  /** Survivor prefab id (validated against the roster by the module). */
  prefab: z.string().min(1).max(32),
  /** Spawn next to this player (userid); '' = the first player found. */
  nearUserid: z.string().max(64).default(''),
  /** Announce say() lines into the chat log as well as the speech bubble. */
  announce: z.boolean().default(true),
  /** Epoch ms after which the offer is stale and must not be delivered. */
  expiresAt: z.number().finite(),
});
export type DstSummonOffer = z.infer<typeof DstSummonOfferSchema>;

/** The /hello response body. `{}` when idle. */
export interface DstHelloResponse {
  ok: true;
  summon?: Omit<DstSummonOffer, 'expiresAt'>;
}

/* ── dst-listen (bot runtime → supervisor → watcher) ────────────────────── */

export const DstListenMessageSchema = z.object({
  type: z.literal('dst-listen'),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(8).max(128),
});
export type DstListenMessage = z.infer<typeof DstListenMessageSchema>;

/* ── Join target (main → bot init payload) ──────────────────────────────── */

export interface DstJoinTarget {
  /** The world's session identifier (fingerprint) and label. */
  session: string;
  label: string;
  day: number;
  season: string;
  phase: string;
  caves: boolean;
  /** Player to spawn beside. */
  nearUserid: string;
  nearName: string;
  /**
   * Every character's stored survivor pick (UserConfig.dst_survivor) with its
   * primer paragraph. The supervisor's join context carries no character id,
   * so the bot picks its own row by character.id (adapterConfigFrom) and
   * falls back to the default when the pick was never made.
   */
  survivors: Record<string, { prefab: string; brief: string }>;
  defaultPrefab: string;
  defaultBrief: string;
  announce: boolean;
}

/* ── World state (main → renderer, world:state) ─────────────────────────── */

export type DstWorldState =
  | {
      game: 'dontstarve';
      kind: 'open';
      /** Generic consumers read `label`; it is the world name. */
      label: string;
      worldName: string;
      day: number;
      season: string;
      phase: string;
      caves: boolean;
      players: { userid: string; name: string }[];
      lastSeenAt: number;
    }
  | { game: 'dontstarve'; kind: 'closed' }
  | { game: 'dontstarve'; kind: 'not_installed' }
  /** The discovery port could not be bound (DST_PORT_IN_USE). */
  | { game: 'dontstarve'; kind: 'unavailable'; reason?: string };

/* ── Dashboard snapshot (bot → main → renderer, gamedash:snapshot) ──────── */

export interface DstDashboardItem {
  prefab: string;
  count: number;
}

export interface DstDashboardSnapshot {
  game: 'dontstarve';
  characterId: string;
  ts: number;
  activity: string;
  actionName: string | null;
  x: number;
  z: number;
  health: number;
  healthMax: number;
  hunger: number;
  hungerMax: number;
  sanity: number;
  sanityMax: number;
  temperature: number;
  held: string | null;
  items: DstDashboardItem[];
  day: number;
  season: string;
  phase: string;
  prefab: string;
}

/* ── Install (main ↔ renderer, dst:* channels) ──────────────────────────── */

export type DstInstallState =
  | { kind: 'not_found'; searched: string[] }
  | { kind: 'found'; installPath: string; modsDir: string; modInstalled: boolean; modVersion: string | null; enabled: boolean }
  | { kind: 'installing'; step: string }
  | { kind: 'error'; error: 'GAME_INSTALL_FAILED'; message: string };

export interface DstSurvivorPick {
  prefab: string;
  /** 'auto' = the character chose (LLM); 'user' = overridden in the panel. */
  source: 'auto' | 'user';
  reason: string;
}

export const DstSurvivorSetSchema = z.object({
  characterId: z.string().min(1),
  /** null = forget the override and let the character pick again. */
  prefab: z.string().min(1).max(32).nullable(),
});

export const DstChannel = {
  /** Invoke: () → DstInstallState (no writes). */
  installState: 'dst:install-state',
  /** Invoke: () → DstInstallState after copying the mod + enabling it. */
  install: 'dst:install',
  /** Invoke: () → void; opens steam://rungameid/322330. */
  launch: 'dst:launch',
  /** Invoke: (characterId) → DstSurvivorPick (derives + persists on first use). */
  survivorGet: 'dst:survivor-get',
  /** Invoke: ({characterId, prefab|null}) → DstSurvivorPick. */
  survivorSet: 'dst:survivor-set',
  /** Push: DstInstallState while an install runs. */
  installProgress: 'dst:install-progress',
  /** Invoke: (port) → void; persists UserConfig.dst_port and rebinds the listener. */
  setPort: 'dst:set-port',
} as const;
