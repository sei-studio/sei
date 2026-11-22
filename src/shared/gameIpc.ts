/**
 * Game adapters: shared game-neutral contracts (M0, 260908).
 *
 * One bot process per character regardless of game; main's supervisor forks
 * it with `game` + `joinTarget`, and every renderer surface that used to
 * assume Minecraft (the world pill, the dashboard, the launch flow) keys on
 * these types instead. Minecraft's existing contracts (LanState,
 * McDashboardSnapshot, the lan:* and mcdash:* channels) are NOT replaced:
 * they become the `minecraft` members of the unions here, and the `lan:*`
 * channels stay as aliases for one release while `world:*` carries the union.
 *
 * Stardew and Don't Starve refine their members (join target, world-state
 * detail, dashboard fields) when their adapters land; the shapes here are the
 * minimum every consumer can rely on.
 */
import type { LanState } from './ipc';
import type { McDashboardSnapshot } from './mcDashboardIpc';
import type { DstJoinTarget, DstWorldState, DstDashboardSnapshot } from './dstIpc';
import type { StardewJoinTarget, StardewWorldState, StardewDashboardSnapshot } from './stardewIpc';

/** The bot-backed games. Mirrors GAME_KINDS in src/bot/config.js (the bot is
 *  plain ESM JS and cannot import this file) â€” keep both lists in sync. */
export type GameId = 'minecraft' | 'stardew' | 'dontstarve' | 'CONNECT4' | 'BATTLESHIP';
export const GAME_IDS: readonly GameId[] = Object.freeze(['minecraft', 'stardew', 'dontstarve', 'CONNECT4', 'BATTLESHIP']);

export function isGameId(v: unknown): v is GameId {
  return typeof v === 'string' && (GAME_IDS as readonly string[]).includes(v);
}

/* â”€â”€ Join targets (main â†’ bot init payload) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/** What the Minecraft runtime needs to join: the cached LAN port + MOTD, the
 *  player's own username (player recognition), and the skin server URL
 *  (logged for verification; CustomSkinLoader on the host client is the real
 *  consumer). */
export interface MinecraftJoinTarget {
  port: number;
  motd: string | null;
  mc_username: string;
  skinServerBaseUrl: string | null;
}

/** Placeholder until the game agents define theirs (the bot's config schema
 *  is passthrough for these kinds, so any JSON-shaped object rides through). */
export type GenericJoinTarget = Record<string, unknown>;

export type JoinTarget =
  | { game: 'minecraft'; target: MinecraftJoinTarget }
  | { game: 'stardew'; target: StardewJoinTarget }
  | { game: 'dontstarve'; target: DstJoinTarget }
  | { game: 'CONNECT4'; target: GenericJoinTarget }
  | { game: 'BATTLESHIP'; target: GenericJoinTarget };

/* â”€â”€ World state (main â†’ renderer, world:state) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * Game-neutral "is a world open" shape for the non-Minecraft games. `open`
 * carries a human label (farm name, cluster name) and whatever detail the
 * game's watcher wants the renderer to show.
 */
export type GenericWorldState =
  | { kind: 'open'; label: string; lastSeenAt: number; detail?: Record<string, unknown> }
  | { kind: 'closed' }
  | { kind: 'unavailable' };

/** Discriminated on `game`. Minecraft's member IS the existing LanState. */
export type WorldState =
  | ({ game: 'minecraft' } & LanState)
  // Stardew (M1): `open` carries the farm + save day; `not_installed` and
  // `game_running_no_save` are the two extra states the launch panel shows.
  | ({ game: 'stardew' } & StardewWorldState)
  // M2 (260908): DST refines its member (worldName/day/season/phase/caves/
  // players on `open`, plus `label` for the generic consumers. See src/shared/dstIpc.ts.
  | DstWorldState
  // Forza 4 (Connect Four) minigame: no world, always 'closed' on world:get.
  | ({ game: 'CONNECT4' } & GenericWorldState)
  // Battleship minigame: no world, always 'closed' on world:get.
  | ({ game: 'BATTLESHIP' } & GenericWorldState);

/** All games' current world states, keyed by game (the world:get snapshot). */
export type WorldStates = Partial<Record<GameId, WorldState>>;

/* â”€â”€ Dashboard snapshots (bot â†’ main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * The minimum every game's telemetry ships. `activity` is the lowercase
 * natural-language line ("watering the parsnips...", "idling") the renderer's
 * presence verb reads for non-Minecraft games; `actionName` is the raw tool
 * behind it (null = idle). Games add their own fields.
 */
export interface GenericGameDashboardSnapshot {
  game: 'stardew' | 'dontstarve';
  characterId: string;
  ts: number;
  activity: string;
  actionName: string | null;
  [key: string]: unknown;
}

export type GameDashboardSnapshot =
  | (McDashboardSnapshot & { game: 'minecraft' })
  | DstDashboardSnapshot
  | StardewDashboardSnapshot
  | GenericGameDashboardSnapshot;

/* â”€â”€ Channels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * Generic per-game channels. `lan:*` and `mcdash:*` stay for Minecraft (one
 * release as aliases for the world channels; the mcdash set is the Minecraft
 * dashboard's own protocol and stays); the two new games use these.
 */
export const GameIpcChannel = {
  world: {
    /** Push: WorldState (on change, per game). */
    state: 'world:state',
    /** Invoke: () â†’ WorldStates snapshot. */
    get: 'world:get',
    /** Invoke: (game: GameId) â†’ WorldState, one fresh detection pass. */
    checkNow: 'world:check-now',
  },
  gamedash: {
    /** Invoke: (characterId) â†’ GameDashboardSnapshot | null. */
    get: 'gamedash:get',
    /** Invoke: ({characterId, watching}) â†’ void. */
    setWatching: 'gamedash:set-watching',
    /** Push: GameDashboardSnapshot. */
    snapshot: 'gamedash:snapshot',
    /** Invoke: ({characterId, paused}) â†’ boolean. */
    setPaused: 'gamedash:set-paused',
    /** Invoke: ({characterId, mode}) â†’ boolean. */
    setMode: 'gamedash:set-mode',
  },
} as const;

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   summon(characterId, game?)                       â€” bot:summon accepts {characterId, game}
 *   onWorldState(cb: (s: WorldState) => void)        â€” world:state push
 *   getWorldStates(): Promise<WorldStates>           â€” world:get
 *   worldCheckNow(game: GameId): Promise<WorldState> â€” world:check-now
 *   gameDashboardGet(characterId)                    â€” gamedash:get
 *   gameDashboardSetWatching(characterId, watching)  â€” gamedash:set-watching
 *   onGameDashboardSnapshot(cb)                      â€” gamedash:snapshot push
 *   gameSetPaused(characterId, paused)               â€” gamedash:set-paused
 *   gameSetMode(characterId, mode)                   â€” gamedash:set-mode
 */




