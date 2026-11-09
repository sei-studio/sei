/**
 * 261107 "Open Sei when I log in": the settings file, the OS login item and
 * the launch re-sync, against a fake of Electron's login item API per OS
 * (macOS SMAppService status, Windows HKCU Run values + StartupApproved).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideSync,
  LOGIN_ARG,
  loginItemSettingsFor,
  openAtLoginOwnsLoginItem,
  openAtLoginState,
  osStateFrom,
  parseOpenAtLoginFile,
  readOpenAtLoginFile,
  setOpenAtLogin,
  syncOpenAtLoginAtLaunch,
  unregisterOpenAtLoginForReset,
  windowsLoginTarget,
  windowsTargetKind,
  WIN_RUN_NAME,
  type OpenAtLoginDeps,
} from './openAtLogin';
import { fakeDeps, FakeMac, FakeWin, NSIS_EXE, VELO_EXE, VELO_STUB } from './__fixtures__/fakeLoginItems';
import { OPEN_AT_LOGIN_CHANGED_EVENT, OPEN_AT_LOGIN_FAILED_EVENT } from '../../shared/openAtLogin';

let dir: string;
let file: string;
let events: Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-open-at-login-'));
  file = path.join(dir, 'open-at-login.json');
  events = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function depsFor(fake: FakeMac | FakeWin, over: Partial<OpenAtLoginDeps> = {}): OpenAtLoginDeps {
  return fakeDeps(fake, file, events, over);
}

const saved = () => readOpenAtLoginFile(file);

/* ------------------------------ pure parts -------------------------------- */

describe('pure parts', () => {
  it('points a Velopack install at current\\Sei.exe and an NSIS install at its own exe', () => {
    expect(windowsLoginTarget(VELO_EXE)).toBe(VELO_EXE);
    expect(windowsLoginTarget('C:\\Users\\robin\\AppData\\Local\\Sei\\Current\\Sei.exe')).toBe(
      'C:\\Users\\robin\\AppData\\Local\\Sei\\current\\Sei.exe',
    );
    expect(windowsLoginTarget(NSIS_EXE)).toBe(NSIS_EXE);
  });

  it('points a Velopack install at its root stub when the stub is there', () => {
    expect(windowsLoginTarget(VELO_EXE, (p) => p === VELO_STUB)).toBe(VELO_STUB);
    expect(windowsLoginTarget(VELO_EXE, () => false)).toBe(VELO_EXE);
    // A throwing check is "no stub", never a throw.
    expect(
      windowsLoginTarget(VELO_EXE, () => {
        throw new Error('EACCES');
      }),
    ).toBe(VELO_EXE);
    // NSIS never looks for a stub.
    expect(windowsLoginTarget(NSIS_EXE, () => true)).toBe(NSIS_EXE);
    expect(windowsTargetKind(VELO_EXE, VELO_STUB)).toBe('velopack_stub');
    expect(windowsTargetKind(VELO_EXE, VELO_EXE)).toBe('velopack_current');
    expect(windowsTargetKind(NSIS_EXE, NSIS_EXE)).toBe('exe');
  });

  it('registers on Windows under its own value name with the marker arg', () => {
    expect(loginItemSettingsFor('win32', true, NSIS_EXE)).toEqual({
      openAtLogin: true,
      path: NSIS_EXE,
      args: [LOGIN_ARG],
      name: WIN_RUN_NAME,
      enabled: true,
    });
    expect(WIN_RUN_NAME).not.toBe('com.sei.app');
    expect(loginItemSettingsFor('darwin', false, '/x')).toEqual({ openAtLogin: false });
  });

  it('parses a missing or broken file as off', () => {
    expect(parseOpenAtLoginFile(null)).toEqual({ open_at_login: false, registered: false });
    expect(parseOpenAtLoginFile({ open_at_login: 'yes', registered: 1 })).toEqual({ open_at_login: false, registered: false });
  });

  it('reads the macOS status, macOS 12 openAtLogin, and Windows launch items', () => {
    const mac = (status?: string, openAtLogin = false) =>
      osStateFrom('darwin', { openAtLogin, ...(status ? { status } : {}) } as unknown as Electron.LoginItemSettings);
    expect(mac('enabled')).toBe('on');
    expect(mac('requires-approval')).toBe('disabled');
    expect(mac('not-registered')).toBe('off');
    expect(mac('not-found')).toBe('not_found');
    expect(mac(undefined, true)).toBe('on');
    expect(mac(undefined, false)).toBe('off');
    const win = (items: unknown[]) => osStateFrom('win32', { launchItems: items } as unknown as Electron.LoginItemSettings);
    expect(win([])).toBe('off');
    expect(win([{ name: WIN_RUN_NAME, args: [LOGIN_ARG], scope: 'user', enabled: true }])).toBe('on');
    expect(win([{ name: WIN_RUN_NAME, args: [LOGIN_ARG], scope: 'user', enabled: false }])).toBe('disabled');
    // Real Electron: Chromium's GetArgs() drops switches, so the marker is never in
    // args. The item is Sei's by its value name (beta.2 read every toggle as a mismatch).
    expect(win([{ name: WIN_RUN_NAME, args: [], scope: 'user', enabled: true }])).toBe('on');
    expect(win([{ name: WIN_RUN_NAME, args: [], scope: 'user', enabled: false }])).toBe('disabled');
    expect(win([{ name: WIN_RUN_NAME, args: [], scope: 'machine', enabled: true }])).toBe('off');
    // The retired tray item (named after the AUMID) is not Sei's open-at-login item.
    expect(win([{ name: 'com.sei.app', args: ['--hidden'], scope: 'user', enabled: true }])).toBe('off');
  });

  it('never re-adds an item the user removed or turned off in the OS', () => {
    const on = { open_at_login: true, registered: true };
    expect(decideSync('darwin', on, 'off')).toBe('reflect_off');
    expect(decideSync('darwin', on, 'disabled')).toBe('reflect_off');
    expect(decideSync('win32', on, 'disabled')).toBe('reflect_off');
    expect(decideSync('darwin', { ...on, approval_pending: true }, 'disabled')).toBe('nothing');
    // Windows: a missing value (install moved, old uninstaller) is put back.
    expect(decideSync('win32', on, 'off')).toBe('register');
    // Never registered (the last try failed): try again.
    expect(decideSync('darwin', { open_at_login: true, registered: false }, 'off')).toBe('register');
    expect(decideSync('darwin', on, 'unknown')).toBe('nothing');
  });

  it('only removes a macOS login item Sei registered', () => {
    expect(decideSync('darwin', { open_at_login: false, registered: false }, 'on')).toBe('nothing');
    expect(decideSync('darwin', { open_at_login: false, registered: true }, 'on')).toBe('unregister');
    expect(decideSync('win32', { open_at_login: false, registered: false }, 'on')).toBe('unregister');
  });
});

/* ------------------------------ set --------------------------------------- */

describe('setOpenAtLogin', () => {
  it('is hidden and does nothing where it is not supported', () => {
    const mac = new FakeMac();
    for (const over of [{ isPackaged: false }, { platform: 'linux' as const }, { seilinkSupported: () => false }]) {
      const d = depsFor(mac, over);
      expect(openAtLoginState(d)).toEqual({ supported: false, enabled: false, needsApproval: false, decided: false });
      expect(setOpenAtLogin(true, 'settings', d).enabled).toBe(false);
    }
    expect(mac.status).toBe('not-registered');
    expect(events).toEqual([]);
  });

  it('macOS: registers, reads back, saves, and reports the change', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    expect(openAtLoginState(d)).toEqual({ supported: true, enabled: false, needsApproval: false, decided: false });
    expect(setOpenAtLogin(true, 'setup', d)).toEqual({ supported: true, enabled: true, needsApproval: false, decided: true });
    expect(mac.status).toBe('enabled');
    expect(saved()).toEqual({ open_at_login: true, registered: true, decided: true });
    expect(events).toEqual([[OPEN_AT_LOGIN_CHANGED_EVENT, { enabled: true, surface: 'setup', ok: true, platform: 'darwin' }]]);
    events.length = 0;
    expect(setOpenAtLogin(false, 'settings', d).enabled).toBe(false);
    expect(mac.status).toBe('not-registered');
    expect(saved()).toEqual({ open_at_login: false, registered: false, decided: true });
    expect(events).toEqual([[OPEN_AT_LOGIN_CHANGED_EVENT, { enabled: false, surface: 'settings', ok: true, platform: 'darwin' }]]);
  });

  it('macOS 13+: an item waiting for approval stays on with the note', () => {
    const mac = new FakeMac();
    mac.needsApproval = true;
    const d = depsFor(mac);
    expect(setOpenAtLogin(true, 'settings', d)).toEqual({ supported: true, enabled: true, needsApproval: true, decided: true });
    expect(events.map((e) => e[0])).toEqual([OPEN_AT_LOGIN_FAILED_EVENT, OPEN_AT_LOGIN_CHANGED_EVENT]);
    expect(events[0][1]).toMatchObject({ failure_class: 'requires_approval', phase: 'set' });
    // Still waiting at the next launch: kept, not read as "the user turned it off".
    expect(syncOpenAtLoginAtLaunch(d)).toBe('nothing');
    expect(openAtLoginState(d).needsApproval).toBe(true);
    // Approved in System Settings: the note goes.
    mac.status = 'enabled';
    syncOpenAtLoginAtLaunch(d);
    expect(openAtLoginState(d)).toEqual({ supported: true, enabled: true, needsApproval: false, decided: true });
  });

  it('a throw or a read-back mismatch flips the switch back and sends the failure class', () => {
    const mac = new FakeMac();
    mac.throwOnSet = true;
    expect(setOpenAtLogin(true, 'settings', depsFor(mac)).enabled).toBe(false);
    expect(events[0]).toEqual([
      OPEN_AT_LOGIN_FAILED_EVENT,
      { failure_class: 'register_threw', phase: 'set', enabled: true, platform: 'darwin', os_state: 'off', launch_items: 0 },
    ]);
    expect(events[1][1]).toMatchObject({ ok: false });
    events.length = 0;
    const win = new FakeWin();
    const d = depsFor(win, { setLoginItemSettings: () => {} });
    expect(setOpenAtLogin(true, 'settings', d).enabled).toBe(false);
    expect(events[0][1]).toMatchObject({
      failure_class: 'readback_mismatch',
      platform: 'win32',
      os_state: 'off',
      launch_items: 0,
      target_kind: 'exe',
    });
    expect(saved().open_at_login).toBe(false);
  });

  it('a read that throws is read_threw', () => {
    const mac = new FakeMac();
    const d = depsFor(mac, {
      getLoginItemSettings: () => {
        throw new Error('nope');
      },
    });
    setOpenAtLogin(true, 'settings', d);
    expect(events[0][1]).toMatchObject({ failure_class: 'read_threw' });
  });

  it('Windows: writes its own Run value for the install exe, with the marker', () => {
    const win = new FakeWin();
    const d = depsFor(win);
    expect(setOpenAtLogin(true, 'settings', d).enabled).toBe(true);
    expect(win.run.get(WIN_RUN_NAME)).toEqual({ path: NSIS_EXE, args: [LOGIN_ARG], enabled: true });
    expect(saved()).toEqual({ open_at_login: true, registered: true, registered_path: NSIS_EXE, decided: true });
    setOpenAtLogin(false, 'settings', d);
    expect(win.run.size).toBe(0);
  });

  it('an off the OS did not take keeps `registered`, and the next launch removes it', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    mac.ignoreSet = true;
    setOpenAtLogin(false, 'settings', d);
    expect(saved()).toEqual({ open_at_login: false, registered: true, decided: true });
    mac.ignoreSet = false;
    expect(syncOpenAtLoginAtLaunch(d)).toBe('unregister');
    expect(mac.status).toBe('not-registered');
    expect(saved()).toEqual({ open_at_login: false, registered: false, decided: true });
  });

  it('macOS: "Not now" from the setup step marks it decided without touching the OS item', () => {
    const mac = new FakeMac();
    // A login item the user added by hand: Sei never registered it, so "Not now" must leave it.
    mac.status = 'enabled';
    let sets = 0;
    const d = depsFor(mac, {
      setLoginItemSettings: (s: Electron.Settings) => {
        sets++;
        mac.set(s);
      },
    });
    expect(openAtLoginState(d).decided).toBe(false);
    expect(setOpenAtLogin(false, 'setup', d)).toEqual({ supported: true, enabled: false, needsApproval: false, decided: true });
    expect(sets).toBe(0);
    expect(mac.status).toBe('enabled');
    expect(saved()).toEqual({ open_at_login: false, registered: false, decided: true });
    expect(events).toEqual([[OPEN_AT_LOGIN_CHANGED_EVENT, { enabled: false, surface: 'setup', ok: true, platform: 'darwin' }]]);
  });

  it('decided is sticky across launch syncs, and an older file that was on counts as decided', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    // Removed in Login Items: reflected off, still decided.
    mac.status = 'not-registered';
    syncOpenAtLoginAtLaunch(d);
    expect(saved()).toMatchObject({ open_at_login: false, decided: true });
    expect(openAtLoginState(d).decided).toBe(true);
    // A file from before `decided` existed.
    writeFileSync(file, JSON.stringify({ open_at_login: true, registered: true }));
    expect(openAtLoginState(d).decided).toBe(true);
    writeFileSync(file, JSON.stringify({ open_at_login: false, registered: false }));
    expect(openAtLoginState(d).decided).toBe(false);
  });
});

/* ------------------------------ launch sync ------------------------------- */

describe('syncOpenAtLoginAtLaunch', () => {
  it('macOS: removed in Login Items = off in Sei, not re-added, reported as surface os', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    events.length = 0;
    mac.status = 'not-registered';
    expect(syncOpenAtLoginAtLaunch(d)).toBe('reflect_off');
    expect(mac.status).toBe('not-registered');
    expect(openAtLoginState(d).enabled).toBe(false);
    expect(events).toEqual([[OPEN_AT_LOGIN_CHANGED_EVENT, { enabled: false, surface: 'os', ok: true, platform: 'darwin' }]]);
    // And it stays that way.
    expect(syncOpenAtLoginAtLaunch(d)).toBe('nothing');
    expect(mac.status).toBe('not-registered');
  });

  it('macOS: turned off after it had been on (requires-approval) = off in Sei', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    mac.status = 'requires-approval';
    expect(syncOpenAtLoginAtLaunch(d)).toBe('reflect_off');
    expect(openAtLoginState(d).enabled).toBe(false);
  });

  it('macOS: leaves a login item the user added by hand alone', () => {
    const mac = new FakeMac();
    mac.status = 'enabled';
    expect(syncOpenAtLoginAtLaunch(depsFor(mac))).toBe('nothing');
    expect(mac.status).toBe('enabled');
  });

  it('macOS 12 (no status) syncs from openAtLogin', () => {
    const mac = new FakeMac();
    mac.legacy = true;
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    expect(syncOpenAtLoginAtLaunch(d)).toBe('nothing');
    mac.status = 'not-registered';
    expect(syncOpenAtLoginAtLaunch(d)).toBe('reflect_off');
  });

  it('Windows: turned off in Task Manager = off in Sei, never re-enabled', () => {
    const win = new FakeWin();
    const d = depsFor(win);
    setOpenAtLogin(true, 'settings', d);
    win.disable();
    expect(syncOpenAtLoginAtLaunch(d)).toBe('reflect_off');
    expect(win.run.get(WIN_RUN_NAME)?.enabled).toBe(false);
    expect(openAtLoginState(d).enabled).toBe(false);
    expect(syncOpenAtLoginAtLaunch(d)).toBe('unregister');
  });

  it('Windows: NSIS -> Velopack re-points the same value at the Velopack exe', () => {
    const win = new FakeWin();
    setOpenAtLogin(true, 'settings', depsFor(win));
    const velo = depsFor(win, { execPath: VELO_EXE });
    expect(syncOpenAtLoginAtLaunch(velo)).toBe('register');
    expect([...win.run.keys()]).toEqual([WIN_RUN_NAME]);
    expect(win.run.get(WIN_RUN_NAME)).toEqual({ path: VELO_EXE, args: [LOGIN_ARG], enabled: true });
    expect(saved().registered_path).toBe(VELO_EXE);
    // The old NSIS uninstaller (build/installer.nsh) only removes a value for its own exe; a
    // value removed anyway is put back at the next launch.
    win.run.clear();
    expect(syncOpenAtLoginAtLaunch(velo)).toBe('register');
    expect(win.run.get(WIN_RUN_NAME)?.path).toBe(VELO_EXE);
  });

  it('Windows: turning it on reads back on although Electron drops the marker switch', () => {
    const win = new FakeWin();
    const d = depsFor(win);
    expect(setOpenAtLogin(true, 'settings', d).enabled).toBe(true);
    // The value starts Sei with the marker (a login launch, loginLaunch.ts) ...
    expect(win.run.get(WIN_RUN_NAME)?.args).toEqual([LOGIN_ARG]);
    // ... and the read-back (args without switches) still sees it as on.
    expect(win.get({ path: NSIS_EXE } as Electron.LoginItemSettingsOptions).launchItems[0].args).toEqual([]);
    expect(events.find(([e]) => e === OPEN_AT_LOGIN_FAILED_EVENT)).toBeUndefined();
    expect(events.at(-1)).toEqual([OPEN_AT_LOGIN_CHANGED_EVENT, { enabled: true, surface: 'settings', ok: true, platform: 'win32' }]);
    // The next launch leaves it alone; off removes it.
    expect(syncOpenAtLoginAtLaunch(d)).toBe('nothing');
    expect(setOpenAtLogin(false, 'settings', d).enabled).toBe(false);
    expect(win.run.size).toBe(0);
    expect(events.find(([e]) => e === OPEN_AT_LOGIN_FAILED_EVENT)).toBeUndefined();
  });

  it('Windows Velopack: registers the root stub, and re-points an older current\\ value to it', () => {
    const win = new FakeWin();
    // An install from before the stub rule registered current\Sei.exe.
    setOpenAtLogin(true, 'settings', depsFor(win, { execPath: VELO_EXE, exists: () => false }));
    expect(win.run.get(WIN_RUN_NAME)?.path).toBe(VELO_EXE);
    const withStub = depsFor(win, { execPath: VELO_EXE, exists: (p) => p === VELO_STUB });
    expect(syncOpenAtLoginAtLaunch(withStub)).toBe('register');
    expect([...win.run.keys()]).toEqual([WIN_RUN_NAME]);
    expect(win.run.get(WIN_RUN_NAME)).toEqual({ path: VELO_STUB, args: [LOGIN_ARG], enabled: true });
    expect(saved().registered_path).toBe(VELO_STUB);
    expect(syncOpenAtLoginAtLaunch(withStub)).toBe('nothing');
    expect(openAtLoginState(withStub).enabled).toBe(true);
  });

  it('Windows: an item turned off before the install moved stays off', () => {
    const win = new FakeWin();
    setOpenAtLogin(true, 'settings', depsFor(win));
    win.disable();
    expect(syncOpenAtLoginAtLaunch(depsFor(win, { execPath: VELO_EXE }))).toBe('reflect_off');
    expect(win.run.get(WIN_RUN_NAME)).toMatchObject({ path: NSIS_EXE, enabled: false });
  });

  it('Windows: a stray Sei item with the setting off (factory reset, a lost file) is removed', () => {
    const win = new FakeWin();
    win.set(loginItemSettingsFor('win32', true, NSIS_EXE));
    expect(syncOpenAtLoginAtLaunch(depsFor(win))).toBe('unregister');
    expect(win.run.size).toBe(0);
  });

  it('a failed re-register keeps the choice for the next launch and reports phase sync', () => {
    const win = new FakeWin();
    const d = depsFor(win);
    setOpenAtLogin(true, 'settings', d);
    win.run.clear();
    events.length = 0;
    expect(
      syncOpenAtLoginAtLaunch(
        depsFor(win, {
          setLoginItemSettings: () => {
            throw new Error('access denied');
          },
        }),
      ),
    ).toBe('failed');
    expect(saved().open_at_login).toBe(true);
    expect(events[0]).toEqual([
      OPEN_AT_LOGIN_FAILED_EVENT,
      { failure_class: 'register_threw', phase: 'sync', enabled: true, platform: 'win32', os_state: 'off', launch_items: 0, target_kind: 'exe' },
    ]);
  });

  it('does nothing unsupported, and reads no OS state on macOS when never used', () => {
    expect(syncOpenAtLoginAtLaunch(depsFor(new FakeMac(), { isPackaged: false }))).toBe('unsupported');
    let reads = 0;
    const mac = new FakeMac();
    expect(
      syncOpenAtLoginAtLaunch(
        depsFor(mac, {
          getLoginItemSettings: () => {
            reads++;
            return mac.get();
          },
        }),
      ),
    ).toBe('nothing');
    expect(reads).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe('ownership and factory reset', () => {
  it('owns the login item while the setting is on or registered', () => {
    expect(openAtLoginOwnsLoginItem(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ open_at_login: true, registered: true }));
    expect(openAtLoginOwnsLoginItem(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ open_at_login: false, registered: true }));
    expect(openAtLoginOwnsLoginItem(file)).toBe(true);
    writeFileSync(file, '{oops');
    expect(openAtLoginOwnsLoginItem(file)).toBe(false);
  });

  it('factory reset removes the item and the file', () => {
    const mac = new FakeMac();
    const d = depsFor(mac);
    setOpenAtLogin(true, 'settings', d);
    unregisterOpenAtLoginForReset(d);
    expect(mac.status).toBe('not-registered');
    expect(existsSync(file)).toBe(false);
    const win = new FakeWin();
    const w = depsFor(win);
    setOpenAtLogin(true, 'settings', w);
    unregisterOpenAtLoginForReset(w);
    expect(win.run.size).toBe(0);
  });
});
