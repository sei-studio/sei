import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { WorldState } from '../../../shared/gameIpc';
import { createFactorioGameModule, effectiveFactorioName, type FactorioModuleDeps } from './index';
import type { LaunchPlan, LogWatchDeps } from './launch';
import type { LinkRecord } from './link';
import type { ProbeResult } from './watcher';
import { memFs } from './testFs';
import type { SetupStepInput } from '../../../shared/setupTelemetry';

const PACK = path.join(path.sep, 'pack');
const STEAM = 'D:\\SteamLibrary\\steamapps\\common\\Factorio';
const MODS = 'C:\\Users\\you\\AppData\\Roaming\\Factorio\\mods';
const VDF = '"libraryfolders" { "0" { "path" "D:\\\\SteamLibrary" "apps" { "427520" "1" } } }';
const HELLO = { ok: true, protocol: 1, players: [{ i: 1, name: 'ouen' }], multiplayer: false, world: '1-60' };

function rig(opts: { version?: string; running?: boolean; noGame?: boolean; free?: (p: number) => boolean } = {}) {
  const files: Record<string, string> = {
    [path.join(PACK, 'assets', 'factorio-mod', 'sei-companion', 'info.json')]: JSON.stringify({ name: 'sei-companion', version: '0.1.0' }),
    'C:\\Steam\\steam.exe': 'x',
    'C:\\Steam\\steamapps\\libraryfolders.vdf': VDF,
  };
  if (!opts.noGame) {
    files[`${STEAM}\\bin\\x64\\factorio.exe`] = 'bin';
    files[`${STEAM}\\data\\base\\info.json`] = JSON.stringify({ version: opts.version ?? '2.1.4' });
  }
  const fs = memFs('win32', files, { registry: { SteamPath: 'C:\\Steam', SteamExe: 'C:/Steam/steam.exe' }, running: opts.running ?? false });
  let link: LinkRecord = { port: null, bad: [] };
  const spawned: LaunchPlan[] = [];
  let probe: ProbeResult = { kind: 'refused' };
  const logTimers: Array<() => void> = [];
  const events: SetupStepInput[] = [];
  let logText: string | null = null;
  const logWatch: LogWatchDeps = {
    readText: async () => logText,
    mtime: async () => (logText == null ? null : Date.now() + 10_000),
    setTimer: (fn) => (logTimers.push(fn), logTimers.length),
    clearTimer: () => undefined,
    now: () => Date.now(),
  };
  const deps: Partial<FactorioModuleDeps> = {
    install: fs.deps,
    links: { read: async () => link, write: async (r) => void (link = r) },
    getPackRoot: async () => PACK,
    probe: async () => probe,
    spawn: async (p) => void spawned.push(p),
    isPortFree: async (p) => (opts.free ? opts.free(p) : true),
    logWatch,
    intervalMs: 60_000,
    log: () => undefined,
    track: (e) => void events.push(e),
  };
  const mod = createFactorioGameModule(deps);
  return {
    mod,
    fs,
    spawned,
    events,
    get link() {
      return link;
    },
    setProbe: (r: ProbeResult) => void (probe = r),
    failLog: async () => {
      logText = 'Opening Lua UDP Socket failed';
      const fns = logTimers.splice(0);
      for (const f of fns) f();
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

describe('Factorio game module', () => {
  it('names the companion like the bot does', () => {
    expect(effectiveFactorioName({ name: 'Sui', username: null })).toBe('Sui');
    expect(effectiveFactorioName({ name: '', username: '  ' })).toBe('Sei');
  });

  it('refuses to launch without a supported game', async () => {
    expect(await rig({ noGame: true }).mod.runLaunch()).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await rig({ version: '2.0.72' }).mod.runLaunch()).toMatchObject({ ok: false, reason: 'unsupported_version' });
    const running = rig({ running: true });
    expect(await running.mod.runLaunch()).toMatchObject({ ok: false, reason: 'game_running' });
    expect(running.spawned).toHaveLength(0);
    expect(running.events.at(-1)).toMatchObject({ step: 'launch', outcome: 'fail', error_code: 'FACTORIO_GAME_RUNNING', reason: 'game_running' });
  });

  it('installs the mod, starts Steam with the link, remembers the port', async () => {
    const r = rig({ free: (p) => p !== 34990 });
    const res = await r.mod.runLaunch();
    expect(res).toMatchObject({ ok: true, port: 34991 });
    expect(r.fs.files.has(`${MODS}\\sei-companion_0.1.0\\info.json`)).toBe(true);
    expect(r.spawned).toEqual([{ cmd: 'C:\\Steam\\steam.exe', args: ['-applaunch', '427520', '--enable-lua-udp', '34991'], via: 'steam' }]);
    expect(r.link.port).toBe(34991);
    // A second launch while the module believes nothing runs reuses the port.
    await r.mod.runLaunch();
    expect(r.spawned[1].args).toContain('34991');
    // Setup telemetry: shape only, one find_game per distinct answer.
    const steps = r.events.map((e) => `${e.step}:${e.outcome}`);
    expect(steps.filter((x) => x.startsWith('find_game'))).toEqual(['find_game:ok']);
    expect(steps).toEqual(expect.arrayContaining(['launch:start', 'mod_copy:start', 'mod_copy:ok', 'launch:ok']));
    expect(r.events.find((e) => e.step === 'launch' && e.outcome === 'ok')).toMatchObject({ game: 'factorio', store: 'steam' });
    for (const e of r.events) expect(JSON.stringify(e)).not.toMatch(/SteamLibrary|AppData|ouen/);
  });

  it('joins only while the mod answers, and marks the port when Factorio could not open it', async () => {
    const r = rig();
    const seen: WorldState[] = [];
    r.mod.watcher.start({ onUpdate: (s) => seen.push(s) });
    expect(r.mod.getJoinTarget({} as never)).toBeNull();
    expect(r.mod.joinTargetMissingError.error).toBe('GAME_WORLD_NOT_OPEN');
    await r.mod.runLaunch();
    r.setProbe({ kind: 'reply', reply: HELLO });
    expect((await r.mod.watcher.checkNow()).kind).toBe('open');
    expect(r.mod.getJoinTarget({} as never)).toEqual({ port: 34990, label: 'Factorio' });

    r.setProbe({ kind: 'refused' });
    await r.mod.watcher.checkNow();
    await r.mod.watcher.checkNow();
    await r.failLog();
    expect(r.mod.getWorldState()).toEqual({ game: 'factorio', kind: 'unavailable', reason: 'udp_port_in_use' });
    expect(r.link.bad).toContain(34990);
    expect(seen.at(-1)?.kind).toBe('unavailable');
    expect(r.events.filter((e) => e.step === 'world_seen')).toHaveLength(1);
    expect(r.events).toContainEqual(expect.objectContaining({ step: 'link_port', outcome: 'fail', error_code: 'FACTORIO_UDP_PORT_IN_USE' }));
    r.mod.watcher.stop();
    // The next launch moves to another port.
    await r.mod.runLaunch();
    expect(r.spawned.at(-1)?.args).toContain('34991');
  });
});
