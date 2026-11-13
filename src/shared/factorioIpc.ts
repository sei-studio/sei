/**
 * Factorio adapter: shared contracts (261113).
 *
 * Unlike Stardew and Don't Starve Together there is no HTTP listener in the
 * game and no discovery port in main: Factorio opens a localhost UDP socket
 * for Lua only when it is STARTED with `--enable-lua-udp <port>` (a command
 * line flag, not a config.ini key). So Sei starts Factorio itself, remembers
 * the port it chose, and both the watcher (main) and the bot runtime talk to
 * the `sei-companion` mod on that port with the same framed-JSON client
 * (src/bot/adapter/factorio/client.js, native/factorio-mod/PROTOCOL.md).
 *
 *   main  --spawn factorio --enable-lua-udp <port>-->  Factorio
 *   main watcher  --{op:'hello'} (UDP)-->  mod     (is a game loaded?)
 *   main  --FactorioJoinTarget {port}-->  bot runtime  --UDP-->  mod
 *   main  <--factorio:* IPC-->  renderer
 */

/** Steam app id of Factorio. */
export const FACTORIO_STEAM_APP_ID = 427520;
/** The game's own multiplayer port; the Lua socket must never take it. */
export const FACTORIO_GAME_PORT = 34197;
/** First choice for the Lua UDP port; the next few are the fallbacks. */
export const FACTORIO_DEFAULT_UDP_PORT = 34990;
/** The mod's `name` in info.json (and the folder prefix `<name>_<version>`). */
export const FACTORIO_MOD_NAME = 'sei-companion';
/** The only Factorio version the mod supports (info.json factorio_version). */
export const FACTORIO_SUPPORTED_VERSION = '2.1';
/** The PROTOCOL.md version the watcher accepts in the hello reply. */
export const FACTORIO_PROTOCOL_VERSION = 1;

/* ── Join target (main → bot init payload) ──────────────────────────────── */

/**
 * What src/bot/adapter/factorio/runtime.js adapterConfigFrom reads. `port`
 * is the UDP port Factorio was launched with; `color` components are 0..1.
 */
export interface FactorioJoinTarget {
  port: number;
  label?: string;
  color?: { r: number; g: number; b: number };
}

/* ── World state (main → renderer, world:state) ─────────────────────────── */

export interface FactorioWorldDetail {
  /** Connected players as the mod lists them (index + name). */
  players: { i: number; name: string }[];
  multiplayer: boolean;
  /** The mod's world label (empty when it has none). */
  world: string;
  paused: boolean;
}

export type FactorioWorldState =
  | {
      game: 'factorio';
      kind: 'open';
      /** Generic consumers read `label`. */
      label: string;
      lastSeenAt: number;
      port: number;
      detail: FactorioWorldDetail;
    }
  /**
   * The Sei link port is open (nothing refused the hello) but the mod does
   * not answer: Factorio is at the main menu, or a single player game is
   * paused. The mod only answers while a game is loaded and ticking.
   */
  | { game: 'factorio'; kind: 'no_game'; port: number }
  /** Nothing listens on the port (Factorio is not running with the link), or no port is known yet. */
  | { game: 'factorio'; kind: 'closed' }
  /** Detection found no Factorio install. */
  | { game: 'factorio'; kind: 'not_installed' }
  /**
   * Factorio logged that it could not open the Lua UDP socket (the port was
   * taken). The next launch from Sei picks another port.
   */
  | { game: 'factorio'; kind: 'unavailable'; reason?: 'udp_port_in_use' };

/* ── Dashboard snapshot (bot → main → renderer, gamedash:snapshot) ──────── */

export interface FactorioDashboardItem {
  name: string;
  count: number;
}

/** src/bot/adapter/factorio/dashboard/telemetry.js buildSnapshot, plus the pipeline's characterId. */
export interface FactorioDashboardSnapshot {
  game: 'factorio';
  characterId: string;
  ts: number;
  activity: string;
  actionName: string | null;
  surface: string;
  x: number;
  y: number;
  health: number;
  dead: boolean;
  fighting: boolean;
  stance: string;
  following: boolean;
  items: FactorioDashboardItem[];
  /** "<technology> <pct>%" or null when nothing is being researched. */
  research: string | null;
}

/* ── Setup (main ↔ renderer, factorio:* channels) ───────────────────────── */

export type FactorioStore = 'steam' | 'standalone';

export interface FactorioInstallInfo {
  /** The game executable Sei starts. */
  binary: string;
  store: FactorioStore;
  /** "2.1.3" from data/base/info.json, null when unreadable. */
  version: string | null;
  /** major.minor equals FACTORIO_SUPPORTED_VERSION; null when the version is unknown. */
  supported: boolean | null;
}

export type FactorioSetupState =
  | { kind: 'not_found'; searched: string[] }
  | {
      kind: 'found';
      install: FactorioInstallInfo;
      /** Every install detection found (the first is `install`). */
      others: FactorioInstallInfo[];
      /** Factorio's write-data folder (mods/, factorio-current.log). */
      userDataDir: string;
      modsDir: string;
      modInstalled: boolean;
      modVersion: string | null;
      /** mod-list.json does not switch the mod off (absent file = Factorio's default, on). */
      modEnabled: boolean;
      /** The game process is running right now (null = could not tell). */
      gameRunning: boolean | null;
      /** The Sei link port Factorio was last started with from Sei (null = never). */
      port: number | null;
      /** Factorio logged that the last port was taken (FACTORIO_UDP_PORT_IN_USE). */
      portInUse: boolean;
    };

/** Why an install or launch did not happen. The renderer maps each to copy. */
export type FactorioActionFailure =
  | 'not_found'
  | 'unsupported_version'
  | 'game_running'
  | 'mod_missing'
  | 'no_free_port'
  | 'failed';

export type FactorioActionResult =
  | { ok: true; state: FactorioSetupState; port?: number }
  | { ok: false; reason: FactorioActionFailure; message: string; state: FactorioSetupState | null };

export const FactorioChannel = {
  /** Invoke: () → FactorioSetupState (no writes). */
  setupState: 'factorio:setup-state',
  /** Invoke: () → FactorioActionResult after copying + enabling the mod. Refused while Factorio runs. */
  install: 'factorio:install',
  /** Invoke: () → FactorioActionResult; installs or updates the mod, then starts Factorio with the Sei link. */
  launch: 'factorio:launch',
} as const;
