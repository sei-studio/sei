/**
 * launcher_profiles*.json handling (260929 review): profiles misfiled by the
 * pre-260929 setup bug, BOM tolerance, and the Windows rename retry.
 *
 * The old setup renamed EVERY fabric-loader-* profile to "Sei" and pointed it
 * at the Sei game dir of the version it had just set up. So a machine that
 * set up 1.21.1 and later 26.1 has Sei's 1.21.1 profile (and any Fabric
 * profile of the player's) pointed at <.minecraft>/sei/26.1, whose mods
 * folder holds the 26.1 skin mod. Fabric refuses to start that profile.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inOtherVersionSeiDir,
  listFabricProfiles,
  readProfilesFile,
  upsertSeiProfile,
  writeProfilesFile,
  type LauncherProfilesDoc,
} from './launcherProfiles';

const MC = path.resolve('/home/p/.minecraft');
const sei = (v: string) => path.join(MC, 'sei', v);

function misfiledDoc(): LauncherProfilesDoc {
  return {
    profiles: {
      // The player's own Fabric profile, clobbered by the old bug.
      'fabric-loader-1.20.1': { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.16.0-1.20.1', gameDir: sei('26.1') },
      // Sei's 1.21.1 profile, repointed at the 26.1 dir by the later setup.
      'fabric-loader-1.21.1': { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-1.21.1', gameDir: sei('26.1') },
      // Sei's real 26.1 profile.
      'fabric-loader-26.1': { name: 'Sei 26.1', lastVersionId: 'fabric-loader-0.19.5-26.1', gameDir: sei('26.1') },
      // The legacy single Sei dir is not a per-version dir.
      legacy: { name: 'Sei', lastVersionId: 'fabric-loader-0.15.0-1.21.4', gameDir: path.join(MC, 'sei') },
    },
  };
}

describe('inOtherVersionSeiDir', () => {
  it('flags only a per-version Sei dir for another version', () => {
    expect(inOtherVersionSeiDir(MC, sei('26.1'), '1.21.1')).toBe(true);
    expect(inOtherVersionSeiDir(MC, sei('26.1'), '26.1')).toBe(false);
    expect(inOtherVersionSeiDir(MC, path.join(MC, 'sei'), '1.21.4')).toBe(false);
    expect(inOtherVersionSeiDir(MC, MC, '1.21.1')).toBe(false);
    expect(inOtherVersionSeiDir(MC, path.join(MC, 'sei', 'custom'), '1.21.1')).toBe(false);
    expect(inOtherVersionSeiDir(MC, path.resolve('/elsewhere/26.1'), '1.21.1')).toBe(false);
  });
});

describe('listFabricProfiles', () => {
  it('leaves out profiles misfiled into another version\'s Sei dir', () => {
    const keys = listFabricProfiles(misfiledDoc(), MC).map((p) => p.key);
    expect(keys).toEqual(['fabric-loader-26.1', 'legacy']);
  });
});

describe('upsertSeiProfile', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');

  it('reuses the Sei profile for this version, never a misfiled one sharing the dir', () => {
    const doc = misfiledDoc();
    const { key } = upsertSeiProfile(doc, {
      mcDir: MC, mcVersion: '26.1', versionId: 'fabric-loader-0.19.6-26.1', profileName: 'Sei 26.1', gameDir: sei('26.1'), now,
    });
    expect(key).toBe('fabric-loader-26.1');
    // The player's profile keeps its own version.
    expect(doc.profiles!['fabric-loader-1.20.1'].lastVersionId).toBe('fabric-loader-0.16.0-1.20.1');
  });

  it('makes sei-<version> when only a misfiled profile points at the dir', () => {
    const doc = misfiledDoc();
    delete doc.profiles!['fabric-loader-26.1'];
    const { key } = upsertSeiProfile(doc, {
      mcDir: MC, mcVersion: '26.1', versionId: 'fabric-loader-0.19.6-26.1', profileName: 'Sei 26.1', gameDir: sei('26.1'), now,
    });
    expect(key).toBe('sei-26.1');
    expect(doc.profiles!['fabric-loader-1.21.1'].lastVersionId).toBe('fabric-loader-0.19.5-1.21.1');
  });
});

describe('profile file IO', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sei-lp-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a file that starts with a UTF-8 BOM', async () => {
    const file = path.join(dir, 'launcher_profiles.json');
    await fs.writeFile(file, '﻿{"profiles":{},"version":3}');
    expect(await readProfilesFile(file)).toEqual({ profiles: {}, version: 3 });
  });

  it('retries a transient Windows rename failure, and gives up on anything else', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    };
    await writeProfilesFile('x', { profiles: {} }, { platform: 'win32', write: flaky });
    expect(calls).toBe(3);

    calls = 0;
    const alwaysLocked = async () => {
      calls++;
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    };
    await expect(writeProfilesFile('x', {}, { platform: 'darwin', write: alwaysLocked })).rejects.toThrow('locked');
    expect(calls).toBe(1);
  });
});
