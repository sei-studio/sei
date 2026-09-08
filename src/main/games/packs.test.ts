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

async function buildZip(opts: { treeHash?: string; evil?: boolean } = {}): Promise<Fixture> {
  const treeHash = opts.treeHash ?? 'a'.repeat(64);
  const zip = new JSZip();
  zip.file('pack.json', JSON.stringify({ game: 'minecraft', version: 'x', treeHash }));
  zip.file('node_modules/fake-dep/package.json', JSON.stringify({ name: 'fake-dep', main: 'index.js' }));
  zip.file('node_modules/fake-dep/index.js', 'module.exports = "pack";');
  zip.file('node_modules/fake-dep/build/Release/fake.node', Buffer.from([1, 2, 3]), {
    unixPermissions: 0o755,
  });
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

function manifestFor(fx: Fixture, version = VERSION, file = FILE) {
  return JSON.stringify({
    version,
    packs: [
      {
        game: 'minecraft',
        platform: 'darwin',
        arch: 'arm64',
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
