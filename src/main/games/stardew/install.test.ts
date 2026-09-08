/**
 * Stardew install support (M1): the GameScanner port's pure helpers, the
 * detection pass over a fake game folder, the mod copy + config write, and
 * the whole install against a local http fixture serving a fake SMAPI
 * installer zip whose "installer" is a shell script that drops
 * StardewModdingAPI.dll into the game folder (skipped on Windows, where the
 * fake installer would be an .exe).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  parseVdf,
  stardewPathFromLibraryFolders,
  parseRegQuery,
  defaultInstallPaths,
  gamePathFromTargets,
  classifyGameFolder,
  candidateGamePaths,
  detectStardew,
  placeMod,
  readModConfig,
  installStardew,
  launcherPath,
  storeFromPath,
  type StardewInstallEnv,
} from './install';

const VDF = `
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"228980"		"123"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"label"		""
		"apps"
		{
			"413150"		"1234567"
			"322330"		"99"
		}
	}
}
`;

describe('scanner helpers (SMAPI GameScanner logic port)', () => {
  it('parses Valve KeyValues and finds the library holding app 413150', () => {
    const root = parseVdf(VDF) as { libraryfolders: Record<string, { path: string; apps: Record<string, string> }> };
    expect(root.libraryfolders['1'].path).toBe('D:\\SteamLibrary');
    expect(root.libraryfolders['1'].apps['413150']).toBe('1234567');
    expect(stardewPathFromLibraryFolders(VDF, 'win32')).toBe(path.join('D:\\SteamLibrary', 'steamapps', 'common', 'Stardew Valley'));
    expect(stardewPathFromLibraryFolders(VDF, 'darwin')).toBe(path.join('D:\\SteamLibrary', 'steamapps', 'common', 'Stardew Valley', 'Contents', 'MacOS'));
    expect(stardewPathFromLibraryFolders('"libraryfolders" { "0" { "path" "/x" "apps" { "1" "2" } } }', 'linux')).toBeNull();
    expect(stardewPathFromLibraryFolders('garbage', 'linux')).toBeNull();
  });

  it('reads one value out of reg query output', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\...\\Steam App 413150\r\n    InstallLocation    REG_SZ    C:\\Games\\Stardew Valley\r\n\r\n';
    expect(parseRegQuery(out, 'InstallLocation')).toBe('C:\\Games\\Stardew Valley');
    expect(parseRegQuery(out, 'Other')).toBeNull();
  });

  it('lists SMAPI default folders per OS, the custom targets path, and the store from the path', () => {
    expect(defaultInstallPaths('darwin', '/Users/x')).toEqual([
      '/Users/x/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS',
      '/Applications/Stardew Valley.app/Contents/MacOS',
    ]);
    const win = defaultInstallPaths('win32', 'C:\\Users\\x');
    expect(win).toContain('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stardew Valley');
    expect(win).toContain('C:\\Program Files\\GOG Galaxy\\Games\\Stardew Valley');
    expect(win.filter((p) => p.includes('ModifiableWindowsApps'))).toHaveLength(6);
    expect(gamePathFromTargets('<Project><PropertyGroup><GamePath>/custom/game</GamePath></PropertyGroup></Project>')).toBe('/custom/game');
    expect(gamePathFromTargets('<Project/>')).toBeNull();
    expect(storeFromPath('/x/steamapps/common/Stardew Valley')).toBe('steam');
    expect(storeFromPath('C:\\Program Files\\GOG Galaxy\\Games\\Stardew Valley')).toBe('gog');
    expect(storeFromPath('D:\\Program Files\\ModifiableWindowsApps\\Stardew Valley')).toBe('xbox');
    expect(launcherPath('/g', 'win32')).toEqual({ exe: path.join('/g', 'StardewModdingAPI.exe'), via: 'smapi-exe' });
    expect(launcherPath('/g', 'darwin')).toEqual({ exe: path.join('/g', 'StardewValley'), via: 'launcher' });
  });
});

describe('detection + install against a fake game folder', () => {
  let root: string;
  let game: string;
  let pack: string;
  let server: Server | null = null;
  let serverUrl = '';
  let installerZip: Buffer;

  const envFor = (over: Partial<StardewInstallEnv> = {}): StardewInstallEnv => ({
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    home: path.join(root, 'home'),
    readRegistry: async () => null,
    getPackRoot: async () => pack,
    tmpDir: () => path.join(root, 'tmp'),
    fetch: (i, o) => fetch(i, o),
    smapiSources: () => [{ url: `${serverUrl}/missing.zip`, connectTimeoutMs: 2000 }, { url: `${serverUrl}/SMAPI-installer.zip` }],
    runInstaller: async (installerPath, args, cwd) => {
      // Run the fake installer script the fixture zip carries (unix only).
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout, stderr } = await promisify(execFile)(installerPath, args, { cwd });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
    now: () => Date.now(),
    ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sei-stardew-'));
    game = path.join(root, 'game');
    pack = path.join(root, 'pack');
    await mkdir(path.join(root, 'home'), { recursive: true });
    await mkdir(game, { recursive: true });
    await writeFile(path.join(game, 'Stardew Valley.dll'), 'x');
    await mkdir(path.join(pack, 'assets', 'stardew-mod', 'SeiCompanion', 'Assets'), { recursive: true });
    await writeFile(path.join(pack, 'assets', 'stardew-mod', 'SeiCompanion', 'SeiCompanion.dll'), 'dll');
    await writeFile(path.join(pack, 'assets', 'stardew-mod', 'SeiCompanion', 'manifest.json'), JSON.stringify({ Version: '0.1.0' }));
    await writeFile(path.join(pack, 'assets', 'stardew-mod', 'SeiCompanion', 'Assets', 'companion.png'), 'png');
    // The custom targets file points at our game folder.
    await writeFile(path.join(root, 'home', 'stardewvalley.targets'), `<Project><PropertyGroup><GamePath>${game}</GamePath></PropertyGroup></Project>`);

    // A fake installer zip: "SMAPI 4.5.2 installer/internal/<os>/SMAPI.Installer" is a script
    // that writes StardewModdingAPI.dll into --game-path.
    const zip = new JSZip();
    const osDir = process.platform === 'darwin' ? 'macOS' : 'linux';
    const script = '#!/bin/sh\nfor a in "$@"; do if [ "$prev" = "--game-path" ]; then gp="$a"; fi; prev="$a"; done\necho "installing to $gp"\nprintf x > "$gp/StardewModdingAPI.dll"\nmkdir -p "$gp/Mods"\n';
    zip.file(`SMAPI 4.5.2 installer/internal/${osDir}/SMAPI.Installer`, script, { unixPermissions: 0o755 });
    zip.file('SMAPI 4.5.2 installer/internal/windows/SMAPI.Installer.exe', 'not a real exe');
    zip.file('SMAPI 4.5.2 installer/README.txt', 'fixture');
    installerZip = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    server = createServer((req, res) => {
      if (req.url === '/SMAPI-installer.zip') {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': installerZip.length });
        res.end(installerZip);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, () => r()));
    serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
    await rm(root, { recursive: true, force: true });
  });

  it('classifies folders and detects the game with nothing installed yet', async () => {
    expect(await classifyGameFolder(game)).toBe('valid');
    expect(await classifyGameFolder(path.join(root, 'nope'))).toBe('none');
    await mkdir(path.join(root, 'legacy'));
    await writeFile(path.join(root, 'legacy', 'Stardew Valley.exe'), 'x');
    expect(await classifyGameFolder(path.join(root, 'legacy'))).toBe('legacy');
    const cands = await candidateGamePaths(envFor());
    expect(cands[0]).toBe(path.normalize(game));
    const state = await detectStardew(envFor());
    expect(state).toMatchObject({ gamePath: path.normalize(game), smapiInstalled: false, modInstalled: false, modConfig: null, ready: false });
    expect(state.candidates.length).toBeGreaterThan(1);
  });

  it('places the mod, writes a config with a fresh token, and keeps the token on a re-run', async () => {
    const cfg = await placeMod(game, pack);
    expect(cfg.Port).toBe(27431);
    expect(cfg.Token).toHaveLength(64);
    const onDisk = await readModConfig(game);
    expect(onDisk?.Token).toBe(cfg.Token);
    expect(await readFile(path.join(game, 'Mods', 'SeiCompanion', 'SeiCompanion.dll'), 'utf8')).toBe('dll');
    expect(await readFile(path.join(game, 'Mods', 'SeiCompanion', 'Assets', 'companion.png'), 'utf8')).toBe('png');
    const again = await placeMod(game, pack, { port: 27500 });
    expect(again.Token).toBe(cfg.Token);
    expect(again.Port).toBe(27500);
    await expect(placeMod(game, path.join(root, 'empty-pack'))).rejects.toThrow(/GAME_INSTALL_FAILED/);
  });

  it.skipIf(process.platform === 'win32')('installs SMAPI from the fixture zip (mirror 404 falls through to origin) then the mod, streaming stages', async () => {
    const stages: string[] = [];
    let pctSeen = 0;
    const state = await installStardew({
      env: envFor(),
      onProgress: (ev) => {
        stages.push(ev.stage);
        if (ev.stage === 'smapi-downloading') pctSeen = Math.max(pctSeen, ev.pct);
      },
    });
    expect(stages[0]).toBe('detecting');
    expect(stages).toContain('smapi-downloading');
    expect(stages).toContain('smapi-installing');
    expect(stages).toContain('mod-placing');
    expect(stages.at(-1)).toBe('done');
    expect(pctSeen).toBe(100);
    expect(state.smapiInstalled).toBe(true);
    expect(state.modInstalled).toBe(true);
    expect(state.modVersion).toBe('0.1.0');
    expect(state.modConfig?.hasToken).toBe(true);
    expect(state.ready).toBe(true);
    // A second run skips SMAPI (already there) and keeps the token.
    const token = (await readModConfig(game))?.Token;
    const stages2: string[] = [];
    await installStardew({ env: envFor(), onProgress: (ev) => stages2.push(ev.stage) });
    expect(stages2).not.toContain('smapi-downloading');
    expect((await readModConfig(game))?.Token).toBe(token);
  });

  it('reports GAME_NOT_INSTALLED with the folders it looked in when the game is absent', async () => {
    await rm(path.join(root, 'home', 'stardewvalley.targets'));
    await rm(game, { recursive: true, force: true });
    const events: unknown[] = [];
    await expect(installStardew({ env: envFor(), onProgress: (ev) => events.push(ev) })).rejects.toThrow(/^GAME_NOT_INSTALLED/);
    expect(events.at(-1)).toMatchObject({ stage: 'failed', error: 'GAME_NOT_INSTALLED' });
  });

  it.skipIf(process.platform === 'win32')('reports SMAPI_INSTALL_FAILED when every download source fails', async () => {
    const events: { stage: string }[] = [];
    await expect(
      installStardew({
        env: envFor({ smapiSources: () => [{ url: `${serverUrl}/missing.zip`, connectTimeoutMs: 2000 }] }),
        onProgress: (ev) => events.push(ev),
      }),
    ).rejects.toThrow(/^SMAPI_INSTALL_FAILED/);
    expect(events.at(-1)).toMatchObject({ stage: 'failed', error: 'SMAPI_INSTALL_FAILED' });
  });
});
