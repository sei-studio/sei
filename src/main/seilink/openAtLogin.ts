/**
 * "Open Sei when I log in" (261107, product call 261107): the OS login item
 * that brings WorldLink back after a restart.
 *
 * Opt-in, off by default, packaged macOS and Windows builds only (and only
 * where WorldLink can run). Offered once, as a step after the guided room
 * setup (product call 261107: preselected there, but nothing is registered
 * until the user answers it), and always in Settings. The user's choice lives in Sei's own device-global
 * file `<userData>/open-at-login.json` (the login item belongs to the OS user
 * and the install, not to an account, and the launch reads it synchronously
 * before any profile is known). Every launch re-syncs the file and the OS
 * item (`syncOpenAtLoginAtLaunch`), AFTER legacyTrayCleanup.ts has run.
 *
 * Registration (app.setLoginItemSettings):
 *  - Windows: an HKCU Run value named WIN_RUN_NAME (NOT the AppUserModelId
 *    `com.sei.app`, which the retired tray mode used: legacyTrayCleanup.ts
 *    deletes that name, so it can never touch this one) that starts
 *    `"<exe>" --seilink-login`. The exe is the install's stable launcher
 *    (`windowsLoginTarget`): NSIS updates in place; a Velopack install
 *    registers its root stub `<root>\Sei.exe` (it runs `Update.exe start`,
 *    which forwards the args and picks the current version, also mid-update),
 *    falling back to `current\Sei.exe` when the stub is missing. An NSIS ->
 *    Velopack migration (or a stub that appears later) changes the path; the
 *    next launch re-points the value (same name, so no duplicate).
 *    Read back by value NAME only (osStateFrom): Electron's launchItems keep
 *    only the items whose exe matches the asked path, and Chromium's
 *    CommandLine::GetArgs() drops every switch, so `--seilink-login` is never
 *    in `args`. Requiring it there made every Windows toggle a
 *    readback_mismatch ("Could not change this setting", beta.2, 261110).
 *    Turned off by the user in Task Manager or Settings > Apps > Startup =
 *    Electron's launchItems[].enabled false (the StartupApproved key): Sei
 *    reflects that as off and never re-enables it.
 *  - macOS: openAtLogin on the app itself. macOS 13+ goes through
 *    SMAppService (Electron's default `mainAppService`) and reads back a
 *    `status` (enabled / requires-approval / not-registered / not-found);
 *    macOS 12 reads back `openAtLogin`. There are no launch args on macOS, so
 *    a login launch is `wasOpenedAtLogin` (loginLaunch.ts). Removed in System
 *    Settings > Login Items (not-registered, or requires-approval after it
 *    had been enabled) = reflected as off, never re-added.
 *
 * Nothing here throws; failures are a closed class (shared/openAtLogin.ts)
 * sent as seilink_login_item_failed.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  OPEN_AT_LOGIN_CHANGED_EVENT,
  OPEN_AT_LOGIN_FAILED_EVENT,
  OPEN_AT_LOGIN_OFF,
  type OpenAtLoginFailure,
  type OpenAtLoginState,
  type OpenAtLoginSurface,
} from '../../shared/openAtLogin';

/** argv marker the Windows login item starts Sei with (a login launch, loginLaunch.ts). */
export const LOGIN_ARG = '--seilink-login';
/** The HKCU Run value name. Deliberately not the AppUserModelId (see the header). */
export const WIN_RUN_NAME = 'SeiWorldLink';
export const OPEN_AT_LOGIN_FILE = 'open-at-login.json';

/** What Sei keeps about the setting (device-global). */
export interface OpenAtLoginFile {
  /** The user's choice. */
  open_at_login: boolean;
  /** Sei registered the OS item (so it may remove it, and a missing one means the user removed it on macOS). */
  registered: boolean;
  /** Windows: the exe the item was registered for (to find it after the install moved). */
  registered_path?: string;
  /** macOS: registered, but the OS asked for the user's approval and has not had it yet. */
  approval_pending?: boolean;
  /** The user answered once (setup step, Settings, or turned off in the OS). Sticky: only a factory reset clears it. */
  decided?: boolean;
}

export const OPEN_AT_LOGIN_DEFAULT: OpenAtLoginFile = { open_at_login: false, registered: false };

/** The OS item as Sei can read it. */
export type OsLoginState =
  /** Will open Sei (with the marker on Windows). */
  | 'on'
  /** Not there (Windows: not for this exe with the marker). */
  | 'off'
  /** There but turned off by the user (Windows StartupApproved; macOS requires-approval). */
  | 'disabled'
  /** macOS 13+: the service cannot be found. */
  | 'not_found'
  /** The read threw. */
  | 'unknown';

export interface OpenAtLoginDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  /** WorldLink can run here (seilink/gate.ts seilinkSupport). */
  seilinkSupported: () => boolean;
  filePath: string;
  getLoginItemSettings: (opts?: Electron.LoginItemSettingsOptions) => Electron.LoginItemSettings;
  setLoginItemSettings: (settings: Electron.Settings) => void;
  /** Windows: finds the Velopack root stub. Missing = treated as absent. */
  exists?: (p: string) => boolean;
  capture: (event: string, props: Record<string, unknown>) => void;
  log: (msg: string) => void;
}

/* -------------------------------------------------------------------------- */
/*  Pure parts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The exe a Windows login item must start: one that survives updates. A
 * Velopack install runs from `<root>\current\Sei.exe`, which Velopack swaps
 * during an update, so the item starts the root stub `<root>\Sei.exe` (the
 * same target as the Velopack shortcuts, velopackLaunchTarget) when it
 * exists, else `current\Sei.exe`. An NSIS install updates in its own folder,
 * so it is the running exe.
 */
export function windowsLoginTarget(execPath: string, exists: (p: string) => boolean = () => false): string {
  const w = path.win32;
  const bin = w.dirname(execPath);
  if (w.basename(bin).toLowerCase() !== 'current') return execPath;
  const root = w.dirname(bin);
  const stub = w.join(root, w.basename(execPath));
  let stubThere = false;
  try {
    stubThere = exists(stub);
  } catch {
    stubThere = false;
  }
  return stubThere ? stub : w.join(root, 'current', w.basename(execPath));
}

/** Shape-only: which kind of exe the Windows item points at (diagnostics). */
export type WinTargetKind = 'velopack_stub' | 'velopack_current' | 'exe';

export function windowsTargetKind(execPath: string, target: string): WinTargetKind {
  const w = path.win32;
  if (w.basename(w.dirname(execPath)).toLowerCase() !== 'current') return 'exe';
  return w.basename(w.dirname(target)).toLowerCase() === 'current' ? 'velopack_current' : 'velopack_stub';
}

export function parseOpenAtLoginFile(raw: unknown): OpenAtLoginFile {
  if (!raw || typeof raw !== 'object') return { ...OPEN_AT_LOGIN_DEFAULT };
  const r = raw as Record<string, unknown>;
  return {
    open_at_login: r.open_at_login === true,
    registered: r.registered === true,
    ...(typeof r.registered_path === 'string' && r.registered_path ? { registered_path: r.registered_path } : {}),
    ...(r.approval_pending === true ? { approval_pending: true } : {}),
    ...(r.decided === true ? { decided: true } : {}),
  };
}

/** The settings that register (on) or remove (off) Sei's item. */
export function loginItemSettingsFor(platform: NodeJS.Platform, on: boolean, target: string): Electron.Settings {
  if (platform === 'win32') {
    // Same name for on and off: Electron deletes by value name.
    return { openAtLogin: on, path: target, args: [LOGIN_ARG], name: WIN_RUN_NAME, enabled: true };
  }
  return { openAtLogin: on };
}

/**
 * Reads one platform's answer from getLoginItemSettings.
 *
 * Windows: the item is found by its value NAME (Sei's own) in the user scope.
 * Electron already keeps only the Run values whose exe matches the path
 * readOs asks about, and it parses the command with Chromium's CommandLine,
 * whose GetArgs() returns only the loose args, never switches: the
 * `--seilink-login` marker is never in `args`, so it must not be required.
 */
export function osStateFrom(platform: NodeJS.Platform, s: Electron.LoginItemSettings | null | undefined): OsLoginState {
  if (!s) return 'unknown';
  if (platform === 'win32') {
    const item = (s.launchItems ?? []).find((i) => i.name === WIN_RUN_NAME && i.scope === 'user');
    if (!item) return 'off';
    return item.enabled === false ? 'disabled' : 'on';
  }
  const status = (s as { status?: unknown }).status;
  if (typeof status === 'string') {
    if (status === 'enabled') return 'on';
    if (status === 'requires-approval') return 'disabled';
    if (status === 'not-found') return 'not_found';
    return 'off';
  }
  // macOS 12: no SMAppService status.
  return s.openAtLogin ? 'on' : 'off';
}

export type SyncAction = 'nothing' | 'register' | 'unregister' | 'reflect_off';

/**
 * What a launch does to bring the file and the OS item together. The OS is
 * the user's word: an item they turned off or removed there is never put
 * back, Sei's setting follows it instead.
 */
export function decideSync(platform: NodeJS.Platform, file: OpenAtLoginFile, os: OsLoginState): SyncAction {
  if (os === 'unknown' || os === 'not_found') return 'nothing';
  if (file.open_at_login) {
    if (os === 'on') return 'nothing';
    if (os === 'disabled') return file.approval_pending ? 'nothing' : 'reflect_off';
    // os === 'off'
    if (platform === 'darwin') return file.registered ? 'reflect_off' : 'register';
    // Windows: users turn startup apps off (disabled above), they do not
    // delete Run values. Missing = the install moved (NSIS -> Velopack) or an
    // old copy's uninstaller took it: put it back for this exe.
    return 'register';
  }
  // Off in Sei. Windows: the value name is Sei's own, so any item is ours.
  // macOS: the app's one login item may be one the user added by hand; only
  // remove what Sei registered.
  if (os === 'off') return 'nothing';
  if (platform === 'win32' || file.registered) return 'unregister';
  return 'nothing';
}

/* -------------------------------------------------------------------------- */
/*  Runtime                                                                    */
/* -------------------------------------------------------------------------- */

let injected: OpenAtLoginDeps | null = null;

/** index.ts binds the real deps once at ready (bindOpenAtLogin). Tests pass their own. */
export function bindOpenAtLogin(deps: OpenAtLoginDeps): void {
  injected = deps;
}

/** Tests only. */
export function __resetOpenAtLoginForTest(): void {
  injected = null;
}

export function openAtLoginSupported(d: OpenAtLoginDeps): boolean {
  try {
    return d.isPackaged && (d.platform === 'darwin' || d.platform === 'win32') && d.seilinkSupported();
  } catch {
    return false;
  }
}

export function readOpenAtLoginFile(filePath: string): OpenAtLoginFile {
  try {
    return parseOpenAtLoginFile(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return { ...OPEN_AT_LOGIN_DEFAULT };
  }
}

/** Writes the file. `decided` is sticky: a write without it keeps the one on disk. */
function writeFile(d: OpenAtLoginDeps, next: OpenAtLoginFile): void {
  try {
    const out = next.decided || readOpenAtLoginFile(d.filePath).decided ? { ...next, decided: true } : next;
    mkdirSync(path.dirname(d.filePath), { recursive: true });
    const tmp = `${d.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, d.filePath);
  } catch (err) {
    d.log(`could not save: ${(err as Error).message}`);
  }
}

function targetFor(d: OpenAtLoginDeps): string {
  return d.platform === 'win32' ? windowsLoginTarget(d.execPath, d.exists) : d.execPath;
}

function readOs(d: OpenAtLoginDeps, exe?: string): OsLoginState {
  try {
    const opts: Electron.LoginItemSettingsOptions | undefined =
      d.platform === 'win32' ? ({ path: exe ?? targetFor(d), args: [LOGIN_ARG] } as Electron.LoginItemSettingsOptions) : undefined;
    return osStateFrom(d.platform, opts ? d.getLoginItemSettings(opts) : d.getLoginItemSettings());
  } catch (err) {
    d.log(`read failed: ${(err as Error).message}`);
    return 'unknown';
  }
}

/**
 * Windows: an item registered for an exe this install no longer runs from
 * (the NSIS copy before a migration) is looked up there too, so one the user
 * had turned off is not turned back on by the re-point.
 */
function readOsWithPrevious(d: OpenAtLoginDeps, file: OpenAtLoginFile): OsLoginState {
  const here = readOs(d);
  if (d.platform !== 'win32' || here !== 'off' || !file.registered_path) return here;
  if (file.registered_path.toLowerCase() === targetFor(d).toLowerCase()) return here;
  const before = readOs(d, file.registered_path);
  return before === 'disabled' ? 'disabled' : here;
}

/** Shape-only facts about the last read, for a failure report. */
interface ReadFacts {
  os: OsLoginState;
  /** Windows: launchItems Electron returned for the asked exe (any name). */
  items: number;
}

function readFacts(d: OpenAtLoginDeps): ReadFacts {
  try {
    const opts: Electron.LoginItemSettingsOptions | undefined =
      d.platform === 'win32' ? ({ path: targetFor(d), args: [LOGIN_ARG] } as Electron.LoginItemSettingsOptions) : undefined;
    const s = opts ? d.getLoginItemSettings(opts) : d.getLoginItemSettings();
    return { os: osStateFrom(d.platform, s), items: Array.isArray(s?.launchItems) ? s.launchItems.length : 0 };
  } catch (err) {
    d.log(`read failed: ${(err as Error).message}`);
    return { os: 'unknown', items: 0 };
  }
}

function fail(d: OpenAtLoginDeps, failure: OpenAtLoginFailure, phase: 'set' | 'sync', enabled: boolean, facts?: ReadFacts): void {
  d.log(`${phase}: ${failure}${facts ? ` (os ${facts.os}, items ${facts.items})` : ''}`);
  try {
    d.capture(OPEN_AT_LOGIN_FAILED_EVENT, {
      failure_class: failure,
      phase,
      enabled,
      platform: d.platform,
      // Shape only (261110): what the read-back saw, and which exe kind was asked about.
      ...(facts ? { os_state: facts.os, launch_items: Math.min(facts.items, 9) } : {}),
      ...(d.platform === 'win32' ? { target_kind: windowsTargetKind(d.execPath, targetFor(d)) } : {}),
    });
  } catch {
    /* analytics never breaks this */
  }
}

function changed(d: OpenAtLoginDeps, enabled: boolean, surface: OpenAtLoginSurface, ok: boolean): void {
  try {
    d.capture(OPEN_AT_LOGIN_CHANGED_EVENT, { enabled, surface, ok, platform: d.platform });
  } catch {
    /* ignore */
  }
}

/** Register or remove, then read back. */
function apply(d: OpenAtLoginDeps, on: boolean): { os: OsLoginState; failure: OpenAtLoginFailure | null; facts: ReadFacts } {
  try {
    d.setLoginItemSettings(loginItemSettingsFor(d.platform, on, targetFor(d)));
  } catch (err) {
    d.log(`${on ? 'register' : 'unregister'} threw: ${(err as Error).message}`);
    const facts = readFacts(d);
    return { os: facts.os, failure: on ? 'register_threw' : 'unregister_threw', facts };
  }
  const facts = readFacts(d);
  const os = facts.os;
  if (os === 'unknown') return { os, failure: 'read_threw', facts };
  if (on) {
    if (os === 'on') return { os, failure: null, facts };
    if (os === 'disabled' && d.platform === 'darwin') return { os, failure: 'requires_approval', facts };
    if (os === 'not_found') return { os, failure: 'not_found', facts };
    return { os, failure: 'readback_mismatch', facts };
  }
  if (os === 'off') return { os, failure: null, facts };
  return { os, failure: 'readback_mismatch', facts };
}

function stateOf(d: OpenAtLoginDeps, file: OpenAtLoginFile): OpenAtLoginState {
  const supported = openAtLoginSupported(d);
  return {
    supported,
    enabled: supported && file.open_at_login,
    needsApproval: supported && d.platform === 'darwin' && file.open_at_login && file.approval_pending === true,
    // An install that chose before `decided` existed (on, or registered) counts as decided.
    decided: file.decided === true || file.open_at_login || file.registered,
  };
}

/** The setting for the UI. */
export function openAtLoginState(d: OpenAtLoginDeps | null = injected): OpenAtLoginState {
  if (!d) return { ...OPEN_AT_LOGIN_OFF };
  return stateOf(d, readOpenAtLoginFile(d.filePath));
}

/** True while Sei's setting is on (the window-all-closed rule, the macOS login launch check). */
export function openAtLoginWanted(d: OpenAtLoginDeps | null = injected): boolean {
  if (!d) return false;
  return readOpenAtLoginFile(d.filePath).open_at_login;
}

/**
 * legacyTrayCleanup.ts asks before it removes the macOS login item: when Sei's
 * own setting holds that item, the retired tray file must not take it.
 */
export function openAtLoginOwnsLoginItem(filePath: string): boolean {
  const f = readOpenAtLoginFile(filePath);
  return f.open_at_login || f.registered;
}

/** The user turned the setting on or off (the setup step, Settings). Either answer marks it decided. */
export function setOpenAtLogin(
  on: boolean,
  surface: OpenAtLoginSurface,
  d: OpenAtLoginDeps | null = injected,
): OpenAtLoginState {
  if (!d) return { ...OPEN_AT_LOGIN_OFF };
  const before = readOpenAtLoginFile(d.filePath);
  if (!openAtLoginSupported(d)) return stateOf(d, before);
  // macOS: "Not now" with nothing registered has nothing to remove, and the
  // app's one login item may be one the user added by hand: leave the OS alone.
  if (!on && d.platform === 'darwin' && !before.open_at_login && !before.registered) {
    const next: OpenAtLoginFile = { open_at_login: false, registered: false, decided: true };
    writeFile(d, next);
    changed(d, false, surface, true);
    return stateOf(d, next);
  }
  const r = apply(d, on);
  const target = targetFor(d);
  let next: OpenAtLoginFile;
  if (on) {
    if (r.failure === null) {
      next = { open_at_login: true, registered: true, ...(d.platform === 'win32' ? { registered_path: target } : {}) };
    } else if (r.failure === 'requires_approval') {
      // Registered; the OS opens it once the user allows it in System Settings.
      next = { open_at_login: true, registered: true, approval_pending: true };
    } else {
      // It did not take: the toggle goes back off. Keep `registered` if it may be there.
      next = { open_at_login: false, registered: r.os === 'on' || r.os === 'disabled' || before.registered };
      if (next.registered && d.platform === 'win32') next.registered_path = target;
    }
  } else {
    // Off is the user's word even if the OS did not let go: keep `registered`
    // then, so the next launch tries to remove it again.
    next = { open_at_login: false, registered: r.failure !== null && r.os !== 'off' };
    if (next.registered && d.platform === 'win32') next.registered_path = target;
  }
  next.decided = true;
  writeFile(d, next);
  if (r.failure) fail(d, r.failure, 'set', on, r.facts);
  changed(d, on, surface, r.failure === null || r.failure === 'requires_approval');
  return stateOf(d, next);
}

export type SyncOutcome = SyncAction | 'unsupported' | 'failed';

/**
 * Launch re-sync. Call once at ready, AFTER cleanupLegacyTraySettings (see
 * legacyTrayCleanup.ts: its macOS removal and this registration act on the
 * same item, so the order is cleanup, then sync).
 */
export function syncOpenAtLoginAtLaunch(d: OpenAtLoginDeps | null = injected): SyncOutcome {
  if (!d) return 'unsupported';
  try {
    if (!openAtLoginSupported(d)) return 'unsupported';
    const file = readOpenAtLoginFile(d.filePath);
    // Nothing chosen and nothing registered: the common case, no OS read at all.
    if (!file.open_at_login && !file.registered && d.platform !== 'win32') return 'nothing';
    const os = readOsWithPrevious(d, file);
    if (os === 'not_found' && file.open_at_login) fail(d, 'not_found', 'sync', true);
    const action = decideSync(d.platform, file, os);
    if (action === 'nothing') {
      // Approved since (or the user turned it back on in the OS): forget the pending note.
      if (os === 'on' && (file.approval_pending || !file.registered)) {
        writeFile(d, { open_at_login: file.open_at_login, registered: true, ...(file.registered_path ? { registered_path: file.registered_path } : {}) });
      } else if (os === 'off' && file.registered && !file.open_at_login) {
        writeFile(d, { open_at_login: false, registered: false });
      }
      return action;
    }
    if (action === 'reflect_off') {
      d.log(`turned off in the OS (${os}); following it`);
      // Turned off in the OS is an answer too: the setup step is not offered after it.
      writeFile(d, { open_at_login: false, registered: os === 'disabled', ...(os === 'disabled' && file.registered_path ? { registered_path: file.registered_path } : {}), decided: true });
      changed(d, false, 'os', true);
      return action;
    }
    const on = action === 'register';
    const r = apply(d, on);
    const target = targetFor(d);
    if (r.failure && !(on && r.failure === 'requires_approval')) {
      fail(d, r.failure, 'sync', on, r.facts);
      // Keep the user's choice: the next launch tries again.
      return 'failed';
    }
    if (on) {
      writeFile(d, {
        open_at_login: true,
        registered: true,
        ...(d.platform === 'win32' ? { registered_path: target } : {}),
        ...(r.failure === 'requires_approval' ? { approval_pending: true } : {}),
      });
    } else {
      writeFile(d, { open_at_login: false, registered: false });
    }
    d.log(`launch sync: ${action}`);
    return action;
  } catch (err) {
    d.log(`launch sync failed: ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * Factory reset: remove the item Sei registered BEFORE the wipe deletes the
 * file that says so. Never throws.
 */
export function unregisterOpenAtLoginForReset(d: OpenAtLoginDeps | null = injected): void {
  if (!d) return;
  try {
    if (!openAtLoginSupported(d)) return;
    const file = readOpenAtLoginFile(d.filePath);
    if (!file.registered && !file.open_at_login && d.platform !== 'win32') return;
    if (d.platform === 'win32' || file.registered) d.setLoginItemSettings(loginItemSettingsFor(d.platform, false, targetFor(d)));
    rmSync(d.filePath, { force: true });
  } catch (err) {
    d.log(`reset removal failed: ${(err as Error).message}`);
  }
}
