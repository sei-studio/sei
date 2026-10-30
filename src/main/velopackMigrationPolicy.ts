/**
 * NSIS -> Velopack migration on Windows (261030): pure helpers, no electron
 * import, so they unit-test on any host. velopackMigration.ts runs them.
 *
 * Sei v0.7.x still ships the NSIS installer and the NSIS build carries this
 * code. The migration, proven step by step in CI (velopack-update.yml,
 * migrate jobs):
 *
 *   1. The running NSIS Sei downloads the Velopack Setup.exe named by
 *      setup.<channel>.json, checks its size and sha256, and runs it with
 *      `--silent`. Both copies now exist side by side; userData
 *      (%APPDATA%\Sei) is shared. Setup writes Desktop\Sei.lnk and
 *      Start Menu\Programs\Sei.lnk over the NSIS ones, and Sei retargets any
 *      taskbar pin that pointed at the NSIS copy.
 *   2. From then on every launch is the Velopack copy (shortcuts), and a launch
 *      of the old NSIS exe hands off to it at once (earlyBootAction).
 *   3. The Velopack Sei removes the NSIS copy with its own uninstaller
 *      (`--updated /KEEP_APP_DATA --keep-shortcuts`), which drops its Apps &
 *      features entry and leaves app data and the shortcuts alone.
 *
 * Nothing happens until migration.<channel>.json exists beside the feed: no
 * file means no migration. Its `percent` samples installs like the update
 * rollout does, and raising `epoch` lets installs that gave up try again.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compareVersions } from './velopackFastApply';

/** <userData>/velopack-migration.json */
export const MIGRATION_STATE_FILE = 'velopack-migration.json';
/** Setup.exe runs per migration epoch before an install stops trying. */
export const MAX_INSTALL_ATTEMPTS = 3;
/** NSIS uninstall runs before the Velopack copy stops trying. */
export const MAX_CLEANUP_ATTEMPTS = 3;
/** A hand-off to the Velopack copy that did not come up inside this window counts as failed. */
export const REDIRECT_BOOT_GRACE_MS = 3 * 60 * 1000;
/** Free disk the install needs beyond twice the Setup size (download + extracted app). */
export const MIGRATION_DISK_MARGIN_BYTES = 1536 * 1024 * 1024;

export type MigrationPhase = 'installing' | 'installed' | 'failed' | 'done';

export interface MigrationState {
  phase: MigrationPhase;
  /** Velopack version Setup installed (or is installing). */
  version?: string;
  /** The NSIS install folder this migration replaces. */
  nsisDir?: string;
  perMachine?: boolean;
  /** The NSIS Sei process that ran Setup (phase installing). */
  pid?: number;
  /** migration.<channel>.json epoch the attempts count against. */
  epoch?: number;
  attempts: number;
  cleanupAttempts: number;
  /** When an NSIS launch last handed off to the Velopack copy. */
  redirectAt?: number;
  /** When a Velopack Sei last finished booting. */
  velopackSeenAt?: number;
  at: number;
  error?: string;
}

const PHASES: readonly MigrationPhase[] = ['installing', 'installed', 'failed', 'done'];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function parseMigrationState(json: unknown): MigrationState | null {
  if (!json || typeof json !== 'object') return null;
  const s = json as Record<string, unknown>;
  if (!PHASES.includes(s.phase as MigrationPhase)) return null;
  return {
    phase: s.phase as MigrationPhase,
    version: str(s.version),
    nsisDir: str(s.nsisDir),
    perMachine: s.perMachine === true,
    pid: num(s.pid),
    epoch: num(s.epoch),
    attempts: num(s.attempts) ?? 0,
    cleanupAttempts: num(s.cleanupAttempts) ?? 0,
    redirectAt: num(s.redirectAt),
    velopackSeenAt: num(s.velopackSeenAt),
    at: num(s.at) ?? 0,
    error: str(s.error),
  };
}

/* -------------------------------------------------------------------------- */
/*  Remote control                                                             */
/* -------------------------------------------------------------------------- */

/** migration.<channel>.json: `{ "percent": 20, "epoch": 1 }`. */
export interface MigrationRule {
  percent: number;
  epoch: number;
}

export function parseMigrationRule(json: unknown): MigrationRule | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { percent?: unknown; epoch?: unknown };
  const percent = num(r.percent);
  if (percent === undefined) return null;
  return { percent: Math.max(0, Math.min(100, percent)), epoch: Math.max(0, Math.floor(num(r.epoch) ?? 0)) };
}

/** Stable 0..99 bucket per install, independent of the update rollout's buckets. */
export function migrationBucket(installId: string): number {
  return createHash('sha256').update(`${installId}:nsis-migration`).digest().readUInt32BE(0) % 100;
}

/** No rule = no migration (it is opt-in from the server, unlike the update rollout). */
export function migrationAllowed(rule: MigrationRule | null, installId: string): boolean {
  if (!rule || rule.percent <= 0) return false;
  if (rule.percent >= 100) return true;
  return migrationBucket(installId) < rule.percent;
}

/** setup.<channel>.json, written by the release and the mirror. */
export interface SetupManifest {
  version: string;
  /** Release tag the Setup belongs to (v0.7.0). */
  tag: string;
  /** Asset name (Sei-win-Setup.exe, Sei-beta-Setup.exe). */
  file: string;
  sha256: string;
  size: number;
}

export function parseSetupManifest(json: unknown): SetupManifest | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, unknown>;
  const version = str(m.version);
  const tag = str(m.tag);
  const file = str(m.file);
  const sha256 = str(m.sha256)?.toLowerCase();
  const size = num(m.size);
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  if (!tag || !/^v[0-9A-Za-z.-]+$/.test(tag)) return null;
  if (!file || !/^[0-9A-Za-z._-]+\.exe$/.test(file)) return null;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!size || size <= 0) return null;
  return { version, tag, file, sha256, size };
}

/** Where to fetch the Setup: the dl.sei.gg mirror first, then the GitHub release. */
export function setupUrls(m: SetupManifest, feedBase: string, githubRepo: string): string[] {
  const feed = feedBase.replace(/\/+$/, '');
  return [
    `${feed}/setup/${encodeURIComponent(m.tag)}/${encodeURIComponent(m.file)}`,
    `${githubRepo.replace(/\/+$/, '')}/releases/download/${encodeURIComponent(m.tag)}/${encodeURIComponent(m.file)}`,
  ];
}

export function enoughDiskForMigration(freeBytes: number | null, setupSize: number): boolean {
  if (freeBytes === null) return true; // unknown: let Setup report it
  return freeBytes >= setupSize * 2 + MIGRATION_DISK_MARGIN_BYTES;
}

/* -------------------------------------------------------------------------- */
/*  Layout                                                                     */
/* -------------------------------------------------------------------------- */

export interface NsisInstall {
  dir: string;
  exe: string;
  uninstaller: string;
  perMachine: boolean;
}

export interface WinEnv {
  LOCALAPPDATA?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  ProgramFiles?: string;
  ProgramW6432?: string;
  'ProgramFiles(x86)'?: string;
  SystemRoot?: string;
}

const w = path.win32;

function norm(p: string): string {
  return w.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** True when `child` is `parent` or inside it (case-insensitive, Windows paths). */
export function isWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}\\`);
}

export const NSIS_UNINSTALLER = 'Uninstall Sei.exe';

export function velopackRootFor(localAppData: string): string {
  return w.join(localAppData, 'Sei');
}

/** What a Velopack shortcut starts: the root stub when present, else current\Sei.exe. */
export function velopackLaunchTarget(root: string, exists: (p: string) => boolean): string {
  const stub = w.join(root, 'Sei.exe');
  return exists(stub) ? stub : w.join(root, 'current', 'Sei.exe');
}

/** The NSIS install this process runs from, or null (Velopack, portable, dev). */
export function nsisInstallFor(execPath: string, env: WinEnv, exists: (p: string) => boolean): NsisInstall | null {
  const dir = w.dirname(execPath);
  const uninstaller = w.join(dir, NSIS_UNINSTALLER);
  if (!exists(uninstaller)) return null;
  if (w.basename(dir).toLowerCase() === 'current') return null; // a Velopack layout
  if (env.LOCALAPPDATA && isWithin(dir, velopackRootFor(env.LOCALAPPDATA))) return null;
  const programDirs = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((d): d is string => !!d);
  return { dir, exe: execPath, uninstaller, perMachine: programDirs.some((d) => isWithin(dir, d)) };
}

/**
 * Whether the leftover NSIS folder may be deleted recursively after its
 * uninstaller ran. Only a folder named for Sei, never a drive root or a shell
 * folder: an old assisted install could have been put straight into D:\.
 */
export function safeToRemoveDir(dir: string, env: WinEnv): boolean {
  const n = norm(dir);
  if (/^[a-z]:$/.test(n) || n.split('\\').length < 2) return false;
  if (!/sei/i.test(w.basename(n))) return false;
  const shell = [env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.SystemRoot];
  for (const s of shell) {
    if (s && (norm(s) === n || isWithin(s, n))) return false;
  }
  if (env.LOCALAPPDATA && isWithin(n, velopackRootFor(env.LOCALAPPDATA))) return false;
  if (env.APPDATA && isWithin(n, w.join(env.APPDATA, 'Sei'))) return false; // userData
  return true;
}

/**
 * NSIS uninstaller arguments for a per-user copy, as proven in CI: keep app
 * data, keep the (now Velopack) shortcuts, run in place (`_?=`) so it does not
 * re-spawn itself from temp and the caller can wait for it.
 */
/**
 * The name the NSIS uninstaller copy runs under. electron-builder's uninstaller
 * (allowOnlyOneInstallerInstance.nsh, _CHECK_APP_RUNNING) skips its whole
 * "is the app running" check when its OWN process name is the app's exe name.
 * Under any other name the check closes running Sei.exe processes, and when its
 * PowerShell probe fails (measured on windows-latest, 261030) it does that BY
 * NAME with taskkill, which closed the Velopack copy that had started it.
 */
export const UNINSTALLER_RUN_AS = 'Sei.exe';

export function uninstallArgs(nsisDir: string): string[] {
  return ['/S', '--updated', '/KEEP_APP_DATA', '--keep-shortcuts', `_?=${nsisDir}`];
}

/**
 * spawn() arguments for the uninstaller copy at `exe`. NSIS reads `_?=` only
 * UNQUOTED and LAST on the raw command line, taking everything after it as the
 * folder. Node quotes an argument that has a space in it, so for
 * `C:\Games\My Sei` the uninstaller missed `_?=`, re-ran itself from temp under
 * another name, and that copy closed Sei (261030 CI). So the line is passed
 * verbatim, with only argv0 quoted.
 */
export function uninstallSpawn(exe: string, nsisDir: string): {
  args: string[];
  options: { windowsVerbatimArguments: true; argv0: string };
} {
  return { args: uninstallArgs(nsisDir), options: { windowsVerbatimArguments: true, argv0: `"${exe}"` } };
}

/**
 * Where a shortcut to Sei can live: taskbar and Start pins and the Start menu
 * (searched with subfolders), and the Desktop (top level only).
 */
export function pinSearchDirs(appData: string, desktop: string | null): { deep: string[]; shallow: string[] } {
  const w = path.win32;
  const qs = w.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
  return {
    deep: [w.join(qs, 'TaskBar'), w.join(qs, 'StartMenu'), w.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')],
    shallow: desktop ? [desktop] : [],
  };
}

/**
 * True when a shortcut's target is inside `fromDir` (the folder, not a prefix
 * of its name: C:\Games\Sei must not match C:\Games\Sei 2). Windows paths
 * compare without case.
 */
export function shortcutPointsInto(linkTarget: string | undefined, fromDir: string): boolean {
  if (!linkTarget) return false;
  const dir = `${fromDir.replace(/[\\/]+$/, '')}\\`.toLowerCase();
  return linkTarget.replace(/\//g, '\\').toLowerCase().startsWith(dir);
}

/* -------------------------------------------------------------------------- */
/*  Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export type InstallDecision =
  | { ok: true; attempt: number; epoch: number }
  | { ok: false; reason: 'disabled' | 'held' | 'no-setup' | 'setup-older' | 'update-pending' | 'already' | 'gave-up' | 'in-progress' };

export function installDecision(i: {
  state: MigrationState | null;
  rule: MigrationRule | null;
  manifest: SetupManifest | null;
  appVersion: string;
  installId: string;
  /** An electron-updater (NSIS) update is downloaded and applies on quit. */
  updatePending: boolean;
  /** Another live Sei process is running Setup right now. */
  installingElsewhere: boolean;
}): InstallDecision {
  if (!i.rule || i.rule.percent <= 0) return { ok: false, reason: 'disabled' };
  if (!migrationAllowed(i.rule, i.installId)) return { ok: false, reason: 'held' };
  if (!i.manifest) return { ok: false, reason: 'no-setup' };
  // Never install an older Sei over this one: that would be a downgrade.
  if (compareVersions(i.manifest.version, i.appVersion) < 0) return { ok: false, reason: 'setup-older' };
  // Let the NSIS update land first; the next launch migrates.
  if (i.updatePending) return { ok: false, reason: 'update-pending' };
  const s = i.state;
  if (s && (s.phase === 'installed' || s.phase === 'done')) return { ok: false, reason: 'already' };
  if (s?.phase === 'installing' && i.installingElsewhere) return { ok: false, reason: 'in-progress' };
  const prior = s && s.epoch === i.rule.epoch ? s.attempts : 0;
  if (prior >= MAX_INSTALL_ATTEMPTS) return { ok: false, reason: 'gave-up' };
  return { ok: true, attempt: prior + 1, epoch: i.rule.epoch };
}

export type EarlyBootAction =
  | { kind: 'none' }
  | { kind: 'exit'; reason: string }
  | { kind: 'redirect' }
  | { kind: 'redirect-failed' }
  /** This NSIS build is newer than the Velopack copy (reinstalled from the website): run it, stop handing off. */
  | { kind: 'nsis-newer'; velopackVersion: string };

/** The version in a Velopack install's current\sq.version (a nuspec), or null. */
export function parseSqVersion(xml: string | null | undefined): string | null {
  const m = /<version>\s*([^<\s]+)\s*<\/version>/i.exec(xml ?? '');
  return m ? m[1] : null;
}

/**
 * Before the single-instance lock. A Velopack launch while the NSIS Sei is
 * still running Setup (Setup starting the app it installed) exits quietly. An
 * NSIS launch after the migration starts the Velopack copy instead, unless the
 * last hand-off never came up, or this NSIS build is newer than the Velopack
 * copy: a player who reinstalled from the website (say because the Velopack
 * copy broke) gets the build they installed, not the copy it was meant to
 * replace.
 */
export function earlyBootAction(i: {
  velopack: boolean;
  state: MigrationState | null;
  now: number;
  pidAlive: (pid: number) => boolean;
  velopackExists: boolean;
  selfPid: number;
  /** This build's version (the NSIS side). */
  appVersion?: string;
  /** The Velopack copy's current\sq.version, null when unreadable. */
  velopackVersion?: string | null;
}): EarlyBootAction {
  const s = i.state;
  if (!s) return { kind: 'none' };
  if (i.velopack) {
    if (s.phase === 'installing' && s.pid && s.pid !== i.selfPid && i.pidAlive(s.pid)) {
      return { kind: 'exit', reason: 'the NSIS copy is still installing this one' };
    }
    return { kind: 'none' };
  }
  if (s.phase !== 'installed' && s.phase !== 'done') return { kind: 'none' };
  if (!i.velopackExists) return { kind: 'none' };
  if (i.appVersion && i.velopackVersion && compareVersions(i.appVersion, i.velopackVersion) > 0) {
    return { kind: 'nsis-newer', velopackVersion: i.velopackVersion };
  }
  if (s.redirectAt && i.now - s.redirectAt < REDIRECT_BOOT_GRACE_MS && !((s.velopackSeenAt ?? 0) >= s.redirectAt)) {
    return { kind: 'redirect-failed' };
  }
  return { kind: 'redirect' };
}

export type CleanupDecision = 'skip' | 'done' | 'keep' | 'keep-newer' | 'gave-up' | 'run';

/**
 * True when the state is stuck at `installing` although the NSIS Sei that ran
 * Setup is gone (it was closed or killed after Setup finished, before it wrote
 * `installed`). Only meaningful from the Velopack copy: that it is running at
 * all shows Setup got that far.
 */
export function installingOwnerGone(state: MigrationState | null, pidAlive: (pid: number) => boolean): boolean {
  return state?.phase === 'installing' && !(state.pid && pidAlive(state.pid));
}

/**
 * Run in the Velopack Sei: remove the NSIS copy once the migration installed.
 * A per-machine copy is kept: removing it needs an admin prompt nobody asked
 * for. It stays harmless, since a launch of it hands off to the Velopack copy.
 * An NSIS copy newer than this one is kept too: the player installed it after
 * the migration (earlyBootAction stops handing off to us for the same reason).
 */
export function cleanupDecision(
  state: MigrationState | null,
  nsisLeft: boolean,
  opts: { pidAlive?: (pid: number) => boolean; nsisVersion?: string | null; selfVersion?: string } = {},
): CleanupDecision {
  if (!state || !state.nsisDir) return 'skip';
  const installed = state.phase === 'installed' || (!!opts.pidAlive && installingOwnerGone(state, opts.pidAlive));
  if (!installed) return 'skip';
  if (!nsisLeft) return 'done';
  if (opts.nsisVersion && opts.selfVersion && compareVersions(opts.nsisVersion, opts.selfVersion) > 0) return 'keep-newer';
  if (state.perMachine) return 'keep';
  if (state.cleanupAttempts >= MAX_CLEANUP_ATTEMPTS) return 'gave-up';
  return 'run';
}

/**
 * The app version inside an app.asar (its package.json), read through the
 * archive header with plain file reads. Electron's patched fs could read
 * `app.asar\package.json` directly, but it keeps every archive it opens open
 * for the life of the process, which would hold the NSIS copy's app.asar
 * against its own uninstaller. `readAt(offset, length)` returns those bytes of
 * the archive (fewer at the end of the file).
 */
export function asarPackageVersion(readAt: (offset: number, length: number) => Buffer): string | null {
  try {
    // Two Chromium pickles: [4][headerPickleSize], then the header pickle
    // [payloadSize][jsonLength][json]. File offsets count from 8 + headerPickleSize.
    const sizes = readAt(0, 8);
    if (sizes.length < 8 || sizes.readUInt32LE(0) !== 4) return null;
    const headerSize = sizes.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024) return null;
    const header = readAt(8, headerSize);
    if (header.length < headerSize) return null;
    const jsonLength = header.readUInt32LE(4);
    if (8 + jsonLength > header.length) return null;
    const tree = JSON.parse(header.toString('utf8', 8, 8 + jsonLength)) as {
      files?: Record<string, { size?: number; offset?: string; unpacked?: boolean }>;
    };
    const entry = tree.files?.['package.json'];
    if (!entry || entry.unpacked || typeof entry.size !== 'number' || typeof entry.offset !== 'string') return null;
    if (entry.size > 1024 * 1024) return null;
    const body = readAt(8 + headerSize + Number(entry.offset), entry.size);
    const version = (JSON.parse(body.toString('utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}
