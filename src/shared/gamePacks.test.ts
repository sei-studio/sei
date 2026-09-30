/**
 * Pure helpers of the game pack contract (260908). Pins:
 *   1. Asset naming round-trips through parsePackAssetName, including the
 *      `any-any` form for a pack with no native code.
 *   2. Sources are mirror FIRST (bounded connect) then the GitHub release, and
 *      the mirror path is flat under /updates/ (mirror-release.yml's layout).
 *   3. pickPackEntry prefers the exact platform+arch, falls back to any/any,
 *      and returns null otherwise.
 *   4. The manifest parser rejects a malformed entry.
 *   5. packSizeMb / packProgressPct clamp the way the card expects.
 * (The ERROR_COPY size pin lives in the renderer's GamePackCard.test.tsx: a
 * renderer import here would pull `@shared/*` aliases into the node tsconfig
 * project, which has none.)
 */
import { describe, it, expect } from 'vitest';
import {
  GAME_PACK_MIRROR_BASE,
  gamePackOriginBase,
  gamePackSources,
  manifestAssetName,
  manifestSources,
  packAssetName,
  packProgressPct,
  packSizeMb,
  packSizeLabel,
  parseGamePackManifest,
  parsePackAssetName,
  pickPackEntry,
} from './gamePacks';

const entry = (platform: string, arch: string) => ({
  game: 'minecraft',
  platform,
  arch,
  file: packAssetName('minecraft', '1.0.0', platform as 'darwin', arch as 'arm64'),
  sha256: 'a'.repeat(64),
  bytes: 10,
  treeHash: 'b'.repeat(64),
});

describe('gamePacks: naming', () => {
  it('Test 1: pack + manifest names round-trip', () => {
    expect(packAssetName('minecraft', '0.7.0', 'darwin', 'arm64')).toBe('sei-pack-minecraft-0.7.0-darwin-arm64.zip');
    expect(packAssetName('minecraft', '0.7.0-beta.2', 'any', 'any')).toBe('sei-pack-minecraft-0.7.0-beta.2-any-any.zip');
    expect(parsePackAssetName('sei-pack-minecraft-0.7.0-beta.2-win32-x64.zip')).toEqual({
      game: 'minecraft',
      version: '0.7.0-beta.2',
      platform: 'win32',
      arch: 'x64',
    });
    expect(parsePackAssetName('Sei-mac-arm64.zip')).toBeNull();
    expect(manifestAssetName('0.7.0')).toBe('game-packs-0.7.0.json');
  });

  it('Test 2: sources are mirror first with a connect budget, then the release', () => {
    const s = gamePackSources('0.7.0', 'sei-pack-minecraft-0.7.0-darwin-arm64.zip');
    expect(s[0].url).toBe(`${GAME_PACK_MIRROR_BASE}/stable/sei-pack-minecraft-0.7.0-darwin-arm64.zip`);
    expect(s[0].connectTimeoutMs).toBeGreaterThan(0);
    expect(s[1].url).toBe(`${gamePackOriginBase('0.7.0')}/sei-pack-minecraft-0.7.0-darwin-arm64.zip`);
    expect(s[1].connectTimeoutMs).toBeUndefined();
    expect(GAME_PACK_MIRROR_BASE).toBe('https://dl.sei.gg/updates');
    expect(gamePackOriginBase('0.7.0')).toBe('https://github.com/sei-studio/sei/releases/download/v0.7.0');
    expect(manifestSources('0.7.0')[0].url).toBe(`${GAME_PACK_MIRROR_BASE}/stable/game-packs-0.7.0.json`);
    // A prerelease build was cut from a pre-release tag, which mirror-release.yml files under beta/.
    expect(manifestSources('0.6.5-beta.1')[0].url).toBe(`${GAME_PACK_MIRROR_BASE}/beta/game-packs-0.6.5-beta.1.json`);
    expect(gamePackSources('0.6.5-beta.1', 'x.zip')[0].url).toBe(`${GAME_PACK_MIRROR_BASE}/beta/x.zip`);
  });
});

describe('gamePacks: manifest', () => {
  it('Test 3: pickPackEntry prefers exact, falls back to any/any, else null', () => {
    const m = { version: '1.0.0', packs: [entry('darwin', 'arm64'), entry('any', 'any')] };
    expect(pickPackEntry(m, 'minecraft', 'darwin', 'arm64')?.platform).toBe('darwin');
    expect(pickPackEntry(m, 'minecraft', 'win32', 'x64')?.platform).toBe('any');
    const strict = { version: '1.0.0', packs: [entry('darwin', 'arm64')] };
    expect(pickPackEntry(strict, 'minecraft', 'win32', 'x64')).toBeNull();
  });

  it('Test 4: the parser rejects a malformed entry', () => {
    expect(() => parseGamePackManifest({ version: '1', packs: [{ game: 'minecraft' }] })).toThrow();
    expect(() => parseGamePackManifest({ version: '1', packs: [{ ...entry('darwin', 'arm64'), sha256: 'zz' }] })).toThrow();
    expect(parseGamePackManifest({ version: '1', packs: [entry('darwin', 'arm64')] }).packs).toHaveLength(1);
  });
});

describe('gamePacks: copy helpers', () => {
  it('Test 5: size + progress clamp', () => {
    expect(packSizeMb(100)).toBe(1);
    expect(packSizeMb(120 * 1024 * 1024)).toBe(120);
    expect(packSizeLabel(30 * 1024)).toBe('30 KB');
    expect(packSizeLabel(100)).toBe('1 KB');
    expect(packSizeLabel(50 * 1024 * 1024)).toBe('50 MB');
    expect(packSizeLabel(12 * 1024 * 1024, 48 * 1024 * 1024)).toBe('12 MB');
    expect(packSizeLabel(12 * 1024, 107 * 1024)).toBe('12 KB');
    expect(packProgressPct(0, 0)).toBe(0);
    expect(packProgressPct(50, 100)).toBe(50);
    expect(packProgressPct(200, 100)).toBe(100);
  });
});
