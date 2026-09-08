/**
 * Game modules (main process) — the per-game plug-in seam (M0, 260908).
 *
 * Mirrors the bot side's adapter/<kind>/runtime.js: main knows how to tell
 * whether a world is open (the watcher), what the bot needs to join it (the
 * join target), how the companion is named in that game (username rules), and
 * (later) how to install the game-side mod. Everything else the supervisor
 * does (fork, timeouts, credit gate, JWT, chat, pause/mode) is game-agnostic.
 *
 * Registering a game: create `src/main/games/<game>/index.ts` exporting a
 * factory that returns a GameModule, construct it in src/main/index.ts, and
 * call registerGameModule(). The supervisor, the world:* channels, the play
 * row and analytics then pick it up by id. `GAME_CATALOG.available` in
 * src/shared/games.ts stays false until the game's vertical slice passes its
 * live checklist; registering a module does not light the tile.
 */
import type { Character } from '../../shared/characterSchema';
import type { UserConfig } from '../../shared/characterSchema';
import type { ErrorClass } from '../../shared/errorClasses';
import type { GameId, WorldState } from '../../shared/gameIpc';

export interface GameWatcher {
  /** Start polling; `onUpdate` fires on CHANGE only. Idempotent. */
  start(opts: { onUpdate: (state: WorldState) => void }): void;
  /** One fresh detection pass right now (also feeds onUpdate on change). */
  checkNow(): Promise<WorldState>;
  stop(): void;
}

/** What getJoinTarget may read besides the watcher's own state. */
export interface GameJoinContext {
  userConfig: UserConfig;
  /** Loopback skin server URL (Minecraft's CustomSkinLoader consumer). */
  skinServerBaseUrl: string | null;
}

/**
 * Game-side setup (mod install, enable, launching the game). Left undefined
 * for Minecraft in M0 (its skin wizard stays where it is); the two new games
 * fill it. Shapes are deliberately loose until then.
 */
export interface GameInstall {
  detect(): Promise<{ installed: boolean; detail?: Record<string, unknown> }>;
  install(opts?: { onProgress?: (p: unknown) => void }): Promise<void>;
  enable(): Promise<void>;
  launch(): Promise<void>;
}

export interface GameModule {
  id: GameId;
  /** Proper name for the play row ("You and X played <displayName> for ...")
   *  and any main-side copy. */
  displayName: string;
  /** The companion's in-game name for this character under this game's rules. */
  effectiveUsername(character: Character): string;
  /** Do two in-game names collide in this game (Minecraft: case-insensitive)? */
  collides(a: string, b: string): boolean;
  watcher: GameWatcher;
  /** The watcher's latest state (cached; the world:get snapshot). */
  getWorldState(): WorldState;
  /** What the bot needs to join right now, or null when there is nothing to join. */
  getJoinTarget(ctx: GameJoinContext): unknown | null;
  /** The BotStatus error surfaced when getJoinTarget returns null. */
  joinTargetMissingError: { error: ErrorClass; message: string };
  install?: GameInstall;
}

const registry = new Map<GameId, GameModule>();

export function registerGameModule(mod: GameModule): void {
  registry.set(mod.id, mod);
}

export function getGameModule(id: GameId | string): GameModule | null {
  return registry.get(id as GameId) ?? null;
}

export function listGameModules(): GameModule[] {
  return [...registry.values()];
}

/** Test seam: drop every registered module. */
export function clearGameModulesForTests(): void {
  registry.clear();
}
