/** Game-adapters M2 (260908): the DST GameModule over a fake watcher + deps. */
import { describe, it, expect, vi } from 'vitest';
import { createDontStarveGameModule, effectiveDstUsername } from './index';
import { createDstWatcher } from './watcher';
import type { UserConfig } from '../../../shared/characterSchema';
import type { DstJoinTarget } from '../../../shared/dstIpc';

function build(cfg: Partial<UserConfig> = {}, installState: unknown = { kind: 'found', installPath: '/i', modsDir: '/i/mods', modInstalled: true, modVersion: '0.1.0', enabled: true }) {
  let t = 1000;
  const watcher = createDstWatcher({ now: () => t, log: () => {}, port: 0 });
  const detect = vi.fn(async () => installState as never);
  const enable = vi.fn(async () => {});
  const install = vi.fn(async (_opts: unknown) => ({ kind: 'found', installPath: '/i', modsDir: '/i/mods', modInstalled: true, modVersion: '0.1.0', enabled: true }) as never);
  const launch = vi.fn(async () => {});
  const mod = createDontStarveGameModule({
    watcher,
    detect,
    enable,
    install,
    launch,
    loadConfig: async () => cfg as UserConfig,
    getCharacter: async (id) => (id === 'c1' ? { name: '  Marv  the\nBold ' } : null),
    getPackRoot: async () => '/pack',
    log: () => {},
  });
  return { mod, watcher, detect, enable, install, launch, tick: (ms: number) => { t += ms; } };
}

describe('dontstarve GameModule', () => {
  it('names the body like the bot does and collides case-insensitively', () => {
    expect(effectiveDstUsername({ name: '  Marv  the\nBold ' })).toBe('Marv the Bold');
    const { mod } = build();
    expect(mod.id).toBe('dontstarve');
    expect(mod.displayName).toBe("Don't Starve Together");
    expect(mod.collides('Sui', 'sui')).toBe(true);
    expect(mod.joinTargetMissingError.error).toBe('GAME_WORLD_NOT_OPEN');
  });

  it('builds the join target from the heartbeat with every stored survivor pick, else null', async () => {
    const cfg = { dst_survivor: { c1: { prefab: 'wigfrid', source: 'user' }, c2: { prefab: 'woodie', source: 'auto' } } } as unknown as UserConfig;
    const { mod, watcher } = build(cfg);
    expect(mod.getJoinTarget({ userConfig: cfg, skinServerBaseUrl: null })).toBeNull();
    watcher.handleHello({ session: 'SESS', world: 'Sunny', day: 9, season: 'spring', phase: 'day', caves: true, players: [{ userid: 'KU_1', name: 'Steve' }] });
    const jt = mod.getJoinTarget({ userConfig: cfg, skinServerBaseUrl: null }) as DstJoinTarget | null;
    expect(jt).toMatchObject({ session: 'SESS', label: 'Sunny', day: 9, season: 'spring', caves: true, nearUserid: 'KU_1', nearName: 'Steve', defaultPrefab: 'wilson' });
    // Ineligible stored prefabs are dropped; the eligible one carries its brief.
    expect(Object.keys(jt!.survivors)).toEqual(['c1']);
    expect(jt!.survivors.c1.brief).toMatch(/You are playing as Wigfrid/);
    expect(jt!.defaultBrief).toMatch(/You are playing as Wilson/);
    expect(mod.getWorldState()).toMatchObject({ kind: 'open', worldName: 'Sunny' });
  });

  it('turns a dst-listen report into a summon offer on the next heartbeat, using the stored pick', async () => {
    const cfg = { dst_survivor: { c1: { prefab: 'wortox', source: 'auto', reason: 'souls' } } } as unknown as UserConfig;
    const { mod, watcher } = build(cfg);
    watcher.handleHello({ session: 'SESS', players: [{ userid: 'KU_1', name: 'Steve' }] });
    await mod.setSummonOffer('c1', { port: 5000, token: 'tok-12345678' });
    const r = watcher.handleHello({ session: 'SESS', players: [{ userid: 'KU_1', name: 'Steve' }] });
    expect(r.summon).toEqual({ token: 'tok-12345678', botPort: 5000, name: 'Marv the Bold', prefab: 'wortox', nearUserid: 'KU_1', announce: true });
    // Unknown character / no pick: Wilson under the fallback name.
    await mod.setSummonOffer('zz', { port: 5001, token: 'tok-abcdefgh' });
    expect(watcher.handleHello({ session: 'SESS' }).summon).toMatchObject({ name: 'Sei', prefab: 'wilson', botPort: 5001 });
    await mod.setSummonOffer('zz', { port: 5002, token: 'tok-abcdefgh' });
    await mod.setSummonOffer('zz', null);
    expect(watcher.handleHello({ session: 'SESS' }).summon).toBeUndefined();
  });

  it('reports not_installed when detection finds nothing and no heartbeat is live; install goes through the pack', async () => {
    const { mod, install, detect } = build({}, { kind: 'not_found', searched: ['/a', '/b'] });
    const onUpdate = vi.fn();
    mod.watcher.start({ onUpdate });
    await new Promise((r) => setTimeout(r, 20));
    expect(detect).toHaveBeenCalled();
    expect(mod.getWorldState()).toEqual({ game: 'dontstarve', kind: 'not_installed' });
    const progress = vi.fn();
    const s = await mod.runInstall(progress);
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ packRoot: '/pack' }));
    expect(s.kind).toBe('found');
    expect(progress.mock.calls[0][0]).toEqual({ kind: 'installing', step: 'copying' });
    expect(mod.getWorldState().kind).toBe('closed');
    mod.watcher.stop();
  });

  it('re-applies modsettings.lua when detection finds the mod disabled', async () => {
    const { mod, enable } = build({}, { kind: 'found', installPath: '/i', modsDir: '/i/mods', modInstalled: true, modVersion: '0.1.0', enabled: false });
    const s = await mod.getInstallState();
    expect(enable).toHaveBeenCalledWith('/i/mods');
    expect(s).toMatchObject({ kind: 'found', enabled: true });
  });

  it('macOS (260925): a launch never passes a grant; a refused needed write flags grantNeeded until a clicked install lands', async () => {
    const { mod, install, launch, detect } = build();
    const refused = { kind: 'error', error: 'GAME_INSTALL_FAILED', message: 'EPERM', permission: true };
    install.mockResolvedValueOnce(refused as never);
    await mod.install!.launch();
    expect(install.mock.calls[0][0]).toMatchObject({ packRoot: '/pack', grant: undefined });
    // The game still launches, with whatever helper is there.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalled();
    expect(mod.lastInstall).toMatchObject({ kind: 'found', grantNeeded: true });
    expect(await mod.getInstallState()).toMatchObject({ grantNeeded: true });

    // The click carries the grant through to installMod and clears the flag.
    const grant = { pickFolder: vi.fn() } as never;
    const s = await mod.runInstall(undefined, { grant });
    expect(install.mock.calls[1][0]).toMatchObject({ grant });
    expect(s).not.toHaveProperty('grantNeeded');
    expect(await mod.getInstallState()).not.toHaveProperty('grantNeeded');
  });

  it('a clicked install that macOS still refuses returns the error as is (no flag, the step shows it)', async () => {
    const { mod, install } = build();
    const refused = { kind: 'error', error: 'GAME_INSTALL_FAILED', message: 'EPERM', permission: true };
    install.mockResolvedValueOnce(refused as never);
    const s = await mod.runInstall(undefined, { grant: {} as never });
    expect(s).toEqual(refused);
    expect(await mod.getInstallState()).not.toHaveProperty('grantNeeded');
  });
});
