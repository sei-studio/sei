import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  detectFactorio,
  enableInModList,
  installMod,
  isSupportedVersion,
  layoutFor,
  modEnabledIn,
  modIsCurrent,
  parseModEntry,
  publicState,
  usesSystemDataDirs,
  versionFromInfoJson,
} from './install';
import { memFs } from './testFs';

const info = (v: string): string => JSON.stringify({ name: 'base', version: v });
const modInfo = (v: string): string => JSON.stringify({ name: 'sei-companion', version: v, factorio_version: '2.1' });
// The pack root is a host path (packs.ts / the repo root in dev).
const PACK = path.join(path.sep, 'pack');
const packFiles = (v: string): Record<string, string> => ({
  [path.join(PACK, 'assets', 'factorio-mod', 'sei-companion', 'info.json')]: modInfo(v),
  [path.join(PACK, 'assets', 'factorio-mod', 'sei-companion', 'control.lua')]: '-- mod',
});

describe('factorio install layout', () => {
  it('maps install folders to the binary and data root', () => {
    expect(layoutFor('C:\\Program Files\\Factorio', 'win32', 'standalone')).toEqual({
      binary: 'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe',
      root: 'C:\\Program Files\\Factorio',
      store: 'standalone',
    });
    expect(layoutFor('/Applications/factorio.app', 'darwin', 'standalone')).toEqual({
      binary: '/Applications/factorio.app/Contents/MacOS/factorio',
      root: '/Applications/factorio.app/Contents',
      store: 'standalone',
    });
    expect(layoutFor('/Users/you/Library/Application Support/Steam/steamapps/common/Factorio', 'darwin', 'steam').binary).toBe(
      '/Users/you/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio',
    );
  });

  it('reads versions and gates on 2.1', () => {
    expect(versionFromInfoJson(info('2.1.3'))).toBe('2.1.3');
    expect(versionFromInfoJson('{bad')).toBeNull();
    expect(isSupportedVersion('2.1.0')).toBe(true);
    expect(isSupportedVersion('2.1')).toBe(true);
    expect(isSupportedVersion('2.0.72')).toBe(false);
    expect(isSupportedVersion('1.1.110')).toBe(false);
    expect(isSupportedVersion(null)).toBeNull();
  });

  it('honours config-path.cfg', () => {
    expect(usesSystemDataDirs(null)).toBe(true);
    expect(usesSystemDataDirs('config-path=__PATH__executable__/../../config\nuse-system-read-write-data-directories=false\n')).toBe(false);
    expect(usesSystemDataDirs('use-system-read-write-data-directories=true')).toBe(true);
  });
});

describe('detectFactorio', () => {
  it('finds Windows Steam through the registry library list, with %APPDATA% data', async () => {
    const vdf = '"libraryfolders" { "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "570" "1" } } "1" { "path" "D:\\\\SteamLibrary" "apps" { "427520" "1" } } }';
    const { deps } = memFs('win32', {
      'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf': vdf,
      'D:\\SteamLibrary\\steamapps\\common\\Factorio\\bin\\x64\\factorio.exe': 'bin',
      'D:\\SteamLibrary\\steamapps\\common\\Factorio\\data\\base\\info.json': info('2.1.4'),
    }, { registry: { SteamPath: 'C:\\Program Files (x86)\\Steam' } });
    const s = await detectFactorio(deps);
    expect(s.kind).toBe('found');
    if (s.kind !== 'found') return;
    expect(s.install).toEqual({ binary: 'D:\\SteamLibrary\\steamapps\\common\\Factorio\\bin\\x64\\factorio.exe', store: 'steam', version: '2.1.4', supported: true });
    expect(s.userDataDir).toBe('C:\\Users\\you\\AppData\\Roaming\\Factorio');
    expect(s.modsDir).toBe('C:\\Users\\you\\AppData\\Roaming\\Factorio\\mods');
    expect(s.modInstalled).toBe(false);
    expect(publicState(s)).not.toHaveProperty('candidate');
  });

  it('finds the Windows standalone install', async () => {
    const { deps } = memFs('win32', {
      'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe': 'bin',
      'C:\\Program Files\\Factorio\\data\\base\\info.json': info('2.1.0'),
    });
    const s = await detectFactorio(deps);
    expect(s.kind === 'found' && s.install.store).toBe('standalone');
  });

  it('uses the install folder for a portable (zip) install', async () => {
    const { deps } = memFs('win32', {
      'C:\\Program Files\\Factorio\\bin\\x64\\factorio.exe': 'bin',
      'C:\\Program Files\\Factorio\\config-path.cfg': 'use-system-read-write-data-directories=false',
    });
    const s = await detectFactorio(deps);
    expect(s.kind === 'found' && s.userDataDir).toBe('C:\\Program Files\\Factorio');
  });

  it('finds macOS Steam and standalone, preferring a supported version', async () => {
    const steam = '/Users/you/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents';
    const { deps } = memFs('darwin', {
      [`${steam}/MacOS/factorio`]: 'bin',
      [`${steam}/data/base/info.json`]: info('2.0.72'),
      '/Applications/factorio.app/Contents/MacOS/factorio': 'bin',
      '/Applications/factorio.app/Contents/data/base/info.json': info('2.1.1'),
    });
    const s = await detectFactorio(deps);
    if (s.kind !== 'found') throw new Error('not found');
    expect(s.install.store).toBe('standalone');
    expect(s.install.version).toBe('2.1.1');
    expect(s.others.map((o) => o.version)).toEqual(['2.0.72']);
    expect(s.userDataDir).toBe('/Users/you/Library/Application Support/factorio');
  });

  it('reports where it looked when nothing is installed', async () => {
    const { deps } = memFs('darwin', {});
    const s = await detectFactorio(deps);
    expect(s.kind).toBe('not_found');
    if (s.kind === 'not_found') expect(s.searched).toContain('/Applications/factorio.app/Contents/MacOS/factorio');
  });
});

describe('mod-list.json', () => {
  it('enables sei-companion and keeps everything else', () => {
    const before = JSON.stringify({ mods: [{ name: 'base', enabled: true }, { name: 'space-age', enabled: true }, { name: 'sei-companion', enabled: false }] });
    const after = JSON.parse(enableInModList(before));
    expect(after.mods).toEqual([{ name: 'base', enabled: true }, { name: 'space-age', enabled: true }, { name: 'sei-companion', enabled: true }]);
    expect(enableInModList(enableInModList(before))).toBe(enableInModList(before));
  });

  it('creates a list when the file is absent and refuses a foreign file', () => {
    expect(JSON.parse(enableInModList(null)).mods).toEqual([{ name: 'base', enabled: true }, { name: 'sei-companion', enabled: true }]);
    expect(() => enableInModList('{"not":"a list"}')).toThrow();
    expect(() => enableInModList('{oops')).toThrow();
  });

  it('reads the enabled flag', () => {
    expect(modEnabledIn(null)).toBe(true);
    expect(modEnabledIn('{"mods":[{"name":"sei-companion","enabled":false}]}')).toBe(false);
    expect(modEnabledIn('{"mods":[{"name":"base","enabled":true}]}')).toBe(true);
  });

  it('recognises copies of the mod only', () => {
    expect(parseModEntry('sei-companion_0.1.0')).toEqual({ version: '0.1.0', zip: false });
    expect(parseModEntry('sei-companion_0.1.0.zip')).toEqual({ version: '0.1.0', zip: true });
    expect(parseModEntry('sei-companion')).toEqual({ version: null, zip: false });
    expect(parseModEntry('sei-testkit_0.1.0')).toBeNull();
    expect(parseModEntry('mod-list.json')).toBeNull();
  });
});

describe('installMod', () => {
  const mods = 'C:\\Users\\you\\AppData\\Roaming\\Factorio\\mods';

  it('copies into sei-companion_<version>, removes old copies, enables it', async () => {
    const fs = memFs('win32', {
      ...packFiles('0.2.0'),
      [`${mods}\\sei-companion_0.1.0\\info.json`]: modInfo('0.1.0'),
      [`${mods}\\sei-companion_0.0.9.zip`]: 'zip',
      [`${mods}\\other-mod_1.0.0.zip`]: 'zip',
      [`${mods}\\mod-list.json`]: JSON.stringify({ mods: [{ name: 'base', enabled: true }, { name: 'other-mod', enabled: false }] }),
    });
    expect(await modIsCurrent(PACK, mods, fs.deps)).toBe(false);
    const r = await installMod({ packRoot: PACK, modsDir: mods }, fs.deps);
    expect(r).toEqual({ version: '0.2.0', folder: 'sei-companion_0.2.0' });
    const names = await fs.deps.listDir(mods);
    expect(names.sort()).toEqual(['mod-list.json', 'other-mod_1.0.0.zip', 'sei-companion_0.2.0']);
    expect(fs.files.get(`${mods}\\sei-companion_0.2.0\\control.lua`)).toBe('-- mod');
    expect(JSON.parse(fs.files.get(`${mods}\\mod-list.json`)!).mods).toContainEqual({ name: 'sei-companion', enabled: true });
    expect(JSON.parse(fs.files.get(`${mods}\\mod-list.json`)!).mods).toContainEqual({ name: 'other-mod', enabled: false });
    expect(await modIsCurrent(PACK, mods, fs.deps)).toBe(true);
  });

  it('falls back to the repo path in dev', async () => {
    const fs = memFs('darwin', {
      [path.join(PACK, 'native', 'factorio-mod', 'sei-companion', 'info.json')]: modInfo('0.1.0'),
    });
    const r = await installMod({ packRoot: PACK, modsDir: '/Users/you/Library/Application Support/factorio/mods' }, fs.deps);
    expect(r.folder).toBe('sei-companion_0.1.0');
  });

  it('refuses while Factorio runs, and leaves an unreadable mod list alone', async () => {
    const running = memFs('win32', packFiles('0.2.0'), { running: true });
    await expect(installMod({ packRoot: PACK, modsDir: mods }, running.deps)).rejects.toMatchObject({ reason: 'game_running' });
    const broken = memFs('win32', { ...packFiles('0.2.0'), [`${mods}\\sei-companion_0.1.0\\info.json`]: modInfo('0.1.0'), [`${mods}\\mod-list.json`]: '{oops' });
    await expect(installMod({ packRoot: PACK, modsDir: mods }, broken.deps)).rejects.toMatchObject({ reason: 'failed' });
    expect(broken.files.has(`${mods}\\sei-companion_0.1.0\\info.json`)).toBe(true);
  });

  it('reports a pack without the mod', async () => {
    const fs = memFs('win32', {});
    await expect(installMod({ packRoot: PACK, modsDir: mods }, fs.deps)).rejects.toMatchObject({ reason: 'mod_missing' });
  });
});
