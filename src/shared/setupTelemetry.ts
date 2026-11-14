/**
 * Setup telemetry (261104): one shape-only event, `game_setup_step`, for the
 * Minecraft and Stardew Valley setup flows.
 *
 * Before this neither flow sent anything: the first data point was a summon,
 * so the 30% of new users whose Minecraft scan found nothing, the 59% with
 * Java who never summoned, and every Stardew SMAPI failure were invisible
 * (~/suisei/reports/install-failures-2026-11-04).
 *
 * Shape rules (the builder enforces them, so a call site cannot leak):
 *   - closed enums and error codes only: no paths, no usernames, no free text;
 *   - `error_code` is an UPPER_SNAKE code (an ErrorClass or a step's own
 *     code), anything else becomes `UNKNOWN`;
 *   - `os` and `app_version` ride on every event already (analytics.ts
 *     commonProps), so they are not repeated here.
 *
 * Main sends through src/main/setupTelemetry.ts; the renderer through
 * `sei.track(GAME_SETUP_EVENT, setupStepProps(...))`. Both go through the
 * analytics module, which honors the opt-out and sends nothing from dev
 * builds (analyticsContext.ts send gate).
 */

import type { McInstall, McScanExtras } from './ipc';

export const GAME_SETUP_EVENT = 'game_setup_step';

export type SetupGame = 'minecraft' | 'stardew' | 'sts2';
export type SetupOutcome = 'start' | 'ok' | 'fail';

export const MC_SETUP_STEPS = [
  /** The install scan answered (found: java / other_launcher / bedrock_only / launcher_only / none). */
  'install_scan',
  /** One wizard run for one install (start .. ok | fail). */
  'wizard',
  'fabric',
  'mods_link',
  'skin_mod',
  'config',
  /** Start Minecraft opened (or could not open) the launcher. */
  'start_minecraft',
  /** Open the launcher without a Sei profile (the no-Java notes). */
  'open_launcher',
  /** The "searching for your world" screen of a blocked summon. */
  'lan_wait',
] as const;

export const STARDEW_SETUP_STEPS = [
  'find_game',
  'choose_folder',
  'game_version',
  'smapi_download',
  'smapi_run',
  'mod_copy',
  'launch',
  /** The game runs but the mod never answered: the hint was shown. */
  'mod_silent',
  'farm_seen',
] as const;

/** Slay the Spire 2 (261115, src/main/games/sts2). find_game and mod_copy are shared with Stardew. */
export const STS2_SETUP_STEPS = [
  /** Detection answered (once per distinct answer). */
  'find_game',
  /** The Sei mod copied into the game's mods folder. */
  'mod_copy',
  /** Sei asked Steam to start the player's game. */
  'start_game',
  /** The mod wrote its first heartbeat: the player turned it on in the game. */
  'mod_loaded',
  /** A Sei co-op lobby opened in the player's window (first per process). */
  'lobby_seen',
  /** Sei started the companion's game window. */
  'companion_window',
] as const;

export type McSetupStep = (typeof MC_SETUP_STEPS)[number];
export type StardewSetupStep = (typeof STARDEW_SETUP_STEPS)[number];
export type Sts2SetupStep = (typeof STS2_SETUP_STEPS)[number];
export type SetupStep = McSetupStep | StardewSetupStep | Sts2SetupStep;

/** Where the game came from: Stardew's store, or Minecraft's launcher type. */
export const SETUP_STORES = [
  // Stardew
  'steam',
  'gog',
  'xbox',
  'manual',
  'unknown',
  // Minecraft launchers
  'vanilla',
  'curseforge',
  'lunar',
  'prism',
  'multimc',
  'modrinth',
  'atlauncher',
  'mac',
  'windows',
  'windows-store',
  'none',
] as const;
export type SetupStore = (typeof SETUP_STORES)[number];

/** What the Minecraft install scan found, best first. */
export type McScanFound = 'java' | 'other_launcher' | 'bedrock_only' | 'launcher_only' | 'none';
const MC_SCAN_FOUND: readonly McScanFound[] = ['java', 'other_launcher', 'bedrock_only', 'launcher_only', 'none'];

/** A failure's cause, read from an error message into a closed set. */
export type FailReason =
  | 'network'
  | 'permission'
  | 'locked'
  | 'antivirus'
  | 'game_running'
  | 'timeout'
  | 'disk_full'
  | 'not_found'
  | 'java'
  | 'cancelled'
  | 'other';
const FAIL_REASONS: readonly FailReason[] = [
  'network',
  'permission',
  'locked',
  'antivirus',
  'game_running',
  'timeout',
  'disk_full',
  'not_found',
  'java',
  'cancelled',
  'other',
];

/** How a lan_wait (or a similar wait) ended. */
export type WaitEnd = 'world_open' | 'closed' | 'skin_setup' | 'left';
const WAIT_ENDS: readonly WaitEnd[] = ['world_open', 'closed', 'skin_setup', 'left'];

/**
 * lan_wait fail only, stamped by main (issue #52): why the LAN watcher found
 * no world. Mirrors LanDiscoveryFailure in src/main/lanSources.ts.
 */
export type LanDiscoveryClass =
  | 'enum_failed'
  | 'no_java'
  | 'pending'
  | 'stateless_failed'
  | 'no_java_listener'
  | 'unverified';
const LAN_DISCOVERY_CLASSES: readonly LanDiscoveryClass[] = [
  'enum_failed',
  'no_java',
  'pending',
  'stateless_failed',
  'no_java_listener',
  'unverified',
];

export interface SetupStepInput {
  game: SetupGame;
  step: SetupStep;
  outcome: SetupOutcome;
  error_code?: string | null;
  store?: string | null;
  reason?: FailReason | null;
  /** install_scan only. */
  found?: McScanFound | null;
  /** install_scan only: every launcher kind seen, sorted, comma-joined. */
  launchers?: readonly string[] | null;
  /** install_scan only: a Bedrock install was seen. */
  bedrock?: boolean | null;
  /** lan_wait / mod_silent: how the wait ended. */
  ended?: WaitEnd | null;
  /** How long the step took or waited, ms. */
  wait_ms?: number | null;
  /** game_version: the game is new enough for the helper (null = unreadable). */
  version_ok?: boolean | null;
  /** lan_wait fail: the watcher's no-world class (main stamps it). */
  discovery?: LanDiscoveryClass | null;
  /** lan_wait fail: Windows showed the broken listener state (issue #52). */
  win_state0?: boolean | null;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STEPS = new Set<string>([...MC_SETUP_STEPS, ...STARDEW_SETUP_STEPS, ...STS2_SETUP_STEPS]);
const STORES = new Set<string>(SETUP_STORES);

/** An error code, or UNKNOWN for anything that is not one. */
export function setupErrorCode(code: string | null | undefined): string {
  if (!code) return 'UNKNOWN';
  const m = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(code.trim());
  return m && CODE_RE.test(m[1]) ? m[1] : 'UNKNOWN';
}

/**
 * The `game_setup_step` properties for one step, shape only. Unknown enum
 * values are dropped (or mapped to `unknown`), never passed through.
 */
export function setupStepProps(input: SetupStepInput): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    game: input.game === 'stardew' || input.game === 'sts2' ? input.game : 'minecraft',
    step: STEPS.has(input.step) ? input.step : 'unknown',
    outcome: input.outcome === 'ok' || input.outcome === 'fail' ? input.outcome : 'start',
  };
  if (input.error_code != null || input.outcome === 'fail') out.error_code = setupErrorCode(input.error_code ?? null);
  if (input.store != null) out.store = STORES.has(input.store) ? input.store : 'unknown';
  if (input.reason != null && FAIL_REASONS.includes(input.reason)) out.reason = input.reason;
  if (input.found != null && MC_SCAN_FOUND.includes(input.found)) out.found = input.found;
  if (input.launchers != null) {
    const kinds = [...new Set(input.launchers.filter((k) => STORES.has(k)))].sort();
    out.launchers = kinds.length ? kinds.join(',') : 'none';
  }
  if (input.bedrock != null) out.bedrock = input.bedrock === true;
  if (input.ended != null && WAIT_ENDS.includes(input.ended)) out.ended = input.ended;
  if (typeof input.wait_ms === 'number' && Number.isFinite(input.wait_ms) && input.wait_ms >= 0) {
    out.wait_ms = Math.round(input.wait_ms);
  }
  if (input.version_ok != null) out.version_ok = input.version_ok === true;
  if (input.discovery != null && LAN_DISCOVERY_CLASSES.includes(input.discovery)) out.discovery = input.discovery;
  if (input.win_state0 != null) out.win_state0 = input.win_state0 === true;
  return out;
}

/**
 * Read an error message into a closed cause. Used for the `reason` property
 * so a FABRIC_INSTALL_FAILED can still say "network" without the message
 * (which can hold a path) ever leaving the machine.
 */
export function classifyFailReason(message: string | null | undefined): FailReason {
  const m = String(message ?? '').toLowerCase();
  if (!m) return 'other';
  if (/\bcancel+ed\b|aborterror/.test(m)) return 'cancelled';
  if (/antivirus|quarantin|virus|defender/.test(m)) return 'antivirus';
  if (/game is (still )?running|close stardew|still running/.test(m)) return 'game_running';
  if (/ebusy|being used by another process|resource busy|locked/.test(m)) return 'locked';
  if (/eperm|eacces|permission|access\b.*\bdenied|unauthorizedaccess|operation not permitted|read-only/.test(m)) return 'permission';
  if (/enospc|no space|disk full|not enough space/.test(m)) return 'disk_full';
  if (/timed? ?out|timeout|etimedout|stalled/.test(m)) return 'timeout';
  if (/enotfound|econnrefused|econnreset|enetunreach|eai_again|getaddrinfo|fetch failed|could not reach|could not download|socket|network|\b5\d\d\b|\b4\d\d\b/.test(m)) return 'network';
  if (/\bjava\b|jre|javaw/.test(m)) return 'java';
  if (/enoent|not found|no such file|missing/.test(m)) return 'not_found';
  return 'other';
}

/** The Minecraft scan's answer in one word, best first (telemetry + McSteps). */
export function mcScanFound(installs: readonly McInstall[], extras: McScanExtras | null | undefined): McScanFound {
  if (installs.length > 0) return 'java';
  if (extras && extras.others.length > 0) return 'other_launcher';
  if (extras?.bedrock) return 'bedrock_only';
  if (extras?.launcherInstalled) return 'launcher_only';
  return 'none';
}
