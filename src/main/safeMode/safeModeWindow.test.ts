/**
 * The safe-mode buttons (runSafeModeAction) and the actions behind them:
 * Reset settings covers every profile on the device and keeps identity,
 * Open logs creates the folder first, Try normal start relaunches with the
 * one-shot normal flag written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  relaunch: vi.fn(),
  exit: vi.fn(),
  check: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: { relaunch: h.relaunch, exit: h.exit, isPackaged: false, getPath: () => '/nonexistent' },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { openPath: vi.fn() },
  contextBridge: {},
  ipcRenderer: {},
}));
vi.mock('../updater', () => ({
  checkForUpdatesManual: h.check,
  downloadAcceptedUpdate: h.download,
  installDownloadedUpdate: h.install,
  flushUpdatePushes: vi.fn(),
}));

import { runSafeModeAction, SAFE_MODE_ACTION_CHANNEL, SAFE_MODE_READY_CHANNEL } from './safeModeWindow';
import { listConfigScopes, openLogsFolder, readPageTheme, resetSettingsEverywhere } from './safeModeActions';
import { _setUserDataOverride } from '../paths';
import { _resetBootContextForTests, initBootGuard } from '../bootContext';
import { bootStatePath, readBootStateSync } from '../bootGuard';
import * as preload from '../../preload/safeMode';

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'sei-safe-'));
  _setUserDataOverride(tmp);
  _resetBootContextForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.relaunch.mockClear();
  h.exit.mockClear();
});
afterEach(async () => {
  _setUserDataOverride(null);
  _resetBootContextForTests();
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function writeProfile(scope: string, cfg: Record<string, unknown> | string): Promise<string> {
  const dir = path.join(tmp, 'profiles', scope);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  await writeFile(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return file;
}

describe('channels', () => {
  it('match the preload', () => {
    expect(SAFE_MODE_ACTION_CHANNEL).toBe(preload.SAFE_MODE_ACTION_CHANNEL);
    expect(SAFE_MODE_READY_CHANNEL).toBe(preload.SAFE_MODE_READY_CHANNEL);
  });
});

describe('runSafeModeAction', () => {
  it('routes the update steps to the updater', async () => {
    await expect(runSafeModeAction('check')).resolves.toEqual({ ok: true });
    await runSafeModeAction('download');
    await runSafeModeAction('install');
    expect(h.check).toHaveBeenCalledOnce();
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.install).toHaveBeenCalledOnce();
  });

  it('refuses unknown actions', async () => {
    await expect(runSafeModeAction('rm -rf')).resolves.toEqual({ ok: false });
    await expect(runSafeModeAction(undefined)).resolves.toEqual({ ok: false });
  });

  it('every action the preload allows is handled', async () => {
    for (const a of preload.SAFE_MODE_ACTIONS) {
      if (a === 'normal-start' || a === 'open-logs') continue; // side effects covered below
      await expect(runSafeModeAction(a)).resolves.toHaveProperty('ok');
    }
  });

  it('"Try normal start" writes the one-shot flag, then relaunches', async () => {
    initBootGuard({ userData: tmp, appVersion: '0.7.0', persistent: true, forceSafe: true, now: 1 });
    await runSafeModeAction('normal-start');
    expect(readBootStateSync(bootStatePath(tmp)).forceNormalOnce).toBe(true);
    expect(h.relaunch).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('Reset settings', () => {
  it('resets every profile, keeps identity, sets the old file aside', async () => {
    const local = await writeProfile('local', { preferred_name: 'Ana', theme_mode: 'acorn', analytics_opt_out: true });
    const acct = await writeProfile(U1, { preferred_name: 'Bo', mc_username: 'bo_mc', chat_mode: 'full' });
    await writeProfile('not-a-scope', { preferred_name: 'X' });

    expect(await listConfigScopes()).toEqual([U1, 'local'].sort());
    const r = await resetSettingsEverywhere();
    expect(r).toEqual({ ok: true, profiles: 2, failed: 0 });

    const a = JSON.parse(await readFile(local, 'utf8'));
    expect(a.preferred_name).toBe('Ana');
    expect(a.analytics_opt_out).toBe(true);
    expect(a.theme_mode).not.toBe('acorn');
    const b = JSON.parse(await readFile(acct, 'utf8'));
    expect(b.preferred_name).toBe('Bo');
    expect(b.mc_username).toBe('bo_mc');
    expect(b.chat_mode).not.toBe('full');

    const aside = (await readdir(path.dirname(local))).filter((n) => n.startsWith('config.before-reset-'));
    expect(aside.length).toBe(1);
  });

  it('a damaged profile config still resets', async () => {
    const file = await writeProfile('local', '{"preferred_name": "Ana", "theme_');
    expect((await resetSettingsEverywhere()).ok).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('no profiles = nothing to do, still ok', async () => {
    expect(await resetSettingsEverywhere()).toEqual({ ok: true, profiles: 0, failed: 0 });
  });
});

describe('page theme', () => {
  it('follows the most recently written profile', async () => {
    await writeProfile('local', { theme_mode: 'midnight' });
    await new Promise((r) => setTimeout(r, 15));
    await writeProfile(U1, { theme_mode: 'ice' });
    expect(await readPageTheme()).toBe('light');
  });

  it('is system when nothing is readable', async () => {
    expect(await readPageTheme()).toBe('system');
    await writeProfile('local', 'garbage');
    expect(await readPageTheme()).toBe('system');
  });
});

describe('Open logs folder', () => {
  it('creates the folder and reports the shell result', async () => {
    const open = vi.fn(async () => '');
    expect(await openLogsFolder(open)).toBe(true);
    const dir = path.join(tmp, 'logs');
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(open).toHaveBeenCalledWith(dir);
    expect(await openLogsFolder(async () => 'no handler')).toBe(false);
    expect(await openLogsFolder(async () => { throw new Error('x'); })).toBe(false);
  });
});
