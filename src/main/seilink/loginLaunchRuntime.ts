/**
 * Electron wiring for "Open Sei when I log in" (261107): binds openAtLogin.ts
 * to the real app, decides whether this run is a login launch, and keeps the
 * one LoginLaunch (loginLaunch.ts) index.ts feeds. The rules live in those
 * two pure modules; this file only connects them.
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { paths } from '../paths';
import { loadAnalytics } from '../lazyAnalytics';
import { seilinkSupport } from './gate';
import { seilinkHostEvents, seilinkHostIdle, seilinkHostStatus, seilinkRoomUp } from './host/seilinkHost';
import type { SeilinkHostStatus } from '../../shared/seilinkHost';
import {
  bindOpenAtLogin,
  OPEN_AT_LOGIN_FILE,
  openAtLoginWanted,
  syncOpenAtLoginAtLaunch,
  type OpenAtLoginDeps,
} from './openAtLogin';
import { isLoginLaunch, isLoginLaunchArgv, keepRunningWithoutWindows, LoginLaunch } from './loginLaunch';

type RevealVia = 'room' | 'dock' | 'second_launch' | 'other';

function log(line: string): void {
  console.log(`[seilink] open at login: ${line}`);
}

function capture(event: string, props: Record<string, unknown>): void {
  void loadAnalytics()
    .then((m) => m.capture(event, props))
    .catch(() => {});
}

function realDeps(): OpenAtLoginDeps {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    seilinkSupported: () => seilinkSupport().supported,
    filePath: path.join(paths.userData(), OPEN_AT_LOGIN_FILE),
    getLoginItemSettings: (o) => app.getLoginItemSettings(o),
    setLoginItemSettings: (s) => app.setLoginItemSettings(s),
    capture,
    log,
  };
}

let launch = new LoginLaunch(false, { quit: () => {}, capture: () => {}, log: () => {} });
let revealVia: RevealVia | null = null;
/** Windows: Sei stayed running after its last window closed, for her room. */
let stayedForRoom = false;
let roomWatched = false;

/**
 * At ready, right AFTER cleanupLegacyTraySettings (the order matters, see
 * legacyTrayCleanup.ts): bind, re-sync the OS item, classify the launch.
 * Never throws; any failure is a normal launch.
 */
export function startOpenAtLoginAtReady(): LoginLaunch {
  try {
    const deps = realDeps();
    bindOpenAtLogin(deps);
    const outcome = syncOpenAtLoginAtLaunch(deps);
    if (outcome !== 'nothing' && outcome !== 'unsupported') log(`launch sync: ${outcome}`);
    const login = isLoginLaunch({
      platform: process.platform,
      argv: process.argv,
      wanted: openAtLoginWanted(deps),
      macWasOpenedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin === true,
    });
    launch = new LoginLaunch(login, {
      quit: () => app.quit(),
      capture,
      log,
    });
    if (login) log('login launch: her room only, the window stays hidden');
  } catch (err) {
    log(`start failed, normal launch: ${(err as Error).message}`);
  }
  return launch;
}

export function loginLaunch(): LoginLaunch {
  return launch;
}

/** For app_opened: was this run started by the login item? */
export function launchedAtLogin(): boolean {
  return launch.login;
}

/** The next show of the main window came from here (analytics only). */
export function noteRevealVia(via: RevealVia): void {
  revealVia = via;
}

/** Call for every main window made: its first show ends the hidden state. */
export function watchMainWindowShow(win: BrowserWindow): void {
  win.on('show', () => {
    const via = revealVia ?? 'other';
    revealVia = null;
    launch.revealed(via);
  });
}

/** Launch-time work that is not WorldLink's: run now, or when a hidden login launch is first opened. */
export function afterLoginReveal(fn: () => void): void {
  launch.afterReveal(fn);
}

/**
 * boot.ts second-instance, decided first. A login launch while Sei runs does
 * nothing. With no window left (Windows stayed running for her room) a
 * window is made. Otherwise boot.ts shows and focuses the one there is.
 */
export function onSecondLaunch(argv: readonly string[], openWindow: () => void, hasWindow: () => boolean): boolean {
  if (isLoginLaunchArgv(argv)) return true;
  noteRevealVia('second_launch');
  if (hasWindow()) return false;
  // Still booting a hidden login launch: the window bootstrap is about to make must show.
  launch.revealed('second_launch');
  openWindow();
  return true;
}

/** window-all-closed on Windows: stay running (true) instead of quitting. */
export function keepRunningOnLastWindowClosed(): boolean {
  const keep = keepRunningWithoutWindows({
    platform: process.platform,
    roomUp: seilinkRoomUp(seilinkHostStatus()),
    wanted: openAtLoginWanted(),
    loginLaunch: launch.login,
  });
  if (keep) {
    stayedForRoom = true;
    log('last window closed, staying for her desktop room');
  }
  return keep;
}

function onRoomStatus(s: SeilinkHostStatus): void {
  if (seilinkRoomUp(s)) return;
  launch.roomEnded();
  // Windows: Sei stayed for her room and she is gone now, with no window to come back to.
  if (process.platform === 'win32' && stayedForRoom && BrowserWindow.getAllWindows().length === 0) {
    log('her room ended with no window open, quitting');
    app.quit();
  }
}

/**
 * After bootstrap: judge a login launch once the startup restore has run
 * (quiet quit when there is no room), and follow the room from then on.
 */
export async function settleLoginLaunch(): Promise<void> {
  if (!roomWatched) {
    roomWatched = true;
    seilinkHostEvents.on('status', onRoomStatus);
  }
  if (!launch.login) return;
  try {
    await seilinkHostIdle();
  } catch {
    /* judged on the status as it is */
  }
  launch.startupSettled(seilinkRoomUp(seilinkHostStatus()));
}
