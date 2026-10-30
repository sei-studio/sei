import { describe, expect, it } from 'vitest';
import {
  channelsForRelease,
  compareVersions,
  maxVersion,
  mergeReleases,
  migrationRule,
  onlyVersion,
  parseReleases,
  parseSetupManifest,
  previousFull,
  rolloutRule,
  setupKey,
  shouldReplaceSetup,
} from './velopackFeed.mjs';

const full = (v, ch = '') => ({ Version: v, FileName: `Sei-${v}${ch}-full.nupkg`, Type: 'Full', Size: 10, SHA256: 'ab' });
const delta = (v, ch = '') => ({ Version: v, FileName: `Sei-${v}${ch}-delta.nupkg`, Type: 'Delta', Size: 2, SHA256: 'cd' });
const SHA = 'a'.repeat(64);

describe('compareVersions', () => {
  it('orders numbers, then a stable above its prereleases', () => {
    expect(compareVersions('0.7.0', '0.6.10')).toBe(1);
    expect(compareVersions('0.7.0-beta.2', '0.7.0-beta.10')).toBe(-1);
    expect(compareVersions('0.7.0', '0.7.0-beta.9')).toBe(1);
    expect(compareVersions('v0.7.0', '0.7.0')).toBe(0);
  });
});

describe('parseReleases', () => {
  it('accepts a vpk index and rejects what the updater could not read', () => {
    expect(parseReleases(JSON.stringify({ Assets: [full('0.7.0')] })).Assets).toHaveLength(1);
    expect(() => parseReleases({})).toThrow(/Assets/);
    expect(() => parseReleases({ Assets: [{ ...full('0.7.0'), FileName: '../x.nupkg' }] })).toThrow(/FileName/);
    expect(() => parseReleases({ Assets: [{ ...full('0.7.0'), Type: 'Weird' }] })).toThrow(/Type/);
    expect(() => parseReleases({ Assets: [{ ...full('0.7.0'), Version: 'x' }] })).toThrow(/Version/);
  });
});

describe('index helpers', () => {
  const r = { Assets: [full('0.7.0'), full('0.7.1'), delta('0.7.1'), full('0.7.2-beta.1')] };
  it('finds the max Full and the delta base strictly below a version', () => {
    expect(maxVersion(r)).toBe('0.7.2-beta.1');
    expect(previousFull(r, '0.7.2').Version).toBe('0.7.2-beta.1');
    expect(previousFull(r, '0.7.1').Version).toBe('0.7.0');
    expect(previousFull(r, '0.7.0')).toBeNull();
    expect(maxVersion({ Assets: [delta('0.9.0')] })).toBeNull();
  });
  it('trims to one version', () => {
    expect(onlyVersion(r, '0.7.1').Assets.map((a) => a.Type)).toEqual(['Full', 'Delta']);
  });
});

describe('mergeReleases', () => {
  it('adds a release, replaces a re-published file and keeps the newest N versions', () => {
    const existing = { Assets: [full('0.7.0'), full('0.7.1'), delta('0.7.1')] };
    const incoming = { Assets: [full('0.7.2'), delta('0.7.2')] };
    const { releases, dropped } = mergeReleases(existing, incoming, 2);
    expect(releases.Assets.map((a) => a.FileName)).toEqual([
      'Sei-0.7.1-full.nupkg',
      'Sei-0.7.1-delta.nupkg',
      'Sei-0.7.2-full.nupkg',
      'Sei-0.7.2-delta.nupkg',
    ]);
    expect(dropped).toEqual(['Sei-0.7.0-full.nupkg']);
    const again = mergeReleases(releases, { Assets: [{ ...full('0.7.2'), SHA256: 'ff' }] }, 2).releases;
    expect(again.Assets.filter((a) => a.FileName === 'Sei-0.7.2-full.nupkg')).toEqual([{ ...full('0.7.2'), SHA256: 'ff' }]);
  });
  it('merges into an empty feed', () => {
    expect(mergeReleases({ Assets: [] }, { Assets: [full('0.7.0')] }).releases.Assets).toHaveLength(1);
  });
});

describe('channelsForRelease', () => {
  it('beta only for a prerelease; a stable joins beta unless beta is at or past it', () => {
    expect(channelsForRelease('0.7.0-beta.1', null)).toEqual(['beta']);
    expect(channelsForRelease('0.7.0', null)).toEqual(['win', 'beta']);
    expect(channelsForRelease('0.7.0', '0.7.0-beta.4')).toEqual(['win', 'beta']);
    expect(channelsForRelease('0.7.0', '0.7.1-beta.1')).toEqual(['win']);
    expect(channelsForRelease('0.7.0', '0.7.0')).toEqual(['win']);
  });
});

describe('setup manifest', () => {
  const m = { version: '0.7.0', tag: 'v0.7.0', file: 'Sei-win-Setup.exe', sha256: SHA, size: 5 };
  it('validates and keys', () => {
    expect(parseSetupManifest(JSON.stringify(m))).toEqual(m);
    expect(setupKey(m)).toBe('setup/v0.7.0/Sei-win-Setup.exe');
    expect(() => parseSetupManifest({ ...m, file: '../a.exe' })).toThrow(/file/);
    expect(() => parseSetupManifest({ ...m, file: 'a.msi' })).toThrow(/file/);
    expect(() => parseSetupManifest({ ...m, sha256: 'xyz' })).toThrow(/sha256/);
    expect(() => parseSetupManifest({ ...m, size: 0 })).toThrow(/size/);
    expect(() => parseSetupManifest({ ...m, tag: '0.7.0' })).toThrow(/tag/);
  });
  it('never moves backwards', () => {
    expect(shouldReplaceSetup(null, m)).toBe(true);
    expect(shouldReplaceSetup({ ...m, version: '0.7.1' }, m)).toBe(false);
    expect(shouldReplaceSetup({ ...m, version: '0.7.0-beta.3' }, m)).toBe(true);
  });
});

describe('rules', () => {
  it('validate percent, version and epoch', () => {
    expect(rolloutRule('0.7.1', '20')).toEqual({ version: '0.7.1', percent: 20 });
    expect(() => rolloutRule('0.7.1', 101)).toThrow(/percent/);
    expect(() => rolloutRule('latest', 5)).toThrow(/version/);
    expect(migrationRule(10, 2)).toEqual({ percent: 10, epoch: 2 });
    expect(() => migrationRule(10, 1.5)).toThrow(/epoch/);
    expect(() => migrationRule(-1, 0)).toThrow(/percent/);
  });
});
