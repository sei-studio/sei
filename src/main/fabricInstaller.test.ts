/**
 * R6 (260929): Fabric setup without Java. The launcher version JSON comes
 * straight from Fabric meta and the launcher profile is written by Sei; the
 * Java installer is only a fallback for "every meta mirror unreachable".
 *
 * Fixtures under __fixtures__/fabric-meta/ are real meta responses recorded
 * 2026-09-29 (loader lists trimmed to the first 3 entries) for every version
 * Sei builds or joins at the top of the range: 1.21.1 and 26.1..26.3.
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportedVersions } from 'minecraft-protocol/src/version.js';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));
vi.mock('./paths', () => ({ paths: { userData: () => os.tmpdir() } }));

import {
  FABRIC_MIRRORS,
  FabricMetaUnreachableError,
  fabricVersionId,
  installFabricLoader,
  libraryRelativePath,
  prefetchFabricLibraries,
  selectFabricLoaderVersion,
  validateFabricProfileJson,
} from './fabricInstaller';
import type { McInstall } from '../shared/ipc';

const FIXTURES = path.join(__dirname, '__fixtures__', 'fabric-meta');
const VERSIONS = ['1.21.1', '26.1', '26.2', '26.3'] as const;
const LOADER = '0.19.5';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch that serves the recorded meta fixtures from `metaHost` and answers
 * maven with 404 (libraries are the launcher's job) unless `maven` is given.
 */
function fakeFetch(opts: {
  metaHost?: string;
  down?: string[];
  maven?: (url: string) => Response | null;
} = {}): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const metaHost = opts.metaHost ?? 'meta.fabricmc.net';
  const f = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const u = new URL(url);
    if (opts.down?.includes(u.host)) throw new TypeError('fetch failed');
    if (u.host.startsWith('maven')) return opts.maven?.(url) ?? new Response('nope', { status: 404 });
    if (u.host !== metaHost) return new Response('bad gateway', { status: 502 });
    const m = /^\/v2\/versions\/loader\/([^/]+)(?:\/([^/]+)\/profile\/json)?$/.exec(u.pathname);
    if (!m) return new Response('not found', { status: 404 });
    const mc = decodeURIComponent(m[1]);
    if (!(VERSIONS as readonly string[]).includes(mc)) return json([], 400);
    if (!m[2]) return json(fixture(`loader-list-${mc}.json`));
    if (m[2] !== LOADER) return new Response(`no loader version found for ${m[2]}`, { status: 400 });
    return json(fixture(`profile-${mc}.json`));
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

let tmp: string;
let mcDir: string;

function install(): McInstall {
  return { id: 'v1', kind: 'vanilla', label: 'Vanilla', path: mcDir } as McInstall;
}

async function readJson(p: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-fabric-'));
  mcDir = path.join(tmp, '.minecraft');
  await fs.mkdir(mcDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('fixtures cover the versions Sei supports', () => {
  it('every fixture version is joinable, and the top of the range is covered', () => {
    for (const v of VERSIONS) expect(supportedVersions).toContain(v);
    // The newest joinable versions (26.x) all have a fixture.
    const top = supportedVersions.filter((v) => /^\d{2}\./.test(v));
    for (const v of top) expect(VERSIONS as readonly string[]).toContain(v);
  });
});

describe.each(VERSIONS)('Fabric %s from meta, no Java', (mc) => {
  it('picks the stable loader from the loader list', async () => {
    expect(await selectFabricLoaderVersion(mc, undefined, fakeFetch())).toBe(LOADER);
  });

  it('writes versions/<id>/<id>.json byte-equal to meta and a selected Sei profile', async () => {
    const javaFallback = vi.fn();
    const before = Date.now();
    const res = await installFabricLoader({
      mcInstall: install(),
      mcVersion: mc,
      profileName: `Sei ${mc}`,
      gameDirName: mc,
      fetchImpl: fakeFetch(),
      javaFallback,
    });
    expect(javaFallback).not.toHaveBeenCalled();
    expect(res).toEqual({ loaderVersion: LOADER, seiGameDir: path.join(mcDir, 'sei', mc), via: 'meta' });

    const id = fabricVersionId(LOADER, mc);
    const versionJson = await readJson(path.join(mcDir, 'versions', id, `${id}.json`));
    expect(versionJson).toEqual(fixture(`profile-${mc}.json`));
    expect(versionJson.inheritsFrom).toBe(mc);

    // No launcher file existed: launcher_profiles.json is created.
    const doc = await readJson(path.join(mcDir, 'launcher_profiles.json'));
    const prof = doc.profiles[`sei-${mc}`];
    expect(prof).toMatchObject({
      name: `Sei ${mc}`,
      type: 'custom',
      lastVersionId: id,
      gameDir: path.join(mcDir, 'sei', mc),
    });
    expect(Date.parse(prof.lastUsed)).toBeGreaterThanOrEqual(before - 1000);
    await expect(fs.stat(path.join(mcDir, 'sei', mc, 'mods'))).resolves.toBeTruthy();
  });
});

describe('launcher profile files', () => {
  it('writes into both the standard and the Microsoft Store launcher files, leaving other profiles alone', async () => {
    const own = {
      profiles: {
        mine: { name: 'My modpack', type: 'custom', lastVersionId: 'fabric-loader-0.16.0-26.1', lastUsed: '2026-01-01T00:00:00.000Z' },
        'fabric-loader-26.1': { name: 'fabric-loader-26.1', type: 'custom', lastVersionId: 'fabric-loader-0.18.0-26.1' },
      },
      settings: { crashAssistance: true },
      version: 3,
    };
    await fs.writeFile(path.join(mcDir, 'launcher_profiles.json'), JSON.stringify(own));
    await fs.writeFile(
      path.join(mcDir, 'launcher_profiles_microsoft_store.json'),
      JSON.stringify({ profiles: {}, selectedProfile: 'x' }),
    );
    await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', profileName: 'Sei 26.1', gameDirName: '26.1', fetchImpl: fakeFetch() });

    const a = await readJson(path.join(mcDir, 'launcher_profiles.json'));
    expect(a.profiles.mine).toEqual(own.profiles.mine);
    // The old installer path renamed every fabric-loader-* profile on a key miss.
    expect(a.profiles['fabric-loader-26.1']).toEqual(own.profiles['fabric-loader-26.1']);
    expect(a.settings).toEqual({ crashAssistance: true });
    expect(a.profiles['sei-26.1'].name).toBe('Sei 26.1');

    const b = await readJson(path.join(mcDir, 'launcher_profiles_microsoft_store.json'));
    expect(b.profiles['sei-26.1'].lastVersionId).toBe(fabricVersionId(LOADER, '26.1'));
    expect(b.selectedProfile).toBe('sei-26.1');
  });

  it('re-running reuses the profile Sei already owns (same gameDir), even under an old key', async () => {
    const gameDir = path.join(mcDir, 'sei', '26.1');
    await fs.writeFile(
      path.join(mcDir, 'launcher_profiles.json'),
      JSON.stringify({
        profiles: {
          'fabric-loader-26.1': {
            name: 'Sei 26.1',
            type: 'custom',
            created: '2026-09-01T00:00:00.000Z',
            icon: 'data:image/png;base64,AAAA',
            lastVersionId: 'fabric-loader-0.19.3-26.1',
            gameDir,
          },
        },
      }),
    );
    await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', profileName: 'Sei 26.1', gameDirName: '26.1', fetchImpl: fakeFetch() });
    await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', profileName: 'Sei 26.1', gameDirName: '26.1', fetchImpl: fakeFetch() });
    const doc = await readJson(path.join(mcDir, 'launcher_profiles.json'));
    expect(Object.keys(doc.profiles)).toEqual(['fabric-loader-26.1']);
    expect(doc.profiles['fabric-loader-26.1']).toMatchObject({
      created: '2026-09-01T00:00:00.000Z',
      lastVersionId: fabricVersionId(LOADER, '26.1'),
    });
    // The Sei icon replaces the one the Fabric installer gave the profile.
    expect(doc.profiles['fabric-loader-26.1'].icon).toMatch(/^data:image\/png;base64,/);
    expect(doc.profiles['fabric-loader-26.1'].icon).not.toBe('data:image/png;base64,AAAA');
  });

  it('refuses to overwrite a launcher file it cannot parse, and fails when nothing could be written', async () => {
    await fs.writeFile(path.join(mcDir, 'launcher_profiles.json'), '{ not json');
    await expect(
      installFabricLoader({ mcInstall: install(), mcVersion: '26.1', fetchImpl: fakeFetch() }),
    ).rejects.toThrow(/FABRIC_INSTALL_FAILED: could not write the launcher profile/);
    expect(await fs.readFile(path.join(mcDir, 'launcher_profiles.json'), 'utf8')).toBe('{ not json');
  });

  it('removes a stale <id>.jar left by old installers', async () => {
    const id = fabricVersionId(LOADER, '26.1');
    await fs.mkdir(path.join(mcDir, 'versions', id), { recursive: true });
    await fs.writeFile(path.join(mcDir, 'versions', id, `${id}.jar`), '');
    await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', fetchImpl: fakeFetch() });
    await expect(fs.stat(path.join(mcDir, 'versions', id, `${id}.jar`))).rejects.toThrow();
  });
});

describe('mirrors and the Java fallback', () => {
  it('falls over to meta2 when meta.fabricmc.net is unreachable, without Java', async () => {
    const f = fakeFetch({ metaHost: 'meta2.fabricmc.net', down: ['meta.fabricmc.net'] });
    const javaFallback = vi.fn();
    const res = await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', fetchImpl: f, javaFallback });
    expect(res.via).toBe('meta');
    expect(javaFallback).not.toHaveBeenCalled();
    expect(f.calls.some((u) => u.startsWith('https://meta2.fabricmc.net/'))).toBe(true);
  });

  it('uses the Java installer only when every meta mirror is unreachable, then writes the profile itself', async () => {
    const f = fakeFetch({ down: FABRIC_MIRRORS.map((m) => new URL(m.meta).host) });
    const javaFallback = vi.fn(async (_args: { cause: unknown }) => LOADER);
    const res = await installFabricLoader({ mcInstall: install(), mcVersion: '26.1', profileName: 'Sei 26.1', gameDirName: '26.1', fetchImpl: f, javaFallback });
    expect(javaFallback).toHaveBeenCalledOnce();
    expect(javaFallback.mock.calls[0][0].cause).toBeInstanceOf(FabricMetaUnreachableError);
    expect(res.via).toBe('java');
    const doc = await readJson(path.join(mcDir, 'launcher_profiles.json'));
    expect(doc.profiles['sei-26.1'].lastVersionId).toBe(fabricVersionId(LOADER, '26.1'));
  });

  it('a version meta does not know is a plain failure, not a reason to try Java', async () => {
    const javaFallback = vi.fn();
    await expect(
      installFabricLoader({ mcInstall: install(), mcVersion: '9.9', fetchImpl: fakeFetch(), javaFallback }),
    ).rejects.toThrow('FABRIC_INSTALL_FAILED: no Fabric Loader available for Minecraft 9.9');
    expect(javaFallback).not.toHaveBeenCalled();
  });

  it('a cancel before any IO throws the cancelled error', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      installFabricLoader({ mcInstall: install(), mcVersion: '26.1', fetchImpl: fakeFetch(), signal: ac.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('profile JSON validation', () => {
  it('rejects a profile for the wrong version or loader', () => {
    const p = fixture('profile-26.1.json');
    expect(() => validateFabricProfileJson(p, '26.1', LOADER)).not.toThrow();
    expect(() => validateFabricProfileJson(p, '26.2', LOADER)).toThrow(/unexpected profile/);
    expect(() => validateFabricProfileJson(p, '26.1', '0.19.4')).toThrow(/unexpected profile/);
    expect(() => validateFabricProfileJson({ ...(p as object), libraries: [] }, '26.1', LOADER)).toThrow(/no libraries/);
    expect(() => validateFabricProfileJson('<html>', '26.1', LOADER)).toThrow(/not an object/);
  });
});

describe('library prefetch (best effort)', () => {
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const sha1 = createHash('sha1').update(ZIP).digest('hex');

  it('maps maven names to launcher paths', () => {
    expect(libraryRelativePath('net.fabricmc:fabric-loader:0.19.5')).toBe(
      'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar',
    );
    expect(libraryRelativePath('net.fabricmc:sponge-mixin:0.17.4+mixin.0.8.7')).toBe(
      'net/fabricmc/sponge-mixin/0.17.4+mixin.0.8.7/sponge-mixin-0.17.4+mixin.0.8.7.jar',
    );
    expect(libraryRelativePath('bad')).toBeNull();
  });

  it('writes verified jars, skips a sha1 mismatch, and never throws on a download failure', async () => {
    const f = fakeFetch({
      maven: (url) =>
        url.includes('good') || url.includes('nosha')
          ? new Response(ZIP)
          : url.includes('tampered')
            ? new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04, 9]))
            : null,
    });
    const res = await prefetchFabricLibraries(
      mcDir,
      [
        { name: 'a.b:good:1', url: 'https://maven.fabricmc.net/', sha1 },
        { name: 'a.b:nosha:1', url: 'https://maven.fabricmc.net/' },
        { name: 'a.b:tampered:1', url: 'https://maven.fabricmc.net/', sha1 },
        { name: 'a.b:missing:1', url: 'https://maven.fabricmc.net/' },
      ],
      { fetchImpl: f },
    );
    expect(res).toEqual({ ok: 2, failed: 2 });
    await expect(fs.readFile(path.join(mcDir, 'libraries', 'a', 'b', 'good', '1', 'good-1.jar'))).resolves.toEqual(ZIP);
    await expect(fs.stat(path.join(mcDir, 'libraries', 'a', 'b', 'tampered', '1', 'tampered-1.jar'))).rejects.toThrow();
    // A present, verified jar is not downloaded again.
    const again = fakeFetch();
    await prefetchFabricLibraries(mcDir, [{ name: 'a.b:good:1', url: 'https://maven.fabricmc.net/', sha1 }], { fetchImpl: again });
    expect(again.calls).toEqual([]);
  });
});
