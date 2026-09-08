/** Game-adapters M2 (260908): DST install detection + mod install against fixtures. */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import {
  needsRestart,
  parseLibraryFolders,
  findDstInstall,
  rewriteModSettings,
  modsDirFor,
  resolveModSource,
  detectInstall,
  installMod,
  enableMod,
  modVersionFrom,
  steamRootCandidates,
  type InstallDeps,
} from './install';

const VDF = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"123"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t\t"apps"
\t\t{
\t\t\t"322330"\t\t"5555555"
\t\t\t"413150"\t\t"1"
\t\t}
\t}
}
`;

function fakeFs(files: Record<string, string>, dirs: string[] = [], platform: NodeJS.Platform = 'win32'): InstallDeps & { writes: Record<string, string>; copies: [string, string][] } {
  const writes: Record<string, string> = {};
  const copies: [string, string][] = [];
  const all = () => ({ ...files, ...writes });
  return {
    mtime: async (p) => (p in all() ? 1000 : null),
    gameProcess: async () => ({ running: false, startedAt: null }),
    platform,
    home: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me',
    env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' },
    exists: async (p) => dirs.includes(p) || p in all(),
    readText: async (p) => all()[p] ?? null,
    writeText: async (p, t) => { writes[p] = t; },
    copyDir: async (from, to) => { copies.push([from, to]); },
    listDir: async () => [],
    registrySteamPath: async () => null,
    writes,
    copies,
  };
}

describe('libraryfolders.vdf', () => {
  it('parses the modern shape with paths unescaped and app ids per library', () => {
    expect(parseLibraryFolders(VDF)).toEqual([
      { path: 'C:\\Program Files (x86)\\Steam', apps: ['228980'] },
      { path: 'D:\\SteamLibrary', apps: ['322330', '413150'] },
    ]);
  });
  it('parses the legacy "1" "path" shape and tolerates junk', () => {
    expect(parseLibraryFolders('"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t"1"\n\t"1"\t\t"E:\\\\Games"\n}')).toEqual([{ path: 'E:\\Games', apps: [] }]);
    expect(parseLibraryFolders('')).toEqual([]);
    expect(parseLibraryFolders('not vdf at all')).toEqual([]);
  });
});

describe('findDstInstall', () => {
  it('prefers the library that lists app 322330 and reports the searched paths otherwise', async () => {
    // The default root is joined by node's path on whatever OS runs the test.
    const root = path.join('C:\\Program Files (x86)', 'Steam');
    const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
    const install = path.join('D:\\SteamLibrary', 'steamapps', 'common', "Don't Starve Together");
    const deps = fakeFs({ [vdfPath]: VDF }, [install]);
    const r = await findDstInstall(deps);
    expect(r.found).toEqual({ installPath: install, modsDir: path.join(install, 'mods') });
    expect(r.searched[0]).toBe(install);

    const none = await findDstInstall(fakeFs({ [vdfPath]: VDF }));
    expect(none.found).toBeNull();
    expect(none.searched.length).toBeGreaterThanOrEqual(2);
  });
  it('uses the registry SteamPath first on Windows and the .app bundle mods dir on macOS', async () => {
    const deps = fakeFs({}, [path.join('X:\\Steam', 'steamapps', 'common', "Don't Starve Together")]);
    deps.registrySteamPath = async () => 'X:\\Steam';
    expect((await findDstInstall(deps)).found?.installPath).toBe(path.join('X:\\Steam', 'steamapps', 'common', "Don't Starve Together"));
    const mac = modsDirFor('/Users/me/Library/Application Support/Steam/steamapps/common/Don\'t Starve Together', 'darwin');
    expect(mac).toBe("/Users/me/Library/Application Support/Steam/steamapps/common/Don't Starve Together/dontstarve_steam.app/Contents/mods");
    expect(steamRootCandidates({ platform: 'darwin', home: '/Users/me', env: {} })).toEqual(['/Users/me/Library/Application Support/Steam']);
  });
});

describe('modsettings.lua', () => {
  const shipped = '-- Use the "ForceEnableMod" function when developing a mod.\n--ForceEnableMod("kioskmode_dst")\n\n-- Use "EnableModDebugPrint()" to show extra information during startup.\n--EnableModDebugPrint()\n';
  it('adds the two live lines once, preserves everything else, and is idempotent', () => {
    const once = rewriteModSettings(shipped);
    expect(once).toContain('--ForceEnableMod("kioskmode_dst")');
    expect(once).toMatch(/\nForceEnableMod\("sei"\)\n/);
    expect(once).toMatch(/\nDisableLocalModWarning\(\)\n$/);
    expect(rewriteModSettings(once)).toBe(once);
    expect(once.split('ForceEnableMod("sei")').length).toBe(2);
  });
  it('starts from nothing and fills in only the missing line', () => {
    expect(rewriteModSettings(null)).toBe('-- Added by Sei (the companion helper). Safe to leave in place.\nForceEnableMod("sei")\nDisableLocalModWarning()\n');
    const partial = 'ForceEnableMod("sei")\n';
    expect(rewriteModSettings(partial)).toContain('DisableLocalModWarning()');
    expect(rewriteModSettings(partial).split('ForceEnableMod("sei")').length).toBe(2);
  });
});

describe('install + detect', () => {
  const root = '/Users/me/Library/Application Support/Steam';
  const vdfPath = path.join(root, 'steamapps', 'libraryfolders.vdf');
  const install = path.join(root, 'steamapps', 'common', "Don't Starve Together");
  const modsDir = path.join(install, 'dontstarve_steam.app', 'Contents', 'mods');
  const vdfMac = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t\t"apps"\n\t\t{\n\t\t\t"322330"\t\t"1"\n\t\t}\n\t}\n}\n`;

  it('resolves the mod source from the pack assets first, then the dev tree', async () => {
    const deps = fakeFs({ '/pack/assets/dst-mod/sei/modinfo.lua': 'version = "0.1.0"' }, [], 'darwin');
    expect(await resolveModSource('/pack', deps)).toBe('/pack/assets/dst-mod/sei');
    const dev = fakeFs({ '/repo/native/dst-mod/sei/modinfo.lua': 'version = "0.1.0"' }, [], 'darwin');
    expect(await resolveModSource('/repo', dev)).toBe('/repo/native/dst-mod/sei');
    expect(await resolveModSource('/nothing', dev)).toBeNull();
    expect(modVersionFrom('name = "x"\nversion = "0.1.0"\n')).toBe('0.1.0');
    expect(modVersionFrom(null)).toBeNull();
  });

  it('copies the mod into the game and force-enables it; detect reads it back', async () => {
    const deps = fakeFs({ [vdfPath]: vdfMac, '/pack/assets/dst-mod/sei/modinfo.lua': 'version = "0.1.0"' }, [install], 'darwin');
    const before = await detectInstall(deps);
    expect(before).toMatchObject({ kind: 'found', installPath: install, modsDir, modInstalled: false, enabled: false });
    const progress = vi.fn();
    const after = await installMod({ packRoot: '/pack', onProgress: progress }, deps);
    expect(deps.copies).toEqual([['/pack/assets/dst-mod/sei', path.join(modsDir, 'sei')]]);
    expect(deps.writes[path.join(modsDir, 'modsettings.lua')]).toContain('ForceEnableMod("sei")');
    expect(progress.mock.calls.map((c) => c[0])).toEqual(['copying', 'enabling']);
    // The copy is faked, so modinfo is not on "disk": enabled is what detect can see.
    expect(after).toMatchObject({ kind: 'found', enabled: true });
    // enable() is a no-op when the file is already right.
    const writesBefore = Object.keys(deps.writes).length;
    await enableMod(modsDir, deps);
    expect(Object.keys(deps.writes).length).toBe(writesBefore);
  });

  it('reports not_found with the searched paths and a missing pack as GAME_INSTALL_FAILED', async () => {
    expect(await detectInstall(fakeFs({}, [], 'darwin'))).toMatchObject({ kind: 'not_found' });
    const deps = fakeFs({ [vdfPath]: vdfMac }, [install], 'darwin');
    expect(await installMod({ packRoot: '/nothing' }, deps)).toMatchObject({ kind: 'error', error: 'GAME_INSTALL_FAILED' });
  });
});

describe('needsRestart (260909)', () => {
  it('is true only for a running game that started before the helper landed', () => {
    expect(needsRestart({ running: true, startedAt: 500 }, 1000, 900)).toBe(true);
    expect(needsRestart({ running: true, startedAt: 500 }, 400, 1000)).toBe(true);
    expect(needsRestart({ running: true, startedAt: 1500 }, 1000, 900)).toBe(false);
    expect(needsRestart({ running: false, startedAt: 500 }, 1000, 900)).toBe(false);
    // Unknown start time makes no claim; missing files make none either.
    expect(needsRestart({ running: true, startedAt: null }, 1000, 900)).toBe(false);
    expect(needsRestart({ running: true, startedAt: 500 }, null, null)).toBe(false);
  });

  it('detectInstall reports gameRunning + needsRestart from the process listing', async () => {
    const root = '/Users/me/Library/Application Support/Steam';
    const install = path.join(root, 'steamapps', 'common', "Don't Starve Together");
    const modsDir = path.join(install, 'dontstarve_steam.app', 'Contents', 'mods');
    const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t\t"apps"\n\t\t{\n\t\t\t"322330"\t\t"1"\n\t\t}\n\t}\n}\n`;
    const deps = fakeFs(
      {
        [path.join(root, 'steamapps', 'libraryfolders.vdf')]: vdf,
        [path.join(modsDir, 'sei', 'modinfo.lua')]: 'version = "0.2.0"',
        [path.join(modsDir, 'modsettings.lua')]: '-- x\nForceEnableMod("sei")\nDisableLocalModWarning()\n',
      },
      [install],
      'darwin',
    );
    deps.gameProcess = async () => ({ running: true, startedAt: 500 });
    expect(await detectInstall(deps)).toMatchObject({ kind: 'found', modInstalled: true, enabled: true, gameRunning: true, needsRestart: true });
    deps.gameProcess = async () => ({ running: true, startedAt: 5000 });
    expect(await detectInstall(deps)).toMatchObject({ gameRunning: true, needsRestart: false });
    deps.gameProcess = async () => { throw new Error('ps missing'); };
    expect(await detectInstall(deps)).toMatchObject({ gameRunning: false, needsRestart: false });
  });
});
