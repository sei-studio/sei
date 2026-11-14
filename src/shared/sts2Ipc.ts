/**
 * Slay the Spire 2 adapter: shared contracts (261115).
 *
 * The companion plays her OWN seat in the player's co-op run, from a second
 * game window on the same computer (one copy, one Steam account):
 *
 *   player's window (Steam)  --"Play with <companion>" (Sei mod, host role)-->
 *     opens a co-op lobby on the game's built-in localhost ENet transport
 *   main  --spawn the game --force-steam off --clientId 1001 -fastmp join-->
 *     companion window (Sei mod, seat role) joins 127.0.0.1:33771
 *   companion window mod  --WebSocket (Neuro SDK protocol + sei/*)-->  bot
 *
 * The bot runtime (src/bot/adapter/sts2/runtime.js) LISTENS on the link port;
 * both windows' mods connect to it. Main picks the port and a token per
 * session and writes them to the link folder (`link.json`), which the mod
 * re-reads before every connect attempt. The mod writes `status-<role>.json`
 * heartbeats to the same folder; the watcher reads the host one.
 * native/sts2-mod/PROTOCOL.md is the wire and file contract.
 */

/** Steam app id of Slay the Spire 2. */
export const STS2_STEAM_APP_ID = 2868840;
/** The mod's id (`<id>.json` manifest and `<id>.dll` in the game's mods folder). */
export const STS2_MOD_ID = 'sei-sts2';
/** The `sei/hello` protocol (and status file `protocol`) this build speaks. */
export const STS2_PROTOCOL_VERSION = 1;
/** The game's built-in ENet co-op port on localhost (fastmp). */
export const STS2_ENET_PORT = 33771;
/** The companion window's `--clientId` (its own settings + saves folder). */
export const STS2_COMPANION_CLIENT_ID = 1001;
/** First choice for the Sei link port; the next few are the fallbacks. */
export const STS2_LINK_PORT_FIRST = 34870;
export const STS2_LINK_PORT_COUNT = 10;
/** A status heartbeat older than this means that window is gone. */
export const STS2_STATUS_STALE_MS = 12_000;

/* ── Join target (main → bot init payload) ──────────────────────────────── */

/** What src/bot/adapter/sts2/runtime.js adapterConfigFrom reads. */
export interface Sts2JoinTarget {
  /** The loopback port the bot's link listens on (also in link.json). */
  port: number;
  /** Per-session secret the mod sends as `?token=` (also in link.json). */
  token: string;
  label?: string;
}

/* ── Mod status file (mod → main, <linkDir>/status-<role>.json) ─────────── */

export type Sts2Role = 'host' | 'seat';
/** How the window's current lobby or run is networked. */
export type Sts2LobbyKind = 'none' | 'enet' | 'steam';

/** PROTOCOL.md "Status files". Every field is optional on read. */
export interface Sts2StatusFile {
  /** Epoch ms of the last write (the mod rewrites it every ~3 s). */
  ts: number;
  role: Sts2Role;
  /** Mod version, e.g. "0.1.0". */
  version: string;
  protocol: number;
  /** The game's build string. */
  game_version: string;
  /** main_menu | character_select | map | combat | ... (free-form, short). */
  screen: string;
  lobby: Sts2LobbyKind;
  in_run: boolean;
  /** Player names in the lobby or run (host role). */
  players: string[];
  /** Process id, so main can tell its spawned window apart. */
  pid: number;
}

/* ── World state (main → renderer, world:state) ─────────────────────────── */

export interface Sts2WorldDetail {
  screen: string;
  players: string[];
  inRun: boolean;
}

export type Sts2WorldState =
  /** The player's window hosts a Sei co-op lobby or run over ENet: the companion can join. */
  | { game: 'sts2'; kind: 'open'; label: string; lastSeenAt: number; detail: Sts2WorldDetail }
  /**
   * The player's game runs with the Sei mod, but no Sei lobby is open (the
   * main menu, a solo run, or a Steam co-op lobby the companion cannot join).
   */
  | { game: 'sts2'; kind: 'no_lobby'; screen: string; lobby: Sts2LobbyKind }
  /** No fresh heartbeat from the player's window. */
  | { game: 'sts2'; kind: 'closed' }
  /** Detection found no Slay the Spire 2 install. */
  | { game: 'sts2'; kind: 'not_installed' }
  /** The generic fallback (world:check-now with nothing cached). */
  | { game: 'sts2'; kind: 'unavailable' };

/* ── Dashboard snapshot (bot → main → renderer, gamedash:snapshot) ──────── */

/** src/bot/adapter/sts2/dashboard/telemetry.js, plus the pipeline's characterId. */
export interface Sts2DashboardSnapshot {
  game: 'sts2';
  characterId: string;
  ts: number;
  activity: string;
  actionName: string | null;
  connected: boolean;
  coop: boolean;
  screen: string | null;
  act: number | null;
  floor: number | null;
  hp: number | null;
  maxHp: number | null;
  gold: number | null;
  character: string | null;
  /** The game is waiting on her move right now. */
  yourMove: boolean;
}

/* ── Setup (main ↔ renderer, sts2:* channels) ───────────────────────────── */

export type Sts2Store = 'steam' | 'manual';

export interface Sts2InstallInfo {
  /** The game folder (Windows) or the .app bundle (macOS). */
  gameDir: string;
  /** The executable main starts for the companion window. */
  binary: string;
  store: Sts2Store;
}

export type Sts2SetupState =
  | { kind: 'not_found'; searched: string[] }
  | {
      kind: 'found';
      install: Sts2InstallInfo;
      modsDir: string;
      modInstalled: boolean;
      /** Installed manifest version, null when not installed or unreadable. */
      modVersion: string | null;
      /** The installed mod matches the one this Sei ships. */
      modCurrent: boolean;
      /**
       * The mod has written a heartbeat at least once since install, so the
       * player turned it on in the game (Settings, Mods).
       */
      modLoaded: boolean;
      /** The player's window is up with the mod (fresh host heartbeat). */
      gameRunning: boolean;
      /** A Sei co-op lobby or run is open in the player's window. */
      lobbyOpen: boolean;
      /** Sei started the companion's window and it is still running. */
      companionRunning: boolean;
      /** macOS: the last install was refused by App Management and needs the one-time OK. */
      grantNeeded: boolean;
    };

/** Why an install or launch did not happen. The renderer maps each to copy. */
export type Sts2ActionFailure = 'not_found' | 'game_running' | 'mod_missing' | 'permission' | 'failed';

export type Sts2ActionResult =
  | { ok: true; state: Sts2SetupState }
  | { ok: false; reason: Sts2ActionFailure; message: string; state: Sts2SetupState | null };

export const Sts2Channel = {
  /** Invoke: () → Sts2SetupState (no writes). */
  setupState: 'sts2:setup-state',
  /** Invoke: () → Sts2ActionResult after copying the mod in. Refused while the game runs. */
  install: 'sts2:install',
  /** Invoke: () → Sts2ActionResult; installs or updates the mod as needed, then starts the game through Steam. */
  startGame: 'sts2:start-game',
} as const;
