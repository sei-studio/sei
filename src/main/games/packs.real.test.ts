/**
 * Real-zip smoke (260908): runs the store against an actual pack zip built by
 * scripts/build-game-pack.mjs, served from a local node:http server. Gated on
 * SEI_PACK_ZIP so the normal suite never needs a 50MB fixture:
 *
 *   SEI_PACK_ZIP=release/packs/sei-pack-minecraft-0.5.5-darwin-arm64.zip npx vitest run src/main/games/packs.real.test.ts
 *
 * Any game's pack works (the game comes from the zip's .meta.json); the
 * native exec-bit and Minecraft path checks run for the Minecraft pack only,
 * the GAME_PACKS requiredPaths check for every pack.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/dev', getVersion: () => '0.0.0', getPath: () => '/unused' },
}));

import { ensurePack, _setGamePackEnvForTest } from './packs';
import { GAME_PACKS, isGameId } from '../../shared/gamePacks';

const ZIP = process.env.SEI_PACK_ZIP;

describe.skipIf(!ZIP)('game packs: real zip', () => {
  it('downloads, extracts, carries its payload and preserves the .node exec bits', async () => {
    const zip = await readFile(path.resolve(ZIP!));
    const meta = JSON.parse(await readFile(`${path.resolve(ZIP!)}.meta.json`, 'utf8'));
    const game = meta.game;
    if (!isGameId(game)) throw new Error(`meta.game ${game} is not a game id`);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(meta.sha256);
    const store = await mkdtemp(path.join(tmpdir(), 'sei-real-pack-'));
    const manifest = JSON.stringify({ version: meta.version, packs: [meta] });
    const server = createServer((req, res) => {
      if (req.url?.endsWith('.json')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(manifest); return; }
      if (req.url?.endsWith('.zip')) { res.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length }); res.end(zip); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    _setGamePackEnvForTest({
      packaged: true, version: meta.version, platform: meta.platform, arch: meta.arch, storeRoot: store,
      manifestSources: (v) => [{ url: `http://127.0.0.1:${port}/game-packs-${v}.json` }],
      packSources: (_v, f) => [{ url: `http://127.0.0.1:${port}/${f}` }],
    });
    const t0 = Date.now();
    let ticks = 0;
    const root = await ensurePack(game, { onProgress: () => { ticks++; } });
    const ms = Date.now() - t0;
    console.log(`real pack: installed to ${root} in ${ms}ms, ${ticks} progress ticks`);
    for (const rel of GAME_PACKS[game].requiredPaths) expect((await stat(path.join(root, rel))).isFile()).toBe(true);
    const pj = JSON.parse(await readFile(path.join(root, 'pack.json'), 'utf8'));
    expect(pj.treeHash).toBe(meta.treeHash);
    if (game === 'minecraft') {
      expect(ticks).toBeGreaterThan(5);
      const webgl = await stat(path.join(root, 'node_modules/gl/build/Release/webgl.node'));
      expect(webgl.mode & 0o111).not.toBe(0);
      const canvas = await stat(path.join(root, 'node_modules/canvas/build/Release/canvas.node'));
      expect(canvas.mode & 0o111).not.toBe(0);
      await stat(path.join(root, 'node_modules/mineflayer/index.js'));
      await stat(path.join(root, 'node_modules/minecraft-data/minecraft-data/data/bedrock/common/versions.json'));
      await stat(path.join(root, 'node_modules/prismarine-viewer/public/textures/1.16.4/entity'));
    }
    server.close();
    _setGamePackEnvForTest(null);
    await rm(store, { recursive: true, force: true });
  }, 120_000);
});
