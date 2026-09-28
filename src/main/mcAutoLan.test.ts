/**
 * Tests for the Sei Auto LAN mod installer (260929), against real temp dirs
 * and a fake assets dir (fake jar bytes + a manifest with their sha256):
 *   - pickAutoLanJar: [minMc, maxMcExclusive) ranges, snapshots never match.
 *   - installAutoLanMod: fresh install, already current, replace an older
 *     build, remove on an unsupported version or when turned off, refuse a
 *     shipped jar whose bytes do not match the manifest, leave other mods alone.
 *   - findSeiProfiles / syncAutoLanForSeiProfiles: only launcher profiles
 *     whose gameDir is under <.minecraft>/sei are touched.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOLAN_JAR_RE,
  findSeiProfiles,
  installAutoLanMod,
  pickAutoLanJar,
  syncAutoLanForSeiProfiles,
  type AutoLanManifest,
} from './mcAutoLan';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const JAR_A = 'sei-autolan-1.0.0+mc1.14.4-1.15.2.jar';
const JAR_B = 'sei-autolan-1.0.0+mc1.20.5-1.21.11.jar';
const JAR_C = 'sei-autolan-1.0.0+mc26.1-26.1.2.jar';
const BYTES: Record<string, string> = {
  [JAR_A]: 'jar-a-bytes',
  [JAR_B]: 'jar-b-bytes',
  [JAR_C]: 'jar-c-bytes',
};

function manifest(): AutoLanManifest {
  return {
    modId: 'sei-autolan',
    modVersion: '1.0.0',
    jars: [
      { file: JAR_A, minMc: '1.14.4', maxMcExclusive: '1.16', sha256: sha(BYTES[JAR_A]) },
      { file: JAR_B, minMc: '1.20.5', maxMcExclusive: '26.1', sha256: sha(BYTES[JAR_B]) },
      { file: JAR_C, minMc: '26.1', maxMcExclusive: '26.2', sha256: sha(BYTES[JAR_C]) },
    ],
  };
}

let tmp: string;
let assetsDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'sei-autolan-test-'));
  assetsDir = path.join(tmp, 'assets');
  await mkdir(assetsDir, { recursive: true });
  for (const [file, body] of Object.entries(BYTES)) {
    await writeFile(path.join(assetsDir, file), body);
  }
  await writeFile(path.join(assetsDir, 'manifest.json'), JSON.stringify(manifest()));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('pickAutoLanJar', () => {
  const m = manifest();
  it('picks the jar whose range holds the version, bounds inclusive-exclusive', () => {
    expect(pickAutoLanJar(m, '1.14.4')?.file).toBe(JAR_A);
    expect(pickAutoLanJar(m, '1.15.2')?.file).toBe(JAR_A);
    expect(pickAutoLanJar(m, '1.20.5')?.file).toBe(JAR_B);
    expect(pickAutoLanJar(m, '1.21.11')?.file).toBe(JAR_B);
    expect(pickAutoLanJar(m, '26.1')?.file).toBe(JAR_C);
    expect(pickAutoLanJar(m, '26.1.2')?.file).toBe(JAR_C);
  });

  it('returns null outside every range', () => {
    expect(pickAutoLanJar(m, '1.16')).toBeNull();
    expect(pickAutoLanJar(m, '1.12.2')).toBeNull();
    expect(pickAutoLanJar(m, '26.2')).toBeNull();
  });

  it('never matches a snapshot or pre-release id', () => {
    expect(pickAutoLanJar(m, '24w14a')).toBeNull();
    expect(pickAutoLanJar(m, '1.21-pre1')).toBeNull();
    expect(pickAutoLanJar(m, '')).toBeNull();
  });
});

describe('AUTOLAN_JAR_RE', () => {
  it('matches every build name and nothing else', () => {
    expect(AUTOLAN_JAR_RE.test(JAR_B)).toBe(true);
    expect(AUTOLAN_JAR_RE.test('sei-autolan-0.9.0.jar')).toBe(true);
    expect(AUTOLAN_JAR_RE.test('CustomSkinLoader_Fabric-14.28.jar')).toBe(false);
    expect(AUTOLAN_JAR_RE.test('sei-autolan-1.0.0.jar.disabled')).toBe(false);
    expect(AUTOLAN_JAR_RE.test('.sei-autolan-1.0.0+mc1.21.jar.123.tmp')).toBe(false);
  });
});

describe('installAutoLanMod', () => {
  it('installs the matching jar into a fresh mods dir, next to other mods', async () => {
    const modsDir = path.join(tmp, 'sei', '1.21.1', 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(path.join(modsDir, 'CustomSkinLoader_Fabric-14.28.jar'), 'csl');

    const r = await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    expect(r).toEqual({ status: 'installed', file: JAR_B });
    expect((await readdir(modsDir)).sort()).toEqual(
      ['CustomSkinLoader_Fabric-14.28.jar', JAR_B].sort(),
    );
    expect(await readFile(path.join(modsDir, JAR_B), 'utf8')).toBe(BYTES[JAR_B]);
  });

  it('creates the mods dir when it does not exist yet', async () => {
    const modsDir = path.join(tmp, 'sei', '26.1', 'mods');
    const r = await installAutoLanMod({ modsDir, mcVersion: '26.1', assetsDir });
    expect(r.status).toBe('installed');
    expect(await readdir(modsDir)).toEqual([JAR_C]);
  });

  it('reports current and leaves the file alone when it already matches', async () => {
    const modsDir = path.join(tmp, 'mods');
    await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    const r = await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    expect(r).toEqual({ status: 'current', file: JAR_B });
  });

  it('replaces an older build and a same-named jar with different bytes', async () => {
    const modsDir = path.join(tmp, 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(path.join(modsDir, 'sei-autolan-0.9.0+mc1.21.1.jar'), 'old');
    await writeFile(path.join(modsDir, JAR_B), 'corrupt');

    const r = await installAutoLanMod({ modsDir, mcVersion: '1.21.4', assetsDir });
    expect(r).toEqual({ status: 'installed', file: JAR_B });
    expect(await readdir(modsDir)).toEqual([JAR_B]);
    expect(await readFile(path.join(modsDir, JAR_B), 'utf8')).toBe(BYTES[JAR_B]);
  });

  it('dedupes extra copies even when the right one is already current', async () => {
    const modsDir = path.join(tmp, 'mods');
    await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    await writeFile(path.join(modsDir, 'sei-autolan-0.9.0.jar'), 'old');
    const r = await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    expect(r.status).toBe('current');
    expect(await readdir(modsDir)).toEqual([JAR_B]);
  });

  it('removes a copy when no build covers the profile version', async () => {
    const modsDir = path.join(tmp, 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(path.join(modsDir, JAR_B), BYTES[JAR_B]);
    await writeFile(path.join(modsDir, 'sodium.jar'), 'x');

    const r = await installAutoLanMod({ modsDir, mcVersion: '26.2', assetsDir });
    expect(r).toEqual({ status: 'removed' });
    expect(await readdir(modsDir)).toEqual(['sodium.jar']);
  });

  it('is absent when unsupported and nothing is there', async () => {
    const modsDir = path.join(tmp, 'mods');
    const r = await installAutoLanMod({ modsDir, mcVersion: '1.17.1', assetsDir });
    expect(r).toEqual({ status: 'absent' });
  });

  it('removes every copy when turned off', async () => {
    const modsDir = path.join(tmp, 'mods');
    await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    const r = await installAutoLanMod({
      modsDir,
      mcVersion: '1.21.1',
      assetsDir,
      enabled: false,
    });
    expect(r).toEqual({ status: 'removed' });
    expect(await readdir(modsDir)).toEqual([]);
  });

  it('refuses a shipped jar whose bytes do not match the manifest', async () => {
    await writeFile(path.join(assetsDir, JAR_B), 'tampered');
    const modsDir = path.join(tmp, 'mods');
    await mkdir(modsDir, { recursive: true });
    const r = await installAutoLanMod({ modsDir, mcVersion: '1.21.1', assetsDir });
    expect(r).toEqual({ status: 'failed' });
    expect(await readdir(modsDir)).toEqual([]);
  });

  it('fails soft when the assets are missing', async () => {
    const r = await installAutoLanMod({
      modsDir: path.join(tmp, 'mods'),
      mcVersion: '1.21.1',
      assetsDir: path.join(tmp, 'nope'),
    });
    expect(r).toEqual({ status: 'failed' });
  });
});

async function writeLauncherProfiles(mcDir: string, profiles: Record<string, unknown>) {
  await mkdir(mcDir, { recursive: true });
  await writeFile(path.join(mcDir, 'launcher_profiles.json'), JSON.stringify({ profiles }));
}

describe('findSeiProfiles', () => {
  it('returns only Fabric profiles whose gameDir is under <mc>/sei', async () => {
    const mcDir = path.join(tmp, '.minecraft');
    await writeLauncherProfiles(mcDir, {
      a: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: path.join(mcDir, 'sei', '1.21.1') },
      legacy: { lastVersionId: 'fabric-loader-0.15.0-1.20.4', gameDir: path.join(mcDir, 'sei') },
      mine: { lastVersionId: 'fabric-loader-0.16.10-1.21.4', gameDir: path.join(mcDir, 'mods-pack') },
      sibling: { lastVersionId: 'fabric-loader-0.16.10-1.21.4', gameDir: path.join(mcDir, 'sei-other') },
      vanilla: { lastVersionId: '1.21.1' },
      release: { lastVersionId: 'latest-release', gameDir: path.join(mcDir, 'sei', 'x') },
      dup: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: path.join(mcDir, 'sei', '1.21.1') },
    });
    const found = await findSeiProfiles(mcDir);
    expect(found).toEqual([
      { gameDir: path.join(mcDir, 'sei', '1.21.1'), mcVersion: '1.21.1' },
      { gameDir: path.join(mcDir, 'sei'), mcVersion: '1.20.4' },
    ]);
  });

  it('returns [] when the launcher file is missing or malformed', async () => {
    expect(await findSeiProfiles(path.join(tmp, 'none'))).toEqual([]);
    const mcDir = path.join(tmp, 'bad');
    await mkdir(mcDir, { recursive: true });
    await writeFile(path.join(mcDir, 'launcher_profiles.json'), '{not json');
    expect(await findSeiProfiles(mcDir)).toEqual([]);
  });
});

describe('syncAutoLanForSeiProfiles', () => {
  it('installs into every Sei profile and nowhere else', async () => {
    const mcDir = path.join(tmp, '.minecraft');
    const ownDir = path.join(mcDir, 'my-profile');
    await writeLauncherProfiles(mcDir, {
      a: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: path.join(mcDir, 'sei', '1.21.1') },
      b: { lastVersionId: 'fabric-loader-0.16.10-26.1', gameDir: path.join(mcDir, 'sei', '26.1') },
      c: { lastVersionId: 'fabric-loader-0.16.10-1.17.1', gameDir: path.join(mcDir, 'sei', '1.17.1') },
      own: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: ownDir },
    });

    const results = await syncAutoLanForSeiProfiles({ mcDirs: [mcDir], assetsDir });
    expect(results.map((r) => [r.mcVersion, r.status])).toEqual([
      ['1.21.1', 'installed'],
      ['26.1', 'installed'],
      ['1.17.1', 'absent'],
    ]);
    expect(await readdir(path.join(mcDir, 'sei', '1.21.1', 'mods'))).toEqual([JAR_B]);
    expect(await readdir(path.join(mcDir, 'sei', '26.1', 'mods'))).toEqual([JAR_C]);
    await expect(readdir(path.join(ownDir, 'mods'))).rejects.toThrow();

    const again = await syncAutoLanForSeiProfiles({ mcDirs: [mcDir], assetsDir });
    expect(again.map((r) => r.status)).toEqual(['current', 'current', 'absent']);
  });

  it('removes the jar from every Sei profile when turned off', async () => {
    const mcDir = path.join(tmp, '.minecraft');
    await writeLauncherProfiles(mcDir, {
      a: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: path.join(mcDir, 'sei', '1.21.1') },
    });
    await syncAutoLanForSeiProfiles({ mcDirs: [mcDir], assetsDir });
    const off = await syncAutoLanForSeiProfiles({ mcDirs: [mcDir], assetsDir, enabled: false });
    expect(off.map((r) => r.status)).toEqual(['removed']);
    expect(await readdir(path.join(mcDir, 'sei', '1.21.1', 'mods'))).toEqual([]);
  });

  it('does nothing when the shipped manifest is missing', async () => {
    const mcDir = path.join(tmp, '.minecraft');
    await writeLauncherProfiles(mcDir, {
      a: { lastVersionId: 'fabric-loader-0.16.10-1.21.1', gameDir: path.join(mcDir, 'sei', '1.21.1') },
    });
    const r = await syncAutoLanForSeiProfiles({ mcDirs: [mcDir], assetsDir: path.join(tmp, 'nope') });
    expect(r).toEqual([]);
  });
});
