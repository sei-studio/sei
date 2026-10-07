import { describe, it, expect } from 'vitest';
import { messageSaysFabric, namedMods } from './moddedHost';

// 261007: the bot's humanized Fabric registry-sync kick, as the status carries it.
const FABRIC =
  'MODDED_HOST_REJECTED: This world runs Fabric with mods that add content, and it only lets in players who have those mods. ' +
  'Sei joins as a vanilla client, so the world turns it away. The mods it names: xaerominimap, xaeroworldmap.';
const FORGE =
  'MODDED_HOST_REJECTED: This world runs Forge or NeoForge and only lets in players who have its mods. Sei joins as a vanilla client, so the world turns it away.';

describe('moddedHost message helpers', () => {
  it('reads the mods a Fabric kick named', () => {
    expect(namedMods(FABRIC)).toEqual(['xaerominimap', 'xaeroworldmap']);
    expect(namedMods(FORGE)).toEqual([]);
    expect(namedMods(undefined)).toEqual([]);
  });

  it('keeps dotted ids and drops anything that is not an id', () => {
    expect(namedMods('The mods it names: a.b, <b>x</b>, ok_mod.')).toEqual(['a.b', 'ok_mod']);
  });

  it('says Fabric only for a Fabric message', () => {
    expect(messageSaysFabric(FABRIC)).toBe(true);
    expect(messageSaysFabric(FORGE)).toBe(false);
    expect(messageSaysFabric(undefined)).toBe(false);
  });
});
