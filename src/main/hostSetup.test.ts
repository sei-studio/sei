/**
 * Tests for the Sei skin-setup detector (260721):
 *   - extractGameDir: `--gameDir` parsing out of ps (unquoted) and PowerShell
 *     (quoted) command lines, including paths with spaces.
 *   - classifyModJars: CustomSkinLoader jar vs foreign mod jars vs non-jars.
 *   - inspectHostMods: end-to-end against real temp directories, including
 *     the ENOENT-mods-dir → "zero mods" evidence rule.
 * The decision these feed (three-way vanilla / sei-fabric / modded) is tested
 * in hostClient.test.ts via lanHostWarning.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyModJars, extractGameDir, inspectHostMods } from './hostSetup';

describe('extractGameDir', () => {
  it('parses an unquoted ps-style gameDir followed by another flag', () => {
    expect(
      extractGameDir(
        'java -Xmx2G net.fabricmc.loader.impl.launch.knot.KnotClient --username Ouen --gameDir /Users/ouen/Library/Application Support/minecraft/sei --assetsDir /Users/ouen/assets',
      ),
    ).toBe('/Users/ouen/Library/Application Support/minecraft/sei');
  });

  it('parses a gameDir at the end of the command line', () => {
    expect(extractGameDir('java Knot --gameDir /home/x/.minecraft/sei')).toBe(
      '/home/x/.minecraft/sei',
    );
  });

  it('parses a quoted Windows gameDir', () => {
    expect(
      extractGameDir(
        'javaw.exe -cp ... KnotClient --gameDir "C:\\Users\\Some Name\\AppData\\Roaming\\.minecraft\\sei" --assetsDir "C:\\assets"',
      ),
    ).toBe('C:\\Users\\Some Name\\AppData\\Roaming\\.minecraft\\sei');
  });

  it('returns null when no gameDir argument is present', () => {
    expect(extractGameDir('java net.minecraft.client.main.Main --version 1.21.1')).toBe(null);
    expect(extractGameDir('')).toBe(null);
  });
});

describe('classifyModJars', () => {
  it('recognizes the CustomSkinLoader jar as Sei\'s skin mod, alone', () => {
    expect(classifyModJars(['CustomSkinLoader_Fabric-14.28.jar'])).toEqual({
      seiSkinMod: true,
      otherModCount: 0,
    });
  });

  it('counts foreign jars separately from the skin mod', () => {
    expect(
      classifyModJars(['CustomSkinLoader_Fabric-14.28.jar', 'sodium-0.6.0.jar', 'lithium.jar']),
    ).toEqual({ seiSkinMod: true, otherModCount: 2 });
  });

  it('ignores non-jar entries (configs, subdirs, .DS_Store)', () => {
    expect(classifyModJars(['.DS_Store', 'config', 'notes.txt'])).toEqual({
      seiSkinMod: false,
      otherModCount: 0,
    });
  });

  it('handles an empty mods dir', () => {
    expect(classifyModJars([])).toEqual({ seiSkinMod: false, otherModCount: 0 });
  });

  it('matches CSL name variants case-insensitively', () => {
    expect(classifyModJars(['customskinloader-fabric-14.20.jar'])).toEqual({
      seiSkinMod: true,
      otherModCount: 0,
    });
  });
});

describe('inspectHostMods', () => {
  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const cmdlineFor = (gameDir: string): string =>
    `java KnotClient --username x --gameDir ${gameDir} --assetsDir /tmp/assets`;

  it('scans a real mods dir resolved from the command line', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sei-hostsetup-'));
    const mods = path.join(tmp, 'mods');
    await mkdir(mods, { recursive: true });
    await writeFile(path.join(mods, 'CustomSkinLoader_Fabric-14.28.jar'), 'x');
    await writeFile(path.join(mods, 'create-fabric.jar'), 'x');
    expect(await inspectHostMods(cmdlineFor(tmp))).toEqual({
      seiSkinMod: true,
      otherModCount: 1,
    });
  });

  it('treats a missing mods dir under a real gameDir as zero mods', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sei-hostsetup-'));
    expect(await inspectHostMods(cmdlineFor(tmp))).toEqual({
      seiSkinMod: false,
      otherModCount: 0,
    });
  });

  it('returns no-evidence when the gameDir cannot be parsed', async () => {
    expect(await inspectHostMods('java net.minecraft.client.main.Main')).toEqual({
      seiSkinMod: false,
      otherModCount: null,
    });
  });
});
