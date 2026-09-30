/**
 * Game pack store tests (260908). A local node:http fixture serves a tiny
 * pack zip + manifest; no network. Invariants:
 *   1. Dev (unpackaged) short-circuits to the app root without touching disk
 *      or the network.
 *   2. ensurePack downloads, verifies, extracts into <store>/<game>/<version>/,
 *      preserves the exec bit on a .node file, writes installed.json, and
 *      pushes downloading -> ready.
 *   3. A second call with the pack installed makes NO request.
 *   4. A new app version whose manifest carries the SAME treeHash re-links the
 *      installed dir without downloading the zip.
 *   5. A mirror that 404s falls through to the origin.
 *   6. sha256 mismatch -> error state GAME_PACK_DOWNLOAD_FAILED, nothing installed.
 *   7. A zip entry with `..` is rejected before anything is committed.
 *   8. Older version dirs are deleted after a successful install.
 *   9. Concurrent ensurePack calls share one download (single-flight).
 *  10. An asset pack (no node_modules/, Stardew/DST shape) installs.
 *  11. A zip without its game's required payload (the 745-byte v0.6.5-beta.1
 *      DST pack) is rejected and nothing is committed.
 *  12. A payload-less INSTALL from that zip is not re-linked on the next
 *      version even though the manifest treeHash matches: it is downloaded
 *      again and ends up with the mod.
 *  13. A re-link candidate with fewer files than pack.json `files` is
 *      downloaded again too.
 *  13b. Extra files (a Finder .DS_Store) do not break the re-link: no zip
 *      request.
 *  14. getPackState reads a payload-less same-version install as missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/dev/app/root',
    getVersion: () => '0.0.0-test',
    getPath: () => '/unused',
  },
}));

import {
  ensurePack,
  getPackState,
  isSafeZipEntryName,
  onGamePackState,
  _setGamePackEnvForTest,
  type GamePackState,
} from './packs';

interface Fixture {
  zip: Buffer;
  sha256: string;
  treeHash: string;
}

/** The DST mod as the fixed builder zips it. */
const DST_FILES: Record<string, string> = {
  'node_modules/.sei-pack-keep': '',
  'assets/dst-mod/sei/modinfo.lua': 'name = "Sei"\nversion = "1.0.0"\n',
  'assets/dst-mod/sei/modmain.lua': '-- sei\n',
  'assets/dst-mod/sei/scripts/sei/net.lua': '-- net\n',
};

/**
 * The v0.6.5-beta.1 DST zip, byte for byte in shape: pack.json promising 14
 * files and the empty node_modules placeholder, no assets/.
 */
const DST_BETA1_FILES: Record<string, string> = { 'node_modules/.sei-pack-keep': '' };

async function buildZip(
  opts: {
    treeHash?: string;
    evil?: boolean;
    game?: string;
    /** Replaces the default Minecraft tree. */
    files?: Record<string, string>;
    /** pack.json `files`; defaults to the real count, null omits it. */
    packFiles?: number | null;
  } = {},
): Promise<Fixture> {
  const treeHash = opts.treeHash ?? 'a'.repeat(64);
  const game = opts.game ?? 'minecraft';
  const zip = new JSZip();
  const files = opts.files ?? {
    'node_modules/fake-dep/package.json': JSON.stringify({ name: 'fake-dep', main: 'index.js' }),
    'node_modules/fake-dep/index.js': 'module.exports = "pack";',
    'node_modules/mineflayer/package.json': JSON.stringify({ name: 'mineflayer' }),
    'node_modules/minecraft-data/package.json': JSON.stringify({ name: 'minecraft-data' }),
  };
  const count = Object.keys(files).length + (opts.files ? 0 : 1);
  const packFiles = opts.packFiles === undefined ? count : opts.packFiles;
  zip.file('pack.json', JSON.stringify({ game, version: 'x', treeHash, ...(packFiles === null ? {} : { files: packFiles }) }));
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  if (!opts.files) {
    zip.file('node_modules/fake-dep/build/Release/fake.node', Buffer.from([1, 2, 3]), {
      unixPermissions: 0o755,
    });
  }
  if (opts.evil) zip.file('../evil.txt', 'nope');
  const buf = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
  return { zip: buf, sha256: createHash('sha256').update(buf).digest('hex'), treeHash };
}

interface Served {
  server: Server;
  base: string;
  requests: string[];
  routes: Map<string, { status: number; body: Buffer | string; type: string }>;
}

async function serve(): Promise<Served> {
  const requests: string[] = [];
  const routes: Served['routes'] = new Map();
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    const r = routes.get(url);
    if (!r) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(r.status, { 'content-type': r.type, 'content-length': Buffer.byteLength(r.body) });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}`, requests, routes };
}

let store: string;
let served: Served;
const VERSION = '1.2.3';
const FILE = `sei-pack-minecraft-${VERSION}-darwin-arm64.zip`;

function manifestFor(fx: Fixture, version = VERSION, file = FILE, game = 'minecraft') {
  const any = game !== 'minecraft';
  return JSON.stringify({
    version,
    packs: [
      {
        game,
        platform: any ? 'any' : 'darwin',
        arch: any ? 'any' : 'arm64',
        file,
        sha256: fx.sha256,
        bytes: fx.zip.length,
        treeHash: fx.treeHash,
      },
    ],
  });
}

function configure(version = VERSION, extra: Record<string, unknown> = {}) {
  _setGamePackEnvForTest({
    packaged: true,
    version,
    platform: 'darwin',
    arch: 'arm64',
    storeRoot: store,
    manifestSources: (v) => [
      { url: `${served.base}/mirror/game-packs-${v}.json`, connectTimeoutMs: 2000 },
      { url: `${served.base}/origin/game-packs-${v}.json` },
    ],
    packSources: (_v, file) => [
      { url: `${served.base}/mirror/${file}`, connectTimeoutMs: 2000 },
      { url: `${served.base}/origin/${file}` },
    ],
    stallMs: 5000,
    ...extra,
  });
}

beforeEach(async () => {
  store = await mkdtemp(path.join(tmpdir(), 'sei-game-packs-'));
  served = await serve();
});

afterEach(async () => {
  _setGamePackEnvForTest(null);
  await new Promise<void>((resolve) => served.server.close(() => resolve()));
  await rm(store, { recursive: true, force: true });
});

describe('game packs: dev short-circuit', () => {
  it('Test 1: unpackaged resolves to the app root with no I/O', async () => {
    _setGamePackEnvForTest(null);
    expect(await getPackState('minecraft')).toEqual({ kind: 'ready', root: '/dev/app/root' });
    expect(await ensurePack('minecraft')).toBe('/dev/app/root');
    expect(served.requests).toEqual([]);
  });
});

describe('game packs: ensurePack', () => {
  it('Test 2: downloads, verifies, extracts, preserves modes, writes installed.json', async () => {
    const fx = await buildZip();
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    const states: GamePackState[] = [];
    const off = onGamePackState((g, s) => {
      if (g === 'minecraft') states.push(s);
    });
    expect(await getPackState('minecraft')).toEqual({ kind: 'missing' });

    const root = await ensurePack('minecraft');
    off();
    expect(root).toBe(path.join(store, 'minecraft', VERSION));
    expect((await readFile(path.join(root, 'node_modules/fake-dep/index.js'), 'utf8')).includes('pack')).toBe(true);
    const mode = (await stat(path.join(root, 'node_modules/fake-dep/build/Release/fake.node'))).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    const installed = JSON.parse(await readFile(path.join(store, 'minecraft', 'installed.json'), 'utf8'));
    expect(installed).toMatchObject({ game: 'minecraft', version: VERSION, treeHash: fx.treeHash, platform: 'darwin', arch: 'arm64' });
    expect(states[0].kind).toBe('downloading');
    expect(states.at(-1)).toEqual({ kind: 'ready', root });
    expect(await getPackState('minecraft')).toEqual({ kind: 'ready', root });
    // The tmp download dir is gone.
    await expect(stat(path.join(store, 'minecraft', 'tmp', FILE))).rejects.toBeTruthy();
    // ...and so is the tmp dir itself (260925: an empty tmp/ stayed behind).
    await expect(stat(path.join(store, 'minecraft', 'tmp'))).rejects.toBeTruthy();
  });

  it('Test 3: an installed pack makes no request on the next call', async () => {
    const fx = await buildZip();
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    await ensurePack('minecraft');
    const before = served.requests.length;
    await ensurePack('minecraft');
    expect(served.requests.length).toBe(before);
  });

  it('Test 4: a new version with the same treeHash re-links without downloading', async () => {
    const fx = await buildZip();
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    await ensurePack('minecraft');

    const NEXT = '1.2.4';
    const NEXT_FILE = `sei-pack-minecraft-${NEXT}-darwin-arm64.zip`;
    served.routes.set(`/mirror/game-packs-${NEXT}.json`, { status: 200, body: manifestFor(fx, NEXT, NEXT_FILE), type: 'application/json' });
    configure(NEXT);
    expect(await getPackState('minecraft')).toEqual({ kind: 'missing' });
    const root = await ensurePack('minecraft');
    expect(root).toBe(path.join(store, 'minecraft', NEXT));
    expect(served.requests.some((u) => u.includes(NEXT_FILE))).toBe(false);
    await expect(stat(path.join(store, 'minecraft', VERSION))).rejects.toBeTruthy();
    await stat(path.join(root, 'node_modules/fake-dep/index.js'));
    const installed = JSON.parse(await readFile(path.join(store, 'minecraft', 'installed.json'), 'utf8'));
    expect(installed.version).toBe(NEXT);
  });

  it('Test 5: a failing mirror falls through to the origin', async () => {
    const fx = await buildZip();
    served.routes.set(`/origin/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/origin/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    const root = await ensurePack('minecraft');
    await stat(path.join(root, 'pack.json'));
    expect(served.requests).toEqual([
      `/mirror/game-packs-${VERSION}.json`,
      `/origin/game-packs-${VERSION}.json`,
      `/mirror/${FILE}`,
      `/origin/${FILE}`,
    ]);
  });

  it('Test 6: a sha256 mismatch is GAME_PACK_DOWNLOAD_FAILED and installs nothing', async () => {
    const fx = await buildZip();
    const lying = { ...fx, sha256: 'b'.repeat(64) };
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(lying), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    served.routes.set(`/origin/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    await expect(ensurePack('minecraft')).rejects.toThrow(/^GAME_PACK_DOWNLOAD_FAILED:/);
    const s = await getPackState('minecraft');
    expect(s.kind).toBe('error');
    if (s.kind === 'error') expect(s.error).toBe('GAME_PACK_DOWNLOAD_FAILED');
    await expect(stat(path.join(store, 'minecraft', 'installed.json'))).rejects.toBeTruthy();
    await expect(stat(path.join(store, 'minecraft', VERSION))).rejects.toBeTruthy();
  });

  it('Test 7: a traversal entry in the zip is rejected before commit', async () => {
    const fx = await buildZip({ evil: true });
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    await expect(ensurePack('minecraft')).rejects.toThrow(/unsafe zip entry/);
    await expect(stat(path.join(store, 'minecraft', VERSION))).rejects.toBeTruthy();
    await expect(stat(path.join(store, 'evil.txt'))).rejects.toBeTruthy();
    await expect(stat(path.join(store, 'minecraft', 'evil.txt'))).rejects.toBeTruthy();
  });

  it('Test 8: older version dirs are deleted after a successful install', async () => {
    await mkdir(path.join(store, 'minecraft', '0.9.0', 'node_modules'), { recursive: true });
    await writeFile(path.join(store, 'minecraft', '0.9.0', 'pack.json'), '{}');
    const fx = await buildZip();
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    await ensurePack('minecraft');
    await expect(stat(path.join(store, 'minecraft', '0.9.0'))).rejects.toBeTruthy();
    await stat(path.join(store, 'minecraft', VERSION, 'pack.json'));
  });

  it('Test 9: concurrent calls share one download', async () => {
    const fx = await buildZip();
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx), type: 'application/json' });
    served.routes.set(`/mirror/${FILE}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    const [a, b] = await Promise.all([ensurePack('minecraft'), ensurePack('minecraft')]);
    expect(a).toBe(b);
    expect(served.requests.filter((u) => u.includes(FILE)).length).toBe(1);
  });
});

describe('game packs: payload integrity (260924, empty v0.6.5-beta.1 DST pack)', () => {
  const dstFile = (v: string) => `sei-pack-dontstarve-${v}-any-any.zip`;
  const serveDst = (fx: Fixture, v: string) => {
    served.routes.set(`/mirror/game-packs-${v}.json`, { status: 200, body: manifestFor(fx, v, dstFile(v), 'dontstarve'), type: 'application/json' });
    served.routes.set(`/mirror/${dstFile(v)}`, { status: 200, body: fx.zip, type: 'application/zip' });
  };

  it('Test 10: an asset pack with no node_modules/ installs (Stardew shape)', async () => {
    const fx = await buildZip({
      game: 'stardew',
      files: {
        'assets/stardew-mod/SeiCompanion/SeiCompanion.dll': 'MZ',
        'assets/stardew-mod/SeiCompanion/manifest.json': '{}',
        'assets/stardew-mod/SeiCompanion/Assets/portrait.png': 'png',
      },
    });
    const file = `sei-pack-stardew-${VERSION}-any-any.zip`;
    served.routes.set(`/mirror/game-packs-${VERSION}.json`, { status: 200, body: manifestFor(fx, VERSION, file, 'stardew'), type: 'application/json' });
    served.routes.set(`/mirror/${file}`, { status: 200, body: fx.zip, type: 'application/zip' });
    configure();
    const root = await ensurePack('stardew');
    await stat(path.join(root, 'assets/stardew-mod/SeiCompanion/SeiCompanion.dll'));
    await expect(stat(path.join(root, 'node_modules'))).rejects.toBeTruthy();
    expect(await getPackState('stardew')).toEqual({ kind: 'ready', root });
  });

  it('Test 11: a zip without its required payload is rejected, nothing committed', async () => {
    const fx = await buildZip({ game: 'dontstarve', files: DST_BETA1_FILES, packFiles: 14 });
    serveDst(fx, VERSION);
    configure();
    await expect(ensurePack('dontstarve')).rejects.toThrow(/GAME_PACK_DOWNLOAD_FAILED: .*incomplete: missing assets\/dst-mod\/sei\/modinfo\.lua/);
    await expect(stat(path.join(store, 'dontstarve', 'installed.json'))).rejects.toBeTruthy();
    await expect(stat(path.join(store, 'dontstarve', VERSION))).rejects.toBeTruthy();
  });

  /** Lay down what a beta.1 client has on disk after installing the empty pack. */
  async function seedBeta1Install(treeHash: string, oldVersion: string): Promise<void> {
    const root = path.join(store, 'dontstarve', oldVersion);
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', '.sei-pack-keep'), '');
    await writeFile(path.join(root, 'pack.json'), JSON.stringify({ game: 'dontstarve', version: oldVersion, treeHash, files: 14 }));
    await writeFile(
      path.join(store, 'dontstarve', 'installed.json'),
      JSON.stringify({ game: 'dontstarve', version: oldVersion, treeHash, platform: 'any', arch: 'any', installedAt: 'x' }),
    );
  }

  it('Test 12: a payload-less install is downloaded again even when the treeHash matches', async () => {
    const treeHash = 'd'.repeat(64);
    await seedBeta1Install(treeHash, '1.2.2');
    // The fixed rebuild of the SAME mod sources carries the SAME treeHash.
    const fx = await buildZip({ game: 'dontstarve', files: DST_FILES, treeHash });
    serveDst(fx, VERSION);
    configure();
    const root = await ensurePack('dontstarve');
    expect(root).toBe(path.join(store, 'dontstarve', VERSION));
    expect(served.requests).toContain(`/mirror/${dstFile(VERSION)}`);
    expect(await readFile(path.join(root, 'assets/dst-mod/sei/modinfo.lua'), 'utf8')).toContain('version = "1.0.0"');
    await expect(stat(path.join(store, 'dontstarve', '1.2.2'))).rejects.toBeTruthy();
  });

  it('Test 13: a re-link candidate missing a file listed in pack.json is downloaded again', async () => {
    const treeHash = 'e'.repeat(64);
    const fx = await buildZip({ game: 'dontstarve', files: DST_FILES, treeHash });
    serveDst(fx, VERSION);
    configure();
    await ensurePack('dontstarve');
    // Lose a non-required file from the installed tree.
    await rm(path.join(store, 'dontstarve', VERSION, 'assets/dst-mod/sei/scripts/sei/net.lua'));

    const NEXT = '1.2.4';
    serveDst(fx, NEXT);
    configure(NEXT);
    const root = await ensurePack('dontstarve');
    expect(served.requests).toContain(`/mirror/${dstFile(NEXT)}`);
    await stat(path.join(root, 'assets/dst-mod/sei/scripts/sei/net.lua'));
  });

  it('Test 13b: a stray extra file (.DS_Store) still re-links without downloading', async () => {
    const treeHash = 'e'.repeat(64);
    const fx = await buildZip({ game: 'dontstarve', files: DST_FILES, treeHash });
    serveDst(fx, VERSION);
    configure();
    await ensurePack('dontstarve');
    await writeFile(path.join(store, 'dontstarve', VERSION, 'assets/.DS_Store'), 'finder');

    const NEXT = '1.2.4';
    serveDst(fx, NEXT);
    configure(NEXT);
    served.requests.length = 0;
    const root = await ensurePack('dontstarve');
    expect(served.requests).not.toContain(`/mirror/${dstFile(NEXT)}`);
    await stat(path.join(root, 'assets/dst-mod/sei/modinfo.lua'));
  });

  it('Test 14: getPackState reads a payload-less same-version install as missing', async () => {
    await seedBeta1Install('f'.repeat(64), VERSION);
    configure();
    expect(await getPackState('dontstarve')).toEqual({ kind: 'missing' });
  });
});

describe('isSafeZipEntryName', () => {
  it('rejects traversal, absolute and drive-letter names; accepts plain ones', () => {
    expect(isSafeZipEntryName('node_modules/a/index.js')).toBe(true);
    expect(isSafeZipEntryName('pack.json')).toBe(true);
    expect(isSafeZipEntryName('../x')).toBe(false);
    expect(isSafeZipEntryName('a/../../x')).toBe(false);
    expect(isSafeZipEntryName('/etc/passwd')).toBe(false);
    expect(isSafeZipEntryName('C:\\x')).toBe(false);
    expect(isSafeZipEntryName('a\\..\\x')).toBe(false);
    expect(isSafeZipEntryName('')).toBe(false);
  });
});
