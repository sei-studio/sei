/** Helper-mod version comparison (260925): SMAPI manifest + DST modinfo versions. */
import { describe, it, expect } from 'vitest';
import { compareModVersions, packModIsNewer, parseModVersion } from './modVersion';

describe('compareModVersions', () => {
  it('orders dotted numeric versions numerically, missing parts as 0', () => {
    expect(compareModVersions('0.1.1', '0.1.0')).toBe(1);
    expect(compareModVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareModVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareModVersions('1.2', '1.2.0')).toBe(0);
    expect(compareModVersions('2', '1.99.99')).toBe(1);
    expect(compareModVersions(' v1.0.0 ', '1.0.0')).toBe(0);
  });

  it('puts a prerelease before its release, compares prerelease fields like semver, ignores build metadata', () => {
    expect(compareModVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareModVersions('1.0.0', '1.0.0-beta.2')).toBe(1);
    expect(compareModVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareModVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareModVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(compareModVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareModVersions('1.0.0+abc', '1.0.0+def')).toBe(0);
  });

  it('returns null when either side is not a version', () => {
    expect(compareModVersions('latest', '1.0.0')).toBeNull();
    expect(compareModVersions('1.0.0', null)).toBeNull();
    expect(compareModVersions(undefined, undefined)).toBeNull();
    expect(parseModVersion('')).toBeNull();
    expect(parseModVersion('1..2')).toBeNull();
  });
});

describe('packModIsNewer', () => {
  it('replaces only when the pack is newer or the installed version is unreadable', () => {
    expect(packModIsNewer('0.1.1', '0.1.0')).toBe(true);
    expect(packModIsNewer('0.1.1', '0.1.1')).toBe(false);
    expect(packModIsNewer('0.1.0', '0.1.1')).toBe(false);
    expect(packModIsNewer('0.1.1', null)).toBe(true);
    expect(packModIsNewer('0.1.1', 'garbage')).toBe(true);
    expect(packModIsNewer(null, '0.1.0')).toBe(false);
    expect(packModIsNewer('garbage', null)).toBe(false);
  });
});
