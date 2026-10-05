/**
 * trayController (261005): the close interception, the quit flags, the
 * update-quit rule, the tray:hidden push that ends calls and screen capture,
 * the login item ownership flag and the AUMID. Electron is mocked; the
 * platform is faked per test (the code paths are mac/win only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => {
  const state = {
    file: '',
    appEvents: null as unknown as import('node:events').EventEmitter,
    updaterEvents: null as unknown as import('node:events').EventEmitter,
    iconEmpty: false,
    trays: [] as unknown[],
  };
  return state;
});

const app = vi.hoisted(() => ({
  on: (ev: string, fn: (...a: unknown[]) => void) => h.appEvents.on(ev, fn),
  quit: vi.fn(),
  focus: vi.fn(),
  isPackaged: true,
  getAppPath: () => '/app',
  getLoginItemSettings: vi.fn(() => ({}) as Record<string, unknown>),
  setLoginItemSettings: vi.fn(),
  setAppUserModelId: vi.fn(),
}));
const ipcMain = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock('electron', () => ({
  app,
  ipcMain,
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: {
    createFromPath: vi.fn(() => ({ isEmpty: () => h.iconEmpty, setTemplateImage: vi.fn() })),
  },
  Notification: Object.assign(function Notification() {}, { isSupported: () => false }),
  powerMonitor: { on: vi.fn() },
  Tray: class {
    constructor() {
      h.trays.push(this);
    }
    setToolTip(): void {}
    on(): void {}
    destroy(): void {}
    popUpContextMenu(): void {}
  },
  get autoUpdater() {
    return h.updaterEvents;
  },
}));
vi.mock('../paths', () => ({ paths: { traySettingsPath: () => h.file } }));
vi.mock('../configStore', () => ({ loadConfig: async () => ({}) }));

type Ctl = typeof import('./trayController');

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

let dir: string;

function writeState(s: Record<string, unknown>): void {
  writeFileSync(h.file, JSON.stringify(s));
}
function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(h.file, 'utf8')) as Record<string, unknown>;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
/** Wait until every queued tray-settings.json write has landed. */
const drainWrites = async (): Promise<void> => {
  await flush();
  await (await import('./trayStateStore')).updateTrayState((s) => s);
};

interface FakeWin extends EventEmitter {
  hide: ReturnType<typeof vi.fn>;
  isFullScreen: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
}
function fakeWin(fullscreen = false): FakeWin {
  const w = new EventEmitter() as FakeWin;
  w.hide = vi.fn();
  w.isFullScreen = vi.fn(() => fullscreen);
  w.setFullScreen = vi.fn();
  w.isDestroyed = () => false;
  w.isVisible = () => true;
  w.webContents = { send: vi.fn(), isDestroyed: () => false };
  return w;
}

function close(win: FakeWin): { preventDefault: ReturnType<typeof vi.fn> } {
  const e = { preventDefault: vi.fn() };
  win.emit('close', e);
  return e;
}

async function setup(
  opts: { platform?: NodeJS.Platform; state?: Record<string, unknown>; updateReady?: boolean; bots?: boolean } = {},
): Promise<{ ctl: Ctl; win: FakeWin; deps: Record<string, ReturnType<typeof vi.fn>> }> {
  setPlatform(opts.platform ?? 'win32');
  if (opts.state) writeState(opts.state);
  const ctl = await import('./trayController');
  const deps = {
    getMainWindow: vi.fn(() => null),
    showMainWindow: vi.fn(),
    isUpdateReady: vi.fn(() => opts.updateReady ?? false),
    installUpdate: vi.fn(),
    hasLiveBotSessions: vi.fn(() => opts.bots ?? false),
    capture: vi.fn(),
  };
  ctl.initTray(deps);
  await flush();
  const win = fakeWin();
  ctl.attachCloseToTray(win as unknown as Electron.BrowserWindow);
  return { ctl, win, deps };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(os.tmpdir(), 'sei-trayctl-'));
  h.file = path.join(dir, 'tray-settings.json');
  h.appEvents = new EventEmitter();
  h.updaterEvents = new EventEmitter();
  h.iconEmpty = false;
  h.trays = [];
  app.isPackaged = true;
  (process as unknown as { resourcesPath: string }).resourcesPath = '/res';
});
afterEach(async () => {
  // Drain this test's queued state writes before its directory goes away.
  await drainWrites();
  setPlatform(realPlatform);
  rmSync(dir, { recursive: true, force: true });
});

describe('close interception', () => {
  it('hides the window and tells the renderer to end the call and capture', async () => {
    const { ctl, win } = await setup({ state: { enabled: true } });
    expect(ctl.isTrayShown()).toBe(true);
    const e = close(win);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('tray:hidden');
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('closes normally with the setting off', async () => {
    const { ctl, win } = await setup({ state: { enabled: false } });
    expect(ctl.isTrayShown()).toBe(false);
    const e = close(win);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('closes normally when the tray icon could not be created', async () => {
    h.iconEmpty = true;
    const { ctl, win } = await setup({ state: { enabled: true } });
    expect(ctl.isTrayShown()).toBe(false);
    expect(close(win).preventDefault).not.toHaveBeenCalled();
  });

  it('closes normally on Linux', async () => {
    const { win } = await setup({ platform: 'linux', state: { enabled: true } });
    expect(close(win).preventDefault).not.toHaveBeenCalled();
  });

  it('takes a macOS fullscreen window out of fullscreen before hiding it', async () => {
    const { ctl } = await setup({ platform: 'darwin', state: { enabled: true } });
    const win = fakeWin(true);
    ctl.attachCloseToTray(win as unknown as Electron.BrowserWindow);
    close(win);
    expect(win.setFullScreen).toHaveBeenCalledWith(false);
    expect(win.hide).not.toHaveBeenCalled();
    win.emit('leave-full-screen');
    expect(win.hide).toHaveBeenCalled();
  });
});

describe('quit flag', () => {
  it('before-quit lets every later close through', async () => {
    const { ctl, win } = await setup({ state: { enabled: true } });
    h.appEvents.emit('before-quit');
    expect(ctl.isQuitting()).toBe(true);
    expect(close(win).preventDefault).not.toHaveBeenCalled();
  });

  it('quitAndInstall (before-quit-for-update) lets the close through', async () => {
    const { ctl, win } = await setup({ state: { enabled: true } });
    h.updaterEvents.emit('before-quit-for-update');
    expect(ctl.isQuitting()).toBe(true);
    expect(close(win).preventDefault).not.toHaveBeenCalled();
  });

  it('Windows logoff / shutdown lets the close through', async () => {
    const { win } = await setup({ state: { enabled: true } });
    win.emit('query-session-end');
    expect(close(win).preventDefault).not.toHaveBeenCalled();
  });
});

describe('update ready on close', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    it(`${platform}: quits so the update installs instead of hiding`, async () => {
      const { ctl, win } = await setup({ platform, state: { enabled: true }, updateReady: true });
      const e = close(win);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalledTimes(1);
      expect(win.hide).not.toHaveBeenCalled();
      expect(ctl.isQuitting()).toBe(true);
      // The close quit() triggers is let through.
      expect(close(win).preventDefault).not.toHaveBeenCalled();
    });
  }

  it('hides as usual while a bot session is live', async () => {
    const { win } = await setup({ state: { enabled: true }, updateReady: true, bots: true });
    close(win);
    expect(app.quit).not.toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
  });
});

describe('login item ownership', () => {
  it('never touches the login item of a user who has not turned it on', async () => {
    await setup({ platform: 'darwin', state: { enabled: false } });
    await setup({ platform: 'darwin', state: { enabled: true } });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('registers it, records that, and removes only its own', async () => {
    await setup({ platform: 'darwin', state: { enabled: true, open_at_login: true } });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true });
    await drainWrites();
    expect(readState().login_item_registered).toBe(true);

    // Turning the setting off from Settings removes it.
    const setHandler = ipcMain.handle.mock.calls.find((c) => c[0] === 'tray:set')![1] as (
      e: unknown,
      raw: unknown,
    ) => Promise<unknown>;
    app.setLoginItemSettings.mockClear();
    await setHandler(null, { enabled: false, source: 'settings' });
    await drainWrites();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, openAsHidden: false });
    expect(readState().login_item_registered).toBe(false);
  });

  it('Windows registers the hidden launch arg', async () => {
    await setup({ platform: 'win32', state: { enabled: true, open_at_login: true } });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: true, args: ['--hidden'] }),
    );
  });

  it('factory reset removes a login item Sei registered, and only that', async () => {
    await setup({ platform: 'darwin', state: { enabled: false, login_item_registered: true } });
    // Startup with the setting off cleans up the one it registered.
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, openAsHidden: false });
    await drainWrites();
    app.setLoginItemSettings.mockClear();
    vi.resetModules();
    writeState({ enabled: true, open_at_login: true, login_item_registered: true });
    const ctl = await import('./trayController');
    ctl.unregisterLoginItemForReset();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false, openAsHidden: false });

    app.setLoginItemSettings.mockClear();
    vi.resetModules();
    writeState({ enabled: false });
    const ctl2 = await import('./trayController');
    ctl2.unregisterLoginItemForReset();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('dev builds never register the Electron binary', async () => {
    app.isPackaged = false;
    await setup({ platform: 'darwin', state: { enabled: true, open_at_login: true } });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe('applyAppUserModelId', () => {
  it('sets the appId on Windows only', async () => {
    const ctl = await import('./trayController');
    ctl.applyAppUserModelId('darwin');
    expect(app.setAppUserModelId).not.toHaveBeenCalled();
    ctl.applyAppUserModelId('win32');
    expect(app.setAppUserModelId).toHaveBeenCalledWith('com.sei.app');
  });
});
