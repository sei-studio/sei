/** Stardew GameModule (M1): naming, join target, watcher wiring. */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStardewGameModule, effectiveStardewName } from './index';
import type { StardewInstallEnv } from './install';

describe('stardew game module', () => {
  it('names the companion like the bot runtime does and collides case-insensitively', () => {
    expect(effectiveStardewName({ name: 'Sui', username: null })).toBe('Sui');
    expect(effectiveStardewName({ name: 'Marv!!', username: '' })).toBe('Marv');
    expect(effectiveStardewName({ name: '', username: '' })).toBe('Sei');
    const mod = createStardewGameModule();
    expect(mod.id).toBe('stardew');
    expect(mod.displayName).toBe('Stardew Valley');
    expect(mod.collides('sui', 'SUI')).toBe(true);
    expect(mod.getWorldState()).toEqual({ game: 'stardew', kind: 'closed' });
    expect(mod.getJoinTarget({ userConfig: {} as never, skinServerBaseUrl: null })).toBeNull();
    expect(mod.joinTargetMissingError.error).toBe('GAME_WORLD_NOT_OPEN');
    expect(mod.install).toBeDefined();
  });

  it('builds the join target from the open farm + the mod config token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sei-stardew-mod-'));
    const game = path.join(root, 'game');
    await mkdir(path.join(game, 'Mods', 'SeiCompanion'), { recursive: true });
    await writeFile(path.join(game, 'Stardew Valley.dll'), 'x');
    await writeFile(path.join(game, 'StardewModdingAPI.dll'), 'x');
    await writeFile(path.join(game, 'Mods', 'SeiCompanion', 'SeiCompanion.dll'), 'x');
    await writeFile(path.join(game, 'Mods', 'SeiCompanion', 'manifest.json'), '{"Version":"0.1.0"}');
    const server = createServer((_req, res) => {
      const json = JSON.stringify({ mod: 'SeiCompanion', version: '0.1.0', protocol: 1, save: { loaded: true, farmName: 'Sunny', uniqueId: '42', day: 3, season: 'spring', year: 1 } });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
      res.end(json);
    });
    // No host: every loopback family, so the watcher's `localhost` probe reaches it on any stack.
    const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as { port: number }).port)));
    await writeFile(path.join(game, 'Mods', 'SeiCompanion', 'config.json'), JSON.stringify({ Port: port, Token: 'tok-1234567890abcdef' }));
    await mkdir(path.join(root, 'home'));
    await writeFile(path.join(root, 'home', 'stardewvalley.targets'), `<Project><PropertyGroup><GamePath>${game}</GamePath></PropertyGroup></Project>`);
    const env: StardewInstallEnv = {
      platform: 'linux', home: path.join(root, 'home'), readRegistry: async () => null, getPackRoot: async () => root,
      tmpDir: () => root, fetch: (i, o) => fetch(i, o), smapiSources: () => [], runInstaller: async () => ({ stdout: '', stderr: '' }), now: () => Date.now(),
    };
    const mod = createStardewGameModule({ env, intervalMs: 60_000, logger: { info: () => {}, warn: () => {} } });
    const updates: string[] = [];
    mod.watcher.start({ onUpdate: (s) => updates.push(s.kind) });
    const state = await mod.watcher.checkNow();
    expect(state).toMatchObject({ game: 'stardew', kind: 'open', farmName: 'Sunny', port });
    expect(mod.getJoinTarget({ userConfig: {} as never, skinServerBaseUrl: null })).toEqual({ port, token: 'tok-1234567890abcdef', label: 'Sunny Farm', uniqueId: '42' });
    mod.watcher.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  it('prepareJoin attaches a derived appearance, and nothing at all for the default look or a failure', async () => {
    const look = { gender: 'female' as const, skin: 3, hair: 26, hairColor: '#c0c8ff', eyeColor: '#6a4cff', shirt: 1016, pants: 2, pantsColor: '#1b1b3a', accessory: -1 };
    const args = { characterId: 'c1', character: { name: 'Lyra' } as never };
    const quiet = { info: () => {}, warn: () => {} };
    const derived = createStardewGameModule({ logger: quiet, appearanceFor: async (id) => { expect(id).toBe('c1'); return { appearance: look, source: 'auto' }; } });
    expect(await derived.prepareJoin?.(args)).toEqual({ appearance: look });
    // No field for the default: the mod's own neutral look is the one default.
    const fallback = createStardewGameModule({ logger: quiet, appearanceFor: async () => ({ appearance: look, source: 'default' }) });
    expect(await fallback.prepareJoin?.(args)).toBeNull();
    const broken = createStardewGameModule({ logger: quiet, appearanceFor: async () => { throw new Error('boom'); } });
    expect(await broken.prepareJoin?.(args)).toBeNull();
  });
});
