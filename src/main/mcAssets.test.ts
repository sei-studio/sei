/**
 * mcAssets.test.ts — the /mcassets URL contract (260721): strict parse (no
 * traversal, no percent-decoding), closest-version pick, and item-name ->
 * texture-file resolution through prismarine-viewer's items_textures.json,
 * including the containment guard. Plus the skin server endpoint end to end
 * (200 with immutable cache headers; text/plain 404 on misses so the
 * renderer's <img onError> text-label fallback fires).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// skinServer pulls in skinStore -> paths/characterStore; stub like
// skinStore.test.ts so importing it never touches electron.
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./paths', () => ({
  paths: {
    userData: () => '/tmp/nowhere',
    skinsDir: () => '/tmp/nowhere/skins',
    skinPngPath: (id: string) => `/tmp/nowhere/skins/${id}.png`,
  },
}));
vi.mock('./characterStore', () => ({
  getCharacter: vi.fn(),
  saveCharacter: vi.fn(),
  listCharacters: vi.fn(async () => []),
}));

import { parseMcAssetUrl, pickClosestVersion, resolveMcAssetFile } from './mcAssets';
import { createSkinServer, type SkinServer } from './skinServer';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let root = '';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sei-mcassets-'));
  // Two version folders, prismarine-viewer layout.
  for (const v of ['1.18.1', '1.21.4']) {
    await mkdir(path.join(root, v, 'items'), { recursive: true });
    await mkdir(path.join(root, v, 'blocks'), { recursive: true });
    await writeFile(
      path.join(root, v, 'items_textures.json'),
      JSON.stringify([
        { name: 'iron_pickaxe', model: 'iron_pickaxe', texture: 'minecraft:items/iron_pickaxe' },
        { name: 'cobblestone', model: 'cobblestone', texture: 'minecraft:block/cobblestone' },
        { name: 'shield', model: 'shield', texture: 'block/dark_oak_planks' },
        { name: 'air', model: 'air', texture: 'minecraft:missingno' },
        { name: 'evil', model: 'evil', texture: 'minecraft:block/../../secret' },
      ]),
    );
    await writeFile(path.join(root, v, 'items', 'iron_pickaxe.png'), PNG);
    await writeFile(path.join(root, v, 'blocks', 'cobblestone.png'), PNG);
  }
  // A non-version dir that must be ignored by the folder scan.
  await mkdir(path.join(root, 'not-a-version'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseMcAssetUrl', () => {
  it('accepts the canonical shape (and a query string)', () => {
    expect(parseMcAssetUrl('/mcassets/1.21.4/item/iron_pickaxe.png')).toEqual({
      version: '1.21.4',
      name: 'iron_pickaxe',
    });
    expect(parseMcAssetUrl('/mcassets/latest/item/cobblestone.png?x=1')).toEqual({
      version: 'latest',
      name: 'cobblestone',
    });
  });

  it('rejects traversal and malformed URLs', () => {
    for (const bad of [
      '/mcassets/../skins/steve.png',
      '/mcassets/1.21.4/item/../secret.png',
      '/mcassets/1.21.4/item/%2e%2e.png', // never percent-decoded
      '/mcassets/1.21.4/item/Iron_Pickaxe.png', // uppercase
      '/mcassets/1.21.4/item/iron-pickaxe.png', // dash
      '/mcassets/1.21.4/blocks/stone.png', // only /item/ is exposed
      '/mcassets/1.21.4/item/stone.jpg',
      '/mcassets/v1.21.4/item/stone.png',
      `/mcassets/1.21.4/item/${'a'.repeat(65)}.png`, // too long
      '/mcassets//item/stone.png',
      '/skins/steve.png',
    ]) {
      expect(parseMcAssetUrl(bad)).toBeNull();
    }
  });
});

describe('pickClosestVersion', () => {
  const avail = ['1.8.8', '1.18.1', '1.21.1', '1.21.4'];

  it('exact match wins', () => {
    expect(pickClosestVersion('1.21.1', avail)).toBe('1.21.1');
  });

  it('newer-than-bundled snaps down to the newest at or below', () => {
    expect(pickClosestVersion('1.21.6', avail)).toBe('1.21.4');
    expect(pickClosestVersion('1.19.2', avail)).toBe('1.18.1');
  });

  it('older-than-everything gets the oldest folder', () => {
    expect(pickClosestVersion('1.7.10', avail)).toBe('1.8.8');
  });

  it('"latest" gets the newest folder', () => {
    expect(pickClosestVersion('latest', avail)).toBe('1.21.4');
  });

  it('empty availability yields null', () => {
    expect(pickClosestVersion('1.21.4', [])).toBeNull();
  });
});

describe('resolveMcAssetFile', () => {
  it('resolves item sprites and block-item faces', async () => {
    expect(await resolveMcAssetFile(root, '1.21.4', 'iron_pickaxe')).toBe(
      path.join(root, '1.21.4', 'items', 'iron_pickaxe.png'),
    );
    expect(await resolveMcAssetFile(root, '1.21.4', 'cobblestone')).toBe(
      path.join(root, '1.21.4', 'blocks', 'cobblestone.png'),
    );
  });

  it('snaps an unbundled version to the closest folder', async () => {
    expect(await resolveMcAssetFile(root, '1.20.1', 'iron_pickaxe')).toBe(
      path.join(root, '1.18.1', 'items', 'iron_pickaxe.png'),
    );
    expect(await resolveMcAssetFile(root, 'latest', 'iron_pickaxe')).toBe(
      path.join(root, '1.21.4', 'items', 'iron_pickaxe.png'),
    );
  });

  it('returns null for unknown items and non-sprite textures', async () => {
    expect(await resolveMcAssetFile(root, '1.21.4', 'not_an_item')).toBeNull();
    expect(await resolveMcAssetFile(root, '1.21.4', 'air')).toBeNull(); // missingno
    expect(await resolveMcAssetFile(root, '1.21.4', 'evil')).toBeNull(); // traversal ref dropped
  });

  it('rejects invalid names and versions outright', async () => {
    expect(await resolveMcAssetFile(root, '1.21.4', '../../etc/passwd')).toBeNull();
    expect(await resolveMcAssetFile(root, '../1.21.4', 'iron_pickaxe')).toBeNull();
  });
});

describe('skin server /mcassets endpoint', () => {
  let server: SkinServer;

  beforeAll(async () => {
    server = await createSkinServer({ port: 0, texturesRoot: root });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves a texture with png content-type and immutable caching', async () => {
    const res = await fetch(`${server.baseUrl}/mcassets/1.21.4/item/iron_pickaxe.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('404s misses as text/plain so the renderer img falls back to labels', async () => {
    const miss = await fetch(`${server.baseUrl}/mcassets/1.21.4/item/not_an_item.png`);
    expect(miss.status).toBe(404);
    expect(miss.headers.get('content-type')).toBe('text/plain');

    const traversal = await fetch(`${server.baseUrl}/mcassets/1.21.4/item/..%2f..%2fsecret.png`);
    expect(traversal.status).toBe(404);
    expect(traversal.headers.get('content-type')).toBe('text/plain');
  });
});
