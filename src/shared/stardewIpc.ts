/**
 * Stardew Valley: the cross-process contract (game-adapters M1, 260908).
 *
 * Mirrors native/stardew-mod/PROTOCOL.md for everything main validates (the
 * hello endpoint the watcher polls, the join target the supervisor ships to
 * the bot, the dashboard snapshot the renderer draws) plus the install /
 * launch IPC between the renderer and src/main/games/stardew. The bot's
 * adapter (plain JS) reads the same wire shapes by hand; keep the two in step.
 */
import { z } from 'zod';

/* ── Mod defaults ─────────────────────────────────────────────────────── */

/** The port the mod's config.json defaults to (the installer keeps it). */
export const STARDEW_DEFAULT_PORT = 27431;
/** SMAPI release the installer fetches. Pinned; bump with a live re-test. */
export const SMAPI_VERSION = '4.5.2';
export const SMAPI_INSTALLER_ASSET = `SMAPI-${SMAPI_VERSION}-installer.zip`;
export const SMAPI_INSTALLER_ORIGIN_URL = `https://github.com/Pathoschild/SMAPI/releases/download/${SMAPI_VERSION}/${SMAPI_INSTALLER_ASSET}`;
/** Approximate installer zip size for the "about NN MB" copy. */
export const SMAPI_INSTALLER_SIZE_HINT_BYTES = 12 * 1024 * 1024;
/** Folder name of the mod inside <game>/Mods/. */
export const STARDEW_MOD_FOLDER = 'SeiCompanion';
/** Where the built mod lives inside a game pack root (and the repo root in dev). */
export const STARDEW_MOD_PACK_PATH = ['assets', 'stardew-mod', STARDEW_MOD_FOLDER] as const;
export const STARDEW_MOD_UNIQUE_ID = 'Sei.SeiCompanion';
export const STARDEW_PROTOCOL_VERSION = 1;

/* ── /hello (watcher) ─────────────────────────────────────────────────── */

export const StardewHelloSaveSchema = z.object({
  loaded: z.boolean(),
  farmName: z.string().optional(),
  uniqueId: z.string().optional(),
  day: z.number().int().optional(),
  season: z.string().optional(),
  year: z.number().int().optional(),
  time: z.number().int().optional(),
  isHost: z.boolean().optional(),
  companions: z.array(z.string()).optional(),
});

export const StardewHelloSchema = z.object({
  mod: z.string(),
  version: z.string(),
  protocol: z.number().int(),
  game: z.string().optional(),
  smapi: z.string().optional(),
  port: z.number().int().optional(),
  save: StardewHelloSaveSchema,
});
export type StardewHello = z.infer<typeof StardewHelloSchema>;

/* ── Mod config.json (written by the installer, read by the watcher) ───── */

export const StardewModConfigSchema = z.object({
  Port: z.number().int().min(1).max(65535).default(STARDEW_DEFAULT_PORT),
  Token: z.string().default(''),
  AnnounceInChat: z.boolean().default(true),
  ObserveHz: z.number().int().min(0).max(10).default(2),
  StartingGold: z.number().int().min(0).default(500),
  DisconnectGraceSeconds: z.number().int().min(0).default(10),
});
export type StardewModConfig = z.infer<typeof StardewModConfigSchema>;

/* ── World state member (src/shared/gameIpc.ts WorldState) ────────────── */

export type StardewWorldState =
  | {
      kind: 'open';
      farmName: string;
      uniqueId: string;
      day: number;
      season: string;
      year: number;
      port: number;
      lastSeenAt: number;
      /** Human label for the pill ("Sunny Farm, spring 3"). */
      label: string;
    }
  | { kind: 'closed' }
  | { kind: 'not_installed' }
  | { kind: 'game_running_no_save'; port: number }
  /** Kept for the generic consumers written against GenericWorldState. */
  | { kind: 'unavailable' };

/* ── Join target (main → bot init payload) ────────────────────────────── */

export interface StardewJoinTarget {
  port: number;
  token: string;
  /** Farm name; the supervisor lifts it into `worldLabel`. */
  label: string | null;
  uniqueId: string | null;
}

/* ── Dashboard snapshot (bot → main → renderer, gamedash:snapshot) ────── */

export interface StardewDashItem {
  name: string;
  count: number;
  kind: string;
  slot: number;
}

export interface StardewDashboardSnapshot {
  game: 'stardew';
  characterId: string;
  ts: number;
  location: string;
  x: number;
  y: number;
  stamina: number;
  maxStamina: number;
  health: number;
  maxHealth: number;
  gold: number;
  held: string | null;
  items: StardewDashItem[];
  activity: string;
  actionName: string | null;
  day: number;
  season: string;
  year: number;
  time: number;
  timeText: string;
  weather: string;
  paused: boolean;
  sleeping: boolean;
  /** Index signature so the snapshot is a GenericGameDashboardSnapshot too (the store's map type). */
  [key: string]: unknown;
}

export function isStardewDashboardSnapshot(s: unknown): s is StardewDashboardSnapshot {
  return !!s && typeof s === 'object' && (s as { game?: unknown }).game === 'stardew' && Array.isArray((s as { items?: unknown }).items);
}

/* ── Install state + progress (renderer ↔ main) ───────────────────────── */

export type StardewGameFolderType = 'valid' | 'legacy' | 'invalid' | 'none';

export interface StardewInstallState {
  /** The game folder that contains Stardew Valley.dll, or null. */
  gamePath: string | null;
  /** Every folder that was looked in (the not-installed copy lists them). */
  candidates: string[];
  smapiInstalled: boolean;
  smapiVersion: string | null;
  modInstalled: boolean;
  modVersion: string | null;
  /** The mod's config.json, when the mod is installed and the file parses. */
  modConfig: { port: number; hasToken: boolean } | null;
  /** 'steam' | 'gog' | 'xbox' | 'unknown', from the path shape. */
  store: 'steam' | 'gog' | 'xbox' | 'unknown';
  platform: 'darwin' | 'win32' | 'linux';
  /** Everything the launch panel needs is in place. */
  ready: boolean;
}

export type StardewInstallProgressEvent =
  | { stage: 'queued' }
  | { stage: 'detecting' }
  | { stage: 'smapi-downloading'; pct: number; bytes?: number; total?: number }
  | { stage: 'smapi-installing' }
  | { stage: 'mod-placing' }
  | { stage: 'config-writing' }
  | { stage: 'done'; state: StardewInstallState }
  | { stage: 'failed'; error: 'GAME_NOT_INSTALLED' | 'SMAPI_INSTALL_FAILED' | 'GAME_INSTALL_FAILED'; message: string };

export interface StardewLaunchResult {
  launched: boolean;
  /** How the game was started ('smapi-exe' Windows, 'launcher' macOS/Linux, 'none'). */
  via: 'smapi-exe' | 'launcher' | 'none';
  message?: string;
}

export const StardewIpcChannel = {
  /** Invoke: () → StardewInstallState (fresh detection). */
  installState: 'stardew:install-state',
  /** Invoke: () → StardewInstallState after the install job settles (rejects on failure with the ErrorClass message). */
  install: 'stardew:install',
  /** Invoke: () → StardewLaunchResult. */
  launch: 'stardew:launch',
  /** Push (main → renderer): StardewInstallProgressEvent while an install runs. */
  installProgress: 'stardew:install-progress',
} as const;

/** The Steam launch option that keeps achievements on Windows (shown with a copy button). */
export function steamLaunchOption(gamePath: string): string {
  const exe = gamePath.replace(/\//g, '\\').replace(/\\+$/, '') + '\\StardewModdingAPI.exe';
  return `"${exe}" %command%`;
}
