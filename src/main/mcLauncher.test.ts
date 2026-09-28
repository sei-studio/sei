/**
 * R1b (260929): Start Minecraft selects the Sei profile (lastUsed = now in
 * every launcher file that has it) and opens the launcher. The real open and
 * the launcher's preselect need a Mac / Windows machine; these cover the
 * profile pick, the file writes and the launcher candidate order.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openPath: vi.fn() } }));
vi.mock('./paths', () => ({ paths: { userData: () => os.tmpdir() } }));

import {
  findSeiProfile,
  launcherCandidates,
  startMinecraft,
  STORE_LAUNCHER_AUMID,
  tasklistHasLauncher,
  type LauncherEnv,
} from './mcLauncher';

let tmp: string;
let mcDir: string;
const SUPPORTED = ['1.21.1', '1.21.4', '26.1', '26.2', '26.3'];

async function writeProfiles(file: string, profiles: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(path.join(mcDir, file), JSON.stringify({ profiles, settings: {}, version: 3, ...extra }));
}

async function withSkinMod(gameDir: string): Promise<void> {
  await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });
  await fs.writeFile(path.join(gameDir, 'mods', 'CustomSkinLoader_Fabric-14.28.jar'), 'jar');
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(mcDir, file), 'utf8'));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-launcher-'));
  mcDir = path.join(tmp, '.minecraft');
  await fs.mkdir(mcDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('findSeiProfile', () => {
  it('picks a Fabric profile with the skin mod on a supported version, newest first', async () => {
    const g121 = path.join(mcDir, 'sei', '1.21.1');
    const g261 = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g121);
    await withSkinMod(g261);
    await writeProfiles('launcher_profiles.json', {
      vanilla: { name: 'Latest', type: 'latest-release', lastVersionId: 'latest-release' },
      nomod: { name: 'Fabric 26.3', lastVersionId: 'fabric-loader-0.19.5-26.3', gameDir: path.join(mcDir, 'plain') },
      old: { name: 'Sei 1.21.1', lastVersionId: 'fabric-loader-0.19.3-1.21.1', gameDir: g121 },
      cur: { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g261 },
      snap: { name: 'Sei 27.0', lastVersionId: 'fabric-loader-0.19.5-27.0', gameDir: g261 },
    });
    const found = await findSeiProfile(mcDir, { supported: SUPPORTED });
    expect(found).toMatchObject({ key: 'cur', name: 'Sei 26.1', mcVersion: '26.1' });
    const pref = await findSeiProfile(mcDir, { supported: SUPPORTED, preferred: '1.21.1' });
    expect(pref).toMatchObject({ key: 'old', mcVersion: '1.21.1' });
  });

  it('merges the same profile across the standard and Store launcher files', async () => {
    const g = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g);
    const entry = { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g };
    await writeProfiles('launcher_profiles.json', { 'sei-26.1': entry });
    await writeProfiles('launcher_profiles_microsoft_store.json', { other: entry });
    const found = await findSeiProfile(mcDir, { supported: SUPPORTED });
    expect(found?.files.map((f) => [path.basename(f.file), f.key])).toEqual([
      ['launcher_profiles.json', 'sei-26.1'],
      ['launcher_profiles_microsoft_store.json', 'other'],
    ]);
  });

  it('returns null with no Sei-ready profile', async () => {
    await writeProfiles('launcher_profiles.json', {
      f: { name: 'Fabric', lastVersionId: 'fabric-loader-0.19.5-26.1' },
    });
    expect(await findSeiProfile(mcDir, { supported: SUPPORTED })).toBeNull();
  });
});

function env(platform: NodeJS.Platform, present: string[], mtimes: Record<string, number> = {}): LauncherEnv {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const set = new Set(present.map(norm));
  return {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\you' : '/Users/you',
    env:
      platform === 'win32'
        ? {
            LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local',
            ProgramFiles: 'C:\\Program Files',
            'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            SystemDrive: 'C:',
          }
        : {},
    exists: async (p) => set.has(norm(p)),
    mtimeMs: async (p) => mtimes[norm(p)] ?? null,
  };
}

describe('launcherCandidates', () => {
  it('macOS: Minecraft.app, then the bundle id', async () => {
    const c = await launcherCandidates(env('darwin', ['/Applications/Minecraft.app']), null);
    expect(c.map((x) => [x.via, x.target])).toEqual([
      ['path', '/Applications/Minecraft.app'],
      ['bundle-id', 'com.mojang.minecraftlauncher'],
    ]);
  });

  it('Windows: the Store / Xbox launcher by its AUMID when its package is installed', async () => {
    const c = await launcherCandidates(
      env('win32', ['C:\\Users\\you\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe']),
      'C:\\Users\\you\\AppData\\Roaming\\.minecraft',
    );
    expect(c).toEqual([{ kind: 'windows-store', via: 'aumid', target: STORE_LAUNCHER_AUMID }]);
  });

  it('Windows: the legacy exe, and with both, whichever launcher wrote its profiles last goes first', async () => {
    const mc = 'C:\\Users\\you\\AppData\\Roaming\\.minecraft';
    const legacy = 'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe';
    const only = await launcherCandidates(env('win32', [legacy]), mc);
    expect(only).toEqual([{ kind: 'windows', via: 'path', target: legacy }]);

    const storeFile = `${mc}\\launcher_profiles_microsoft_store.json`;
    const legacyFile = `${mc}\\launcher_profiles.json`;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const legacyNewer = await launcherCandidates(
      env('win32', [legacy, storeFile], { [norm(storeFile)]: 1, [norm(legacyFile)]: 2 }),
      mc,
    );
    expect(legacyNewer.map((x) => x.kind)).toEqual(['windows', 'windows-store']);
    const storeNewer = await launcherCandidates(
      env('win32', [legacy, storeFile], { [norm(storeFile)]: 3, [norm(legacyFile)]: 2 }),
      mc,
    );
    expect(storeNewer.map((x) => x.kind)).toEqual(['windows-store', 'windows']);
  });

  it('Linux (dev only) has no launcher to open', async () => {
    expect(await launcherCandidates(env('linux', []), null)).toEqual([]);
  });
});

describe('tasklistHasLauncher', () => {
  it('spots the legacy and Store launcher processes only', () => {
    expect(tasklistHasLauncher('"explorer.exe","1","Console","1","10 K"\r\n"MinecraftLauncher.exe","2","Console","1","9 K"')).toBe(true);
    expect(tasklistHasLauncher('"Minecraft.exe","3","Console","1","9 K"')).toBe(true);
    expect(tasklistHasLauncher('"javaw.exe","4","Console","1","9 K"\r\n"MinecraftServer.exe","5"')).toBe(false);
  });
});

describe('startMinecraft', () => {
  const macEnv = (): LauncherEnv => env('darwin', ['/Applications/Minecraft.app']);

  it('stamps lastUsed on the Sei profile in every launcher file, then opens the launcher', async () => {
    const g = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g);
    const entry = { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g, lastUsed: '2026-01-01T00:00:00.000Z' };
    await writeProfiles('launcher_profiles.json', {
      mine: { name: 'Mine', lastVersionId: '1.21.4', lastUsed: '2026-09-28T00:00:00.000Z' },
      'sei-26.1': entry,
    });
    await writeProfiles('launcher_profiles_microsoft_store.json', { 'sei-26.1': entry }, { selectedProfile: 'mine' });
    const open = vi.fn(async () => undefined);
    const now = new Date('2026-09-29T12:00:00.000Z');
    const res = await startMinecraft({}, { env: macEnv(), mcDir, open, isRunning: async () => false, supported: SUPPORTED, now });
    expect(res).toEqual({ ok: true, profileName: 'Sei 26.1', mcVersion: '26.1', launcher: 'mac', alreadyOpen: false });
    expect(open).toHaveBeenCalledWith({ kind: 'mac', via: 'path', target: '/Applications/Minecraft.app' });

    const a = await readJson('launcher_profiles.json');
    expect(a.profiles['sei-26.1'].lastUsed).toBe(now.toISOString());
    expect(a.profiles.mine.lastUsed).toBe('2026-09-28T00:00:00.000Z');
    const b = await readJson('launcher_profiles_microsoft_store.json');
    expect(b.profiles['sei-26.1'].lastUsed).toBe(now.toISOString());
    expect(b.selectedProfile).toBe('sei-26.1');
  });

  it('reports an already-open launcher so the UI says to pick the profile', async () => {
    const g = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g);
    await writeProfiles('launcher_profiles.json', { s: { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g } });
    const res = await startMinecraft({}, { env: macEnv(), mcDir, open: async () => undefined, isRunning: async () => true, supported: SUPPORTED });
    expect(res).toMatchObject({ ok: true, alreadyOpen: true });
  });

  it('no Sei profile: nothing opens', async () => {
    await writeProfiles('launcher_profiles.json', {});
    const open = vi.fn();
    const res = await startMinecraft({}, { env: macEnv(), mcDir, open, isRunning: async () => false, supported: SUPPORTED });
    expect(res).toEqual({ ok: false, reason: 'no_profile' });
    expect(open).not.toHaveBeenCalled();
  });

  it('falls through launcher candidates and reports launch_failed with the profile name', async () => {
    const g = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g);
    await writeProfiles('launcher_profiles.json', { s: { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g } });
    const open = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await startMinecraft({}, { env: macEnv(), mcDir, open, isRunning: async () => false, supported: SUPPORTED });
    expect(open).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: false, reason: 'launch_failed', profileName: 'Sei 26.1' });
  });

  it('no launcher installed: the profile is still selected and the result says so', async () => {
    const g = path.join(mcDir, 'sei', '26.1');
    await withSkinMod(g);
    await writeProfiles('launcher_profiles.json', { s: { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: g } });
    const res = await startMinecraft({}, { env: env('win32', []), mcDir, isRunning: async () => false, supported: SUPPORTED });
    expect(res).toEqual({ ok: false, reason: 'no_launcher', profileName: 'Sei 26.1' });
    expect((await readJson('launcher_profiles.json')).profiles.s.lastUsed).toMatch(/^\d{4}-/);
  });
});
