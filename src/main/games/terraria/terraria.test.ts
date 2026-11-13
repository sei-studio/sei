import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  detectTerraria,
  installTerrariaMod,
  parseLink,
  paths,
  readTmodHeader,
  steamAppsInLibraries,
  tmlSaveDir,
  withModEnabled,
  type TerrariaInstallEnv,
} from './install';
import { stateFromHellos, createTerrariaWatcher } from './watcher';
import { terrariaAppearanceFrom } from './appearance';
import { launchTerraria, TML_STEAM_URL } from './launch';
import { createTerrariaGameModule, effectiveTerrariaName } from './index';
import { createTerrariaStatsReporter, flattenTerrariaStats } from './sessionStats';
import { FAIL_CLASSES, REFLEX_KINDS, ALERT_KINDS } from '../../../bot/adapter/terraria/stats.js';
import { botUsernameFor } from '../../../bot/adapter/terraria/runtime.js';
// @ts-expect-error plain ESM test helper without types
import { createFakeTerrariaMod } from '../../../../scripts/fake-terraria-mod.mjs';
import type { SetupStepInput } from '../../../shared/setupTelemetry';
import type { TerrariaHello } from '../../../shared/terrariaIpc';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const VDF = (apps: number[]) =>
  `"libraryfolders" { "0" { "path" "/games" "apps" { ${apps.map((a) => `"${a}" "1"`).join(' ')} } } }`;

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function env(opts: { apps?: number[] | null } = {}): Promise<TerrariaInstallEnv> {
  const home = await mkdtemp(path.join(tmpdir(), 'sei-trr-'));
  dirs.push(home);
  if (opts.apps !== null) {
    const steam = path.join(home, '.steam', 'steam', 'steamapps');
    await mkdir(steam, { recursive: true });
    await writeFile(path.join(steam, 'libraryfolders.vdf'), VDF(opts.apps ?? [105600, 1281930]));
  }
  return { platform: 'linux', home, xdgDataHome: path.join(home, 'xdg'), getPackRoot: async () => REPO };
}

describe('terraria install helpers', () => {
  it('finds the save folder per OS', () => {
    expect(tmlSaveDir({ platform: 'win32', home: 'C:\\Users\\you' })).toBe('C:\\Users\\you\\Documents\\My Games\\Terraria\\tModLoader');
    expect(tmlSaveDir({ platform: 'darwin', home: '/Users/you' })).toBe('/Users/you/Library/Application Support/Terraria/tModLoader');
    expect(tmlSaveDir({ platform: 'linux', home: '/home/you', xdgDataHome: null })).toBe('/home/you/.local/share/Terraria/tModLoader');
  });

  it('reads Steam libraries, versions, enabled.json and link.json', () => {
    expect([...steamAppsInLibraries(VDF([1281930]), [105600, 1281930])]).toEqual([1281930]);
    expect(steamAppsInLibraries('garbage {', [105600]).size).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(withModEnabled('["CalamityMod"]')).toEqual(['CalamityMod', 'SeiCompanion']);
    expect(withModEnabled('["SeiCompanion"]')).toEqual(['SeiCompanion']);
    expect(withModEnabled('not json')).toEqual(['SeiCompanion']);
    expect(parseLink('{"port":27460,"token":"0123456789abcdef0123"}')).toEqual({ port: 27460, token: '0123456789abcdef0123' });
    expect(parseLink('{"port":27460,"token":"short"}')).toBeNull();
  });

  it('reads the checked-in .tmod header', async () => {
    const buf = await readFile(path.join(REPO, 'assets', 'terraria-mod', 'SeiCompanion.tmod'));
    const h = readTmodHeader(buf);
    expect(h?.name).toBe('SeiCompanion');
    expect(h?.version).toMatch(/^\d+\.\d+/);
    expect(readTmodHeader(Buffer.from('nope'))).toBeNull();
  });

  it('installs the mod, enables it, writes a link and keeps the token on reinstall', async () => {
    const e = await env();
    const before = await detectTerraria(e);
    expect(before).toMatchObject({ terrariaInstalled: true, tmlInstalled: true, saveDirFound: false, modInstalled: false, linked: false });
    const saveDir = tmlSaveDir(e);
    await mkdir(paths.mods(saveDir), { recursive: true });
    await writeFile(paths.enabled(saveDir), '["CalamityMod"]');
    const r = await installTerrariaMod(e);
    expect(r.upgraded).toBe(true);
    const after = await detectTerraria(e);
    expect(after).toMatchObject({ modInstalled: true, modEnabled: true, linked: true, modVersion: r.to });
    expect(JSON.parse(await readFile(paths.enabled(saveDir), 'utf8'))).toEqual(['CalamityMod', 'SeiCompanion']);
    const again = await installTerrariaMod(e);
    expect(again.upgraded).toBe(false);
    expect(again.link.token).toBe(r.link.token);
  });

  it('says when Steam has no tModLoader, and when it cannot tell', async () => {
    expect((await detectTerraria(await env({ apps: [105600] }))).tmlInstalled).toBe(false);
    expect((await detectTerraria(await env({ apps: null }))).tmlInstalled).toBeNull();
  });
});

describe('terraria watcher', () => {
  const hello = (over: Partial<TerrariaHello> & { world?: Partial<TerrariaHello['world']> } = {}): TerrariaHello =>
    ({
      mod: 'SeiCompanion',
      version: '0.1.0',
      protocol: 1,
      game: 'terraria',
      port: 27460,
      role: 'single',
      ...over,
      world: { loaded: true, name: 'SeiSpike', uniqueId: 'u1', players: ['Ouen'], ...(over.world ?? {}) },
    }) as TerrariaHello;

  it('ranks a hosted server over its own client and reads the menu and foreign servers', () => {
    const s = stateFromHellos([hello({ role: 'client', port: 27460 }), hello({ role: 'server', port: 27461 })], 5);
    expect(s).toMatchObject({ kind: 'open', port: 27461, role: 'server', worldName: 'SeiSpike' });
    expect(stateFromHellos([hello({ world: { loaded: false } as TerrariaHello['world'] })], 5)).toEqual({ kind: 'no_world', port: 27460 });
    expect(stateFromHellos([hello({ role: 'client' })], 5)).toEqual({ kind: 'joined_other', port: 27460 });
    expect(stateFromHellos([hello({ protocol: 9 })], 5)).toEqual({ kind: 'closed' });
    expect(stateFromHellos([], 5)).toEqual({ kind: 'closed' });
  });

  it('polls a live mod, tolerates one missed poll, then reports closed', async () => {
    const mod = createFakeTerrariaMod({ obsHz: 0 });
    const port = await mod.ready;
    let up = true;
    const realFetch: typeof fetch = (i, o) => fetch(i, o);
    const w = createTerrariaWatcher({ getPort: async () => port, fetch: (i, o) => (up ? realFetch(i, o) : Promise.reject(new Error('down'))), helloTimeoutMs: 500 });
    expect((await w.checkNow()).kind).toBe('open');
    up = false;
    expect((await w.checkNow()).kind).toBe('open');
    expect((await w.checkNow()).kind).toBe('closed');
    await mod.close();
    const none = createTerrariaWatcher({ getPort: async () => null });
    expect((await none.checkNow()).kind).toBe('not_installed');
  });
});

describe('terraria appearance', () => {
  it('maps the stored farmer look to player colours', () => {
    const out = terrariaAppearanceFrom({ skin: 3, hairColor: '#AABBCC', eyeColor: 'blue', pantsColor: '#112233' } as never);
    expect(out).toEqual({ skinColor: '#f2cdb0', hairColor: '#aabbcc', pantsColor: '#112233' });
  });
});

describe('terraria launch', () => {
  it('installs then opens Steam, and never starts a second copy', async () => {
    const e = await env();
    const opened: string[] = [];
    const r = await launchTerraria({ env: e, openExternal: async (u) => void opened.push(u), fetch: () => Promise.reject(new Error('closed')) });
    expect(r).toEqual({ launched: true });
    expect(opened).toEqual([TML_STEAM_URL]);
    expect((await detectTerraria(e)).modInstalled).toBe(true);
    const r2 = await launchTerraria({ env: e, openExternal: async (u) => void opened.push(u), fetch: async () => new Response(JSON.stringify({ mod: 'SeiCompanion', version: '0.1.0', protocol: 1, game: 'terraria', port: 27460, role: 'single', world: { loaded: false } })) });
    expect(r2).toEqual({ launched: false, alreadyRunning: true });
    expect(opened).toHaveLength(1);
  });
});

describe('terraria game module', () => {
  it('names the companion like the bot does', () => {
    for (const c of [{ name: 'Sui' }, { name: '  [Lyra]  <x> ' }, { name: '', username: '' }, { name: 'A very long companion name here' }, { name: 'X', username: ' Marv ' }]) {
      expect(effectiveTerrariaName(c as never)).toBe(botUsernameFor(c));
    }
  });

  it('goes from not installed to open, and hands the bot a join target with the token', async () => {
    const e = await env();
    const events: SetupStepInput[] = [];
    const opened: string[] = [];
    // Only the fake mod's port answers, so a real tModLoader on this machine
    // (the default link port) cannot leak into the test.
    let fakePort = -1;
    const onlyFake: typeof fetch = (input, init) =>
      String(input).includes(`:${fakePort}/`) ? fetch(input, init) : Promise.reject(new Error('refused'));
    const mod = createTerrariaGameModule({
      env: e,
      fetch: onlyFake,
      openExternal: async (u) => void opened.push(u),
      track: (i) => void events.push(i),
      logger: { info: () => {}, warn: () => {} },
      packStateRoot: async () => REPO,
      appearanceFor: async () => ({ appearance: { skin: 0, hairColor: '#ffffff', eyeColor: '#000000', pantsColor: '#333333' } as never, source: 'stored' }),
    });
    expect((await mod.watcher.checkNow()).kind).toBe('not_installed');
    expect(mod.getJoinTarget({} as never)).toBeNull();
    const ins = await mod.runInstall();
    expect(ins.ok).toBe(true);
    expect(ins.ok && ins.state).toMatchObject({ modInstalled: true, modEnabled: true, linked: true, packVersion: expect.any(String) });

    const link = parseLink(await readFile(paths.link(tmlSaveDir(e)), 'utf8'))!;
    const fake = createFakeTerrariaMod({ obsHz: 0, token: link.token });
    const port = await fake.ready;
    fakePort = port;
    closers.push(() => fake.close());
    await writeFile(paths.link(tmlSaveDir(e)), JSON.stringify({ port, token: link.token }));
    expect((await mod.watcher.checkNow()).kind).toBe('open');
    expect(mod.getJoinTarget({} as never)).toEqual({ port, token: link.token, label: 'SeiSpike', uniqueId: 'd8967c12-0000-4121-bda2-207c9a551c95', owner: 'Ouen' });
    expect(await mod.prepareJoin!({ characterId: 'c1', character: {} as never })).toEqual({
      appearance: { skinColor: '#f5c8a8', hairColor: '#ffffff', eyeColor: '#000000', pantsColor: '#333333' },
    });
    const launched = await mod.runLaunch();
    expect(launched.ok).toBe(true);
    expect(opened).toEqual([]); // already running: not started twice
    expect(events.map((x) => `${x.step}:${x.outcome}`)).toEqual(expect.arrayContaining(['find_game:ok', 'mod_copy:start', 'mod_copy:ok', 'launch:ok', 'world_seen:ok']));
    for (const ev of events) expect(JSON.stringify(ev)).not.toContain(e.home);
  });

  it('refuses install and launch without tModLoader', async () => {
    const mod = createTerrariaGameModule({ env: await env({ apps: [105600] }), openExternal: async () => {}, track: () => {}, packStateRoot: async () => null });
    const r = await mod.runLaunch();
    expect(r).toMatchObject({ ok: false, reason: 'no_tml' });
    expect((await mod.runInstall()).ok).toBe(false);
  });

  it('skips the default look', async () => {
    const mod = createTerrariaGameModule({ env: await env(), openExternal: async () => {}, appearanceFor: async () => ({ appearance: {} as never, source: 'default' }) });
    expect(await mod.prepareJoin!({ characterId: 'c1', character: {} as never })).toBeNull();
  });
});

describe('terraria session stats', () => {
  it('flattens a snapshot into flat trr_* props with closed enums', () => {
    const props = flattenTerrariaStats({
      verbs: { goTo: { n: 3, ok: 2, fail: { no_path: 1 } }, craft: { n: 2, ok: 0, fail: { missing_materials: 2, made_up: 5 } } },
      reflex: { fight: 2, bogus: 9 },
      alerts: { boss_spawn: 1, nope: 3 },
    });
    expect(props).toMatchObject({ trr_verbs_n: 5, trr_verbs_ok: 2, trr_v_goto_n: 3, trr_v_goto_ok: 2, trr_fail_no_path: 1, trr_fail_missing_materials: 2, trr_reflex_fight: 2, trr_alert_boss_spawn: 1 });
    expect(props.trr_fail_made_up).toBeUndefined();
    expect(props.trr_reflex_bogus).toBeUndefined();
    expect(props.trr_alert_nope).toBeUndefined();
    for (const c of FAIL_CLASSES) expect(props[`trr_fail_${c}`]).toBeTypeOf('number');
    for (const k of REFLEX_KINDS) expect(props[`trr_reflex_${k}`]).toBeTypeOf('number');
    for (const k of ALERT_KINDS) expect(props[`trr_alert_${k}`]).toBeTypeOf('number');
    for (const k of Object.keys(props)) expect(k).toMatch(/^[a-z0-9_]+$/);
  });

  it('keeps the newest valid message per character and forgets it on take', () => {
    const rep = createTerrariaStatsReporter();
    rep.note('c1', { type: 'terraria-stats', stats: { verbs: { say: { n: 1, ok: 1, fail: {} } }, reflex: {}, alerts: {} } });
    rep.note('c1', { type: 'terraria-stats', stats: 'garbage' });
    expect(rep.take('c1').trr_v_say_n).toBe(1);
    expect(rep.take('c1')).toEqual({});
  });
});
