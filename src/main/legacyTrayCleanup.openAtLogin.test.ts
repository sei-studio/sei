/**
 * 261107: the retired tray mode's leftover cleanup (legacyTrayCleanup.ts)
 * must never remove the "Open on login" item (seilink/openAtLogin.ts).
 * Runs both the way index.ts does at launch, cleanup first and then the sync,
 * against fakes of the macOS and Windows login item APIs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), setLoginItemSettings: () => {} },
}));

import { cleanupLegacyTraySettings, type LegacyTrayCleanupDeps } from './legacyTrayCleanup';
import {
  openAtLoginOwnsLoginItem,
  openAtLoginState,
  setOpenAtLogin,
  syncOpenAtLoginAtLaunch,
  WIN_RUN_NAME,
} from './seilink/openAtLogin';
import { fakeDeps, FakeMac, FakeWin, NSIS_EXE } from './seilink/__fixtures__/fakeLoginItems';

let dir: string;
let trayFile: string;
let loginFile: string;
let events: Array<[string, Record<string, unknown>]>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-legacy-vs-login-'));
  trayFile = path.join(dir, 'tray-settings.json');
  loginFile = path.join(dir, 'open-at-login.json');
  events = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const legacyOptedIn = { enabled: true, open_at_login: true, login_item_registered: true };

function cleanupDeps(fake: FakeMac | FakeWin): LegacyTrayCleanupDeps {
  const mac = fake instanceof FakeMac;
  return {
    filePath: trayFile,
    platform: mac ? 'darwin' : 'win32',
    isPackaged: true,
    execPath: mac ? '/Applications/Sei.app/Contents/MacOS/Sei' : NSIS_EXE,
    setLoginItemSettings: fake.set,
    // The real default reads the same file.
    ownedByOpenAtLogin: () => openAtLoginOwnsLoginItem(loginFile),
    log: () => {},
  };
}

/** index.ts at ready: cleanupLegacyTraySettings(), then startOpenAtLoginAtReady(). */
function launch(fake: FakeMac | FakeWin): { cleanup: string; sync: string } {
  const cleanup = cleanupLegacyTraySettings(cleanupDeps(fake));
  const sync = syncOpenAtLoginAtLaunch(fakeDeps(fake, loginFile, events));
  return { cleanup, sync };
}

describe('legacy tray cleanup vs open at login', () => {
  it('macOS: a leftover tray file never takes the item the new setting holds', () => {
    const mac = new FakeMac();
    setOpenAtLogin(true, 'setup', fakeDeps(mac, loginFile, events));
    writeFileSync(trayFile, JSON.stringify(legacyOptedIn));
    expect(launch(mac)).toEqual({ cleanup: 'removed', sync: 'nothing' });
    expect(mac.status).toBe('enabled');
    expect(existsSync(trayFile)).toBe(false);
    expect(openAtLoginState(fakeDeps(mac, loginFile, events)).enabled).toBe(true);
    // And the next launch keeps it.
    expect(launch(mac)).toEqual({ cleanup: 'none', sync: 'nothing' });
    expect(mac.status).toBe('enabled');
  });

  it('macOS: with the new setting off, the retired item is removed and stays removed', () => {
    const mac = new FakeMac();
    mac.status = 'enabled'; // registered by 0.6.8-beta.1/2
    writeFileSync(trayFile, JSON.stringify(legacyOptedIn));
    expect(launch(mac)).toEqual({ cleanup: 'removed-with-login-item', sync: 'nothing' });
    expect(mac.status).toBe('not-registered');
  });

  it('macOS: an unreadable ownership check leaves the item', () => {
    const mac = new FakeMac();
    mac.status = 'enabled';
    writeFileSync(trayFile, JSON.stringify(legacyOptedIn));
    const d = {
      ...cleanupDeps(mac),
      ownedByOpenAtLogin: () => {
        throw new Error('EACCES');
      },
    };
    expect(cleanupLegacyTraySettings(d)).toBe('removed');
    expect(mac.status).toBe('enabled');
  });

  it('Windows: the retired value goes, Sei\'s own Run value is untouched', () => {
    const win = new FakeWin();
    // The retired item: Electron's default name (the AppUserModelId), --hidden.
    win.set({ openAtLogin: true, path: NSIS_EXE, args: ['--hidden'] });
    setOpenAtLogin(true, 'settings', fakeDeps(win, loginFile, events));
    expect([...win.run.keys()].sort()).toEqual(['com.sei.app', WIN_RUN_NAME].sort());
    writeFileSync(trayFile, JSON.stringify(legacyOptedIn));
    expect(launch(win)).toEqual({ cleanup: 'removed-with-login-item', sync: 'nothing' });
    expect([...win.run.keys()]).toEqual([WIN_RUN_NAME]);
    expect(win.run.get(WIN_RUN_NAME)).toMatchObject({ path: NSIS_EXE, args: ['--seilink-login'], enabled: true });
  });

  it('Windows: a Sei value lost before the cleanup is put back by the sync that follows it', () => {
    const win = new FakeWin();
    setOpenAtLogin(true, 'settings', fakeDeps(win, loginFile, events));
    win.run.delete(WIN_RUN_NAME);
    writeFileSync(trayFile, JSON.stringify(legacyOptedIn));
    expect(launch(win)).toEqual({ cleanup: 'removed-with-login-item', sync: 'register' });
    expect(win.run.get(WIN_RUN_NAME)?.enabled).toBe(true);
  });

  it('index.ts runs the cleanup before the open-at-login sync', () => {
    const src = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    const cleanup = src.indexOf('cleanupLegacyTraySettings();');
    const sync = src.indexOf('startOpenAtLoginAtReady()');
    expect(cleanup).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(cleanup);
  });
});
