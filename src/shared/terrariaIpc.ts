/**
 * Terraria adapter: shared contracts (261113).
 *
 * The companion runs inside the SeiCompanion tModLoader mod
 * (native/terraria-mod). The mod listens on localhost (first free port of
 * TERRARIA_DEFAULT_PORT .. +4; Host and Play runs a client and a server
 * process, each with its own listener) and reads its port and token from
 * `<tModLoader save folder>/SeiCompanion/link.json`, which Sei writes at
 * install time. Discovery is the unauthenticated `GET /hello`.
 *
 *   main  --writes link.json, copies SeiCompanion.tmod into Mods/-->  tModLoader
 *   main watcher  --GET /hello (ports 27460..27464)-->  mod   (is a world loaded?)
 *   main  --TerrariaJoinTarget {port, token}-->  bot runtime  --WebSocket-->  mod
 *   main  <--terraria:* IPC-->  renderer
 */
import { z } from 'zod';

/** Steam app id of Terraria (tModLoader needs it owned and installed). */
export const TERRARIA_STEAM_APP_ID = 105600;
/** Steam app id of tModLoader (the free mod loader the companion runs in). */
export const TML_STEAM_APP_ID = 1281930;
/** The mod's first port; the bridge walks TERRARIA_PORT_SPAN ports from here. */
export const TERRARIA_DEFAULT_PORT = 27460;
export const TERRARIA_PORT_SPAN = 5;
/** The mod's internal name (Mods/<name>.tmod, enabled.json entry, link folder). */
export const TERRARIA_MOD_NAME = 'SeiCompanion';
/** The PROTOCOL.md version the watcher accepts. */
export const TERRARIA_PROTOCOL_VERSION = 1;
/** localhost, not 127.0.0.1: the mod's HttpListener binds the `localhost` prefix on Windows. */
export const TERRARIA_LOOPBACK_HOST = 'localhost';

/** The mod's `GET /hello` (native/terraria-mod/PROTOCOL.md). Loose: unknown keys pass. */
export const TerrariaHelloSchema = z
  .object({
    mod: z.literal('SeiCompanion'),
    version: z.string(),
    protocol: z.number().int(),
    game: z.literal('terraria'),
    port: z.number().int(),
    role: z.enum(['single', 'server', 'client']),
    world: z
      .object({
        loaded: z.boolean(),
        name: z.string().optional(),
        uniqueId: z.string().optional(),
        hardmode: z.boolean().optional(),
        players: z.array(z.string()).optional(),
        companions: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type TerrariaHello = z.infer<typeof TerrariaHelloSchema>;

/* ── Join target (main → bot init payload) ──────────────────────────────── */

/** What src/bot/adapter/terraria/runtime.js adapterConfigFrom reads. */
export interface TerrariaJoinTarget {
  port: number;
  token: string;
  label: string | null;
  uniqueId: string | null;
  /** The player the companion spawns beside (the only player in single player). */
  owner?: string;
  /** Player-renderer look: `{hair, skinVariant, hairColor, ...}`, colours as #rrggbb. */
  appearance?: Record<string, number | string>;
}

/* ── World state (main → renderer, world:state) ─────────────────────────── */

export type TerrariaWorldState =
  | {
      game: 'terraria';
      kind: 'open';
      /** Generic consumers read `label`. */
      label: string;
      lastSeenAt: number;
      port: number;
      worldName: string;
      uniqueId: string;
      role: 'single' | 'server';
      players: string[];
    }
  /** tModLoader is running with the mod but sits in the menu. */
  | { game: 'terraria'; kind: 'no_world'; port: number }
  /** The game joined someone else's server; the companion can only join a world this computer runs. */
  | { game: 'terraria'; kind: 'joined_other'; port: number }
  /** No mod answers (tModLoader closed, or started without the mod). */
  | { game: 'terraria'; kind: 'closed' }
  /** Detection found no tModLoader save folder with the mod. */
  | { game: 'terraria'; kind: 'not_installed' }
  /** No watcher answer yet (the generic world:check-now fallback). */
  | { game: 'terraria'; kind: 'unavailable' };

/* ── Dashboard snapshot (bot → main → renderer, gamedash:snapshot) ──────── */

/** src/bot/adapter/terraria/dashboard/telemetry.js buildSnapshot, plus the pipeline's characterId. */
export interface TerrariaDashboardSnapshot {
  game: 'terraria';
  characterId: string;
  ts: number;
  activity: string;
  actionName: string | null;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  defense: number;
  stance: string;
  weapon: string | null;
  armor: string[];
  knockedOut: number;
  items: { name: string; count: number }[];
  time: string;
  day: boolean;
  layer: string;
  events: string[];
  paused: boolean;
}

/* ── Setup (main ↔ renderer, terraria:* channels) ───────────────────────── */

export interface TerrariaSetupState {
  /** Terraria (105600) found in a Steam library (null = could not tell). */
  terrariaInstalled: boolean | null;
  /** tModLoader (1281930) found in a Steam library (null = could not tell). */
  tmlInstalled: boolean | null;
  /** tModLoader's save folder exists (it is created on the first run). */
  saveDirFound: boolean;
  modInstalled: boolean;
  modVersion: string | null;
  /** The pack's mod version (null = the pack is not downloaded yet). */
  packVersion: string | null;
  /** enabled.json lists the mod. */
  modEnabled: boolean;
  /** link.json has a port and a token. */
  linked: boolean;
}

export type TerrariaActionFailure = 'no_tml' | 'no_save_dir' | 'pack_missing' | 'failed';

export type TerrariaActionResult =
  | { ok: true; state: TerrariaSetupState }
  | { ok: false; reason: TerrariaActionFailure; message: string; state: TerrariaSetupState | null };

export const TerrariaChannel = {
  /** Invoke: () → TerrariaSetupState (no writes). */
  setupState: 'terraria:setup-state',
  /** Invoke: () → TerrariaActionResult after copying + enabling the mod and writing link.json. */
  install: 'terraria:install',
  /** Invoke: () → TerrariaActionResult; installs or updates the mod as needed, then starts tModLoader through Steam. */
  launch: 'terraria:launch',
} as const;
