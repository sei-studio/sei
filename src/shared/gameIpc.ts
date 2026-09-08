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
import type { StardewJoinTarget, StardewWorldState, StardewDashboardSnapshot } from './stardewIpc';

/** The bot-backed games. Mirrors GAME_KINDS in src/bot/config.js (the bot is
 *  plain ESM JS and cannot import this file) — keep both lists in sync. */
export type GameId = 'minecraft' | 'stardew' | 'dontstarve';
export const GAME_IDS: readonly GameId[] = Object.freeze(['minecraft', 'stardew', 'dontstarve']);

export function isGameId(v: unknown): v is GameId {
  return typeof v === 'string' && (GAME_IDS as readonly string[]).includes(v);
}

/* ── Join targets (main → bot init payload) ─────────────────────────────── */

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
  | { game: 'dontstarve'; target: GenericJoinTarget };

/* ── World state (main → renderer, world:state) ─────────────────────────── */

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
  | ({ game: 'dontstarve' } & GenericWorldState);

/** All games' current world states, keyed by game (the world:get snapshot). */
export type WorldStates = Partial<Record<GameId, WorldState>>;

/* ── Dashboard snapshots (bot → main → renderer) ────────────────────────── */

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
  | StardewDashboardSnapshot
  | GenericGameDashboardSnapshot;

/* ── Channels ───────────────────────────────────────────────────────────── */

/**
 * Generic per-game channels. `lan:*` and `mcdash:*` stay for Minecraft (one
 * release as aliases for the world channels; the mcdash set is the Minecraft
 * dashboard's own protocol and stays); the two new games use these.
 */
export const GameIpcChannel = {
  world: {
    /** Push: WorldState (on change, per game). */
    state: 'world:state',
    /** Invoke: () → WorldStates snapshot. */
    get: 'world:get',
    /** Invoke: (game: GameId) → WorldState, one fresh detection pass. */
    checkNow: 'world:check-now',
  },
  gamedash: {
    /** Invoke: (characterId) → GameDashboardSnapshot | null. */
    get: 'gamedash:get',
    /** Invoke: ({characterId, watching}) → void. */
    setWatching: 'gamedash:set-watching',
    /** Push: GameDashboardSnapshot. */
    snapshot: 'gamedash:snapshot',
    /** Invoke: ({characterId, paused}) → boolean. */
    setPaused: 'gamedash:set-paused',
    /** Invoke: ({characterId, mode}) → boolean. */
    setMode: 'gamedash:set-mode',
  },
} as const;

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   summon(characterId, game?)                       — bot:summon accepts {characterId, game}
 *   onWorldState(cb: (s: WorldState) => void)        — world:state push
 *   getWorldStates(): Promise<WorldStates>           — world:get
 *   worldCheckNow(game: GameId): Promise<WorldState> — world:check-now
 *   gameDashboardGet(characterId)                    — gamedash:get
 *   gameDashboardSetWatching(characterId, watching)  — gamedash:set-watching
 *   onGameDashboardSnapshot(cb)                      — gamedash:snapshot push
 *   gameSetPaused(characterId, paused)               — gamedash:set-paused
 *   gameSetMode(characterId, mode)                   — gamedash:set-mode
 */
