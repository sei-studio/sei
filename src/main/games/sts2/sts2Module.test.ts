import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSts2GameModule, worldFromStatus, type Sts2ModuleDeps } from './index';
import { findSts2Install, type Sts2InstallDeps } from './install';
import { linkDirFor, parseStatus, pickLinkPort } from './link';
import { companionArgs, spawnCompanionWindow, type CompanionWindow } from './launch';
import type { Sts2SetupState } from '../../../shared/sts2Ipc';

/** A tiny in-memory file system: files only, folders implied by their paths. */
function fakeFs(platform: NodeJS.Platform, files: Record<string, string> = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const store = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const isDir = (d: string) => [...store.keys()].some((k) => k.startsWith(d.replace(/[\\/]+$/, '') + p.sep));
  const deny = new Set<string>();
  const deps: Sts2InstallDeps = {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\u' : '/Users/u',
    env: platform === 'win32' ? { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } : {},
    exists: async (x) => store.has(x) || isDir(x),
    isDir: async (x) => isDir(x),
    readText: async (x) => store.get(x)?.toString('utf8') ?? null,
    readBytes: async (x) => store.get(x) ?? null,
    listDir: async (d) => {
      const pre = d.replace(/[\\/]+$/, '') + p.sep;
      return [...new Set([...store.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split(p.sep)[0]))];
    },
    copyFile: async (from, to) => {
      if ([...deny].some((d) => to.startsWith(d))) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      const b = store.get(from);
      if (!b) throw new Error(`ENOENT ${from}`);
      store.set(to, b);
    },
    removeFile: async (x) => void store.delete(x),
    registrySteamPath: async () => null,
  };
  return { deps, store, deny, p };
}

const WIN_GAME = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slay the Spire 2';
const WIN_FILES = {
  'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf': '"libraryfolders" { "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "2868840" "1" } } "1" { "path" "D:\\\\Games" } }',
  [`${WIN_GAME}\\SlayTheSpire2.exe`]: 'MZ',
  [`${WIN_GAME}\\UnityCrashHandler64.exe`]: 'MZ',
  [`${WIN_GAME}\\data_sts2_windows_x86_64\\sts2.dll`]: 'x',
  'C:\\Repo\\assets\\sts2-mod\\sei-sts2\\sei-sts2.dll': 'DLL-v1',
  'C:\\Repo\\assets\\sts2-mod\\sei-sts2\\sei-sts2.json': '{"id":"sei-sts2","version":"0.1.0"}',
};

const MAC_LIB = '/Users/u/Library/Application Support/Steam';
const MAC_APP = `${MAC_LIB}/steamapps/common/Slay the Spire 2/SlayTheSpire2.app`;
const MAC_FILES = {
  [`${MAC_LIB}/steamapps/libraryfolders.vdf`]: '"libraryfolders" { "0" { "path" "/Users/u/Library/Application Support/Steam" } }',
  [`${MAC_APP}/Contents/MacOS/Slay the Spire 2`]: 'bin',
  [`${MAC_APP}/Contents/Resources/data_sts2_macos_arm64/sts2.dll`]: 'x',
  '/repo/assets/sts2-mod/sei-sts2/sei-sts2.dll': 'DLL-v1',
  '/repo/assets/sts2-mod/sei-sts2/sei-sts2.json': '{"id":"sei-sts2","version":"0.1.0"}',
};

function fakeWindow(): CompanionWindow & { stopped: number } {
  let alive = true;
  const w = {
    pid: 4242,
    stopped: 0,
    alive: () => alive,
    stop() {
      w.stopped += 1;
      alive = false;
    },
    onExit() {},
  };
  return w;
}

function makeModule(platform: NodeJS.Platform, files: Record<string, string>, extra: Partial<Sts2ModuleDeps> = {}) {
  const fs = fakeFs(platform, files);
  let now = 1_000_000;
  const tracked: string[] = [];
  const opened: string[] = [];
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const linkDir = linkDirFor(platform, fs.deps.home, fs.deps.env);
  const deps: Partial<Sts2ModuleDeps> = {
    install: fs.deps,
    getPackRoot: async () => (platform === 'win32' ? 'C:\\Repo' : '/repo'),
    linkDir,
    readText: fs.deps.readText,
    writeJson: async (file, v) => void fs.store.set(file, Buffer.from(JSON.stringify(v))),
    pickPort: async () => 34871,
    token: () => 'tok',
    openExternal: async (u) => void opened.push(u),
    spawnCompanion: () => {
      const w = fakeWindow();
      windows.push(w);
      return w;
    },
    now: () => now,
    setInterval: () => 1,
    clearInterval: () => {},
    log: () => {},
    track: (i) => void tracked.push(`${i.step}:${i.outcome}${i.error_code ? `:${i.error_code}` : ''}`),
    ...extra,
  };
  const mod = createSts2GameModule(deps);
  const heartbeat = (role: 'host' | 'seat', body: Record<string, unknown>) =>
    fs.store.set(fs.p.join(linkDir, `status-${role}.json`), Buffer.from(JSON.stringify({ ts: now, role, version: '0.1.0', protocol: 1, ...body })));
  return { mod, fs, tracked, opened, windows, linkDir, heartbeat, tick: (ms: number) => (now += ms) };
}

const found = (s: Sts2SetupState) => {
  if (s.kind !== 'found') throw new Error('not found');
  return s;
};

describe('detection', () => {
  it('finds the Windows install through libraryfolders.vdf and skips helper exes', async () => {
    const { deps } = fakeFs('win32', WIN_FILES);
    const r = await findSts2Install(deps);
    expect(r.found).toMatchObject({ binary: `${WIN_GAME}\\SlayTheSpire2.exe`, modsDir: `${WIN_GAME}\\mods`, store: 'steam' });
  });

  it('finds the macOS bundle; mods live inside it', async () => {
    const { deps } = fakeFs('darwin', MAC_FILES);
    const r = await findSts2Install(deps);
    expect(r.found).toMatchObject({ gameDir: MAC_APP, binary: `${MAC_APP}/Contents/MacOS/Slay the Spire 2`, modsDir: `${MAC_APP}/Contents/MacOS/mods` });
  });

  it('reports where it looked when the game is missing', async () => {
    const { mod } = makeModule('win32', {});
    const s = await mod.getSetupState();
    expect(s.kind).toBe('not_found');
    expect(mod.getWorldState()).toEqual({ game: 'sts2', kind: 'not_installed' });
  });
});

describe('mod install', () => {
  it('copies the dll and manifest, then reports it current', async () => {
    const t = makeModule('win32', WIN_FILES);
    const r = await t.mod.runInstall();
    expect(r.ok).toBe(true);
    const s = found(r.state!);
    expect(s).toMatchObject({ modInstalled: true, modCurrent: true, modVersion: '0.1.0', modLoaded: false });
    expect(t.fs.store.get(`${WIN_GAME}\\mods\\sei-sts2.dll`)?.toString()).toBe('DLL-v1');
    expect(t.tracked).toContain('mod_copy:ok');
  });

  it('refuses while the game runs (it holds the dll open)', async () => {
    const t = makeModule('win32', WIN_FILES);
    t.heartbeat('host', { lobby: 'none', screen: 'main_menu' });
    const r = await t.mod.runInstall();
    expect(r).toMatchObject({ ok: false, reason: 'game_running' });
    expect(t.tracked).toContain('mod_copy:fail:STS2_GAME_RUNNING');
  });

  it('macOS App Management refusal without a click asks for the grant', async () => {
    const t = makeModule('darwin', MAC_FILES);
    t.fs.deny.add(`${MAC_APP}/Contents/MacOS/mods`);
    const r = await t.mod.runInstall();
    expect(r).toMatchObject({ ok: false, reason: 'permission' });
    expect(found((await t.mod.getSetupState()) as Sts2SetupState).grantNeeded).toBe(true);
  });

  it('macOS: the Open panel on the mods folder lifts the refusal', async () => {
    const t = makeModule('darwin', MAC_FILES);
    const modsDir = `${MAC_APP}/Contents/MacOS/mods`;
    t.fs.deny.add(modsDir);
    const grant = {
      pickFolder: vi.fn(async () => {
        t.fs.deny.clear();
        return modsDir;
      }),
      finderDuplicate: vi.fn(async () => {}),
      realpath: async (x: string) => x,
      makeTempDir: async () => '/tmp/x',
      fileModes: async () => [],
      chmod: async () => {},
    };
    const r = await t.mod.runInstall({ grant });
    expect(r.ok).toBe(true);
    expect(grant.pickFolder).toHaveBeenCalledTimes(1);
    expect(grant.finderDuplicate).not.toHaveBeenCalled();
    expect(found(r.state!).grantNeeded).toBe(false);
  });

  it('start game installs a missing mod first, then opens Steam', async () => {
    const t = makeModule('win32', WIN_FILES);
    const r = await t.mod.runStartGame();
    expect(r.ok).toBe(true);
    expect(t.opened).toEqual(['steam://rungameid/2868840']);
    expect(t.fs.store.has(`${WIN_GAME}\\mods\\sei-sts2.json`)).toBe(true);
    expect(t.tracked).toEqual(expect.arrayContaining(['start_game:start', 'mod_copy:ok', 'start_game:ok']));
  });
});

describe('watcher', () => {
  it('maps the host heartbeat to world states', () => {
    const hb = (o: Record<string, unknown>) => parseStatus(JSON.stringify({ ts: 1000, role: 'host', ...o }), 'host');
    expect(worldFromStatus(hb({ lobby: 'enet', screen: 'character_select', players: ['Ouen'] }), 2000, true)).toMatchObject({ kind: 'open', detail: { players: ['Ouen'], inRun: false } });
    expect(worldFromStatus(hb({ lobby: 'steam' }), 2000, true)).toMatchObject({ kind: 'no_lobby', lobby: 'steam' });
    expect(worldFromStatus(hb({ lobby: 'enet' }), 60_000, true)).toEqual({ game: 'sts2', kind: 'closed' });
    expect(worldFromStatus(null, 0, false)).toEqual({ game: 'sts2', kind: 'not_installed' });
    expect(parseStatus('{"ts":5,"role":"seat"}', 'host')).toBeNull();
    expect(parseStatus('not json', 'host')).toBeNull();
  });

  it('publishes changes only, and tracks the first lobby once', async () => {
    const t = makeModule('win32', WIN_FILES);
    const seen: string[] = [];
    t.mod.watcher.start({ onUpdate: (s) => seen.push(s.kind) });
    await t.mod.getSetupState();
    t.heartbeat('host', { lobby: 'none', screen: 'main_menu' });
    await t.mod.pollNow();
    await t.mod.pollNow();
    t.heartbeat('host', { lobby: 'enet', screen: 'character_select' });
    await t.mod.pollNow();
    expect(seen).toEqual(['no_lobby', 'open']);
    expect(t.mod.getJoinTarget({} as never)).toMatchObject({ label: 'Slay the Spire 2' });
    t.tick(20_000);
    await t.mod.pollNow();
    expect(seen.at(-1)).toBe('closed');
    expect(t.mod.getJoinTarget({} as never)).toBeNull();
    expect(t.tracked.filter((x) => x === 'lobby_seen:ok')).toHaveLength(1);
    expect(t.tracked.filter((x) => x === 'mod_loaded:ok')).toHaveLength(1);
    t.mod.watcher.stop();
  });
});

describe('session', () => {
  it('prepareJoin writes a fresh link and opens one companion window; session end closes it', async () => {
    const t = makeModule('win32', WIN_FILES);
    t.heartbeat('host', { lobby: 'enet' });
    await t.mod.getSetupState();
    const extra = await t.mod.prepareJoin!({ characterId: 'c1', character: {} as never });
    expect(extra).toEqual({ port: 34871, token: 'tok' });
    expect(JSON.parse(t.fs.store.get(t.fs.p.join(t.linkDir, 'link.json'))!.toString())).toEqual({ v: 1, port: 34871, token: 'tok' });
    expect(t.windows).toHaveLength(1);
    // A re-summon while the window still runs reuses it.
    await t.mod.prepareJoin!({ characterId: 'c1', character: {} as never });
    expect(t.windows).toHaveLength(1);
    t.mod.onSessionEnd!('other');
    expect(t.windows[0].stopped).toBe(0);
    t.mod.onSessionEnd!('c1');
    expect(t.windows[0].stopped).toBe(1);
  });

  it('does not open a second window when a companion window already beats', async () => {
    const t = makeModule('win32', WIN_FILES);
    t.heartbeat('host', { lobby: 'enet' });
    t.heartbeat('seat', { lobby: 'enet' });
    await t.mod.getSetupState();
    await t.mod.prepareJoin!({ characterId: 'c1', character: {} as never });
    expect(t.windows).toHaveLength(0);
  });
});

describe('link + launch helpers', () => {
  it('link folder per OS', () => {
    expect(linkDirFor('darwin', '/Users/u', {})).toBe('/Users/u/Library/Application Support/sei-sts2');
    expect(linkDirFor('win32', 'C:\\Users\\u', { APPDATA: 'C:\\R' })).toBe('C:\\R\\sei-sts2');
    expect(linkDirFor('linux', '/home/u', {})).toBe('/home/u/.config/sei-sts2');
  });

  it('picks the first free port of the range', async () => {
    expect(await pickLinkPort(async (p) => p === 34872)).toBe(34872);
    expect(await pickLinkPort(async () => false)).toBeNull();
  });

  it('starts the companion window with the join switches and its own client id', () => {
    expect(companionArgs()).toEqual(['--windowed', '--force-steam', 'off', '--clientId', '1001', '-fastmp', 'join']);
    const child = Object.assign(new EventEmitter(), { pid: 7, kill: vi.fn() });
    const spawnImpl = vi.fn(() => child as never);
    const w = spawnCompanionWindow('/g/SlayTheSpire2.exe', { spawnImpl, env: {} });
    const [, , opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(opts.env.SEI_STS2_ROLE).toBe('seat');
    expect(w.alive()).toBe(true);
    w.stop(10);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0);
    expect(w.alive()).toBe(false);
  });
});
