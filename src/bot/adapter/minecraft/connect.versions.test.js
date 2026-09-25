/**
 * Minecraft 26.2 / 26.3 support (patches/*.patch, applied by postinstall).
 *
 * UNSUPPORTED_MC_VERSION was the top summon blocker once 26.2 shipped: the
 * version gate is minecraft-protocol's supportedVersions, and every layer
 * under it (minecraft-data, prismarine-chunk, prismarine-physics, mineflayer's
 * loader) throws on a version it does not know. These tests pin the whole
 * chain so a dependency bump that drops a patch fails here instead of at a
 * user's summon. Live coverage: scripts/mc-version-smoke.mjs.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { supportedVersions } from 'minecraft-protocol/src/version.js';
import { __testables } from './connect.js';

const require = createRequire(import.meta.url);
const minecraftData = require('minecraft-data');
const loadChunk = require('prismarine-chunk');
const { Physics } = require('prismarine-physics');
const { testedVersions } = require('mineflayer/lib/version.js');

const { resolveSupportedVersion, supportedVersionForProtocol } = __testables;

const NEW_VERSIONS = [
  { version: '26.2', protocol: 776 },
  { version: '26.3', protocol: 777 },
];

describe('Minecraft 26.x version gate', () => {
  it('lists 26.2 and 26.3 as supported, newest last', () => {
    expect(supportedVersions).toContain('26.1');
    expect(supportedVersions).toContain('26.2');
    expect(supportedVersions.at(-1)).toBe('26.3');
  });

  it("is within mineflayer's tested range (its loader rejects newer servers)", () => {
    expect(testedVersions).toContain('26.2');
    expect(testedVersions.at(-1)).toBe('26.3');
  });

  for (const { version, protocol } of NEW_VERSIONS) {
    it(`resolves a ${version} server (protocol ${protocol}) by name and by protocol`, () => {
      expect(resolveSupportedVersion(version, protocol)).toBe(version);
      // Modded or proxied servers often report a non-vanilla name.
      expect(resolveSupportedVersion('Paper 1.2.3', protocol)).toBe(version);
      expect(supportedVersionForProtocol(protocol)).toBe(version);
    });
  }

  it('still resolves 26.1 and rejects unknown protocols', () => {
    expect(supportedVersionForProtocol(775)).toBe('26.1');
    expect(resolveSupportedVersion('99.9', 9999)).toBeNull();
  });
});

describe('Minecraft 26.x data and world libraries', () => {
  for (const { version, protocol } of NEW_VERSIONS) {
    it(`minecraft-data has ${version} blocks, items, recipes and protocol`, () => {
      const data = minecraftData(version);
      expect(data.version.version).toBe(protocol);
      expect(data.blocksByName.oak_log).toBeTruthy();
      expect(data.itemsByName.oak_planks).toBeTruthy();
      expect(Object.keys(data.recipes).length).toBeGreaterThan(0);
      expect(data.protocol.play.toServer).toBeTruthy();
    });

    it(`prismarine-chunk and prismarine-physics load for ${version}`, () => {
      const Chunk = loadChunk(version);
      expect(new Chunk({ minY: -64, worldHeight: 384 })).toBeTruthy();
      expect(() => Physics(minecraftData(version), { getBlock: () => null })).not.toThrow();
    });
  }

  it('gates the 26.3 wire changes to 26.3 only', () => {
    // mineflayer's tick_end and shifted dig ids key off these; older versions
    // must keep the old behavior (live-verified on 1.21.1, 26.1, 26.2).
    for (const feature of ['clientTickEndPacket', 'playerActionHasChangeDestroyDirection']) {
      expect(minecraftData('26.3').supportFeature(feature)).toBe(true);
      expect(minecraftData('26.2').supportFeature(feature)).toBe(false);
      expect(minecraftData('1.21.1').supportFeature(feature)).toBe(false);
    }
  });
});
