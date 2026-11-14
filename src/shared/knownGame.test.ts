import { describe, it, expect } from 'vitest';
import { matchKnownGame } from './knownGame';
import { GAME_CATALOG } from './games';

const id = (text: string): string | null => matchKnownGame(text)?.gameId ?? null;

describe('matchKnownGame', () => {
  it('finds Roblox however it is typed (the real submissions)', () => {
    for (const t of ['roblox', 'Roblox', 'ROBLOX', '  roblox  ', 'Roblox Forsaken', 'roblox!', 'Roblox (Backseat)']) {
      expect(id(t), t).toBe('roblox');
    }
    const m = matchKnownGame('roblox');
    expect(m).toEqual({ gameId: 'roblox', name: 'Roblox', backseat: true });
  });

  it('hands back the Roblox experience as a search query, as typed', () => {
    expect(matchKnownGame('Roblox Forsaken')?.query).toBe('Forsaken');
    expect(matchKnownGame('forsaken roblox')?.query).toBe('forsaken');
    expect(matchKnownGame('Forsaken on Roblox')?.query).toBe('Forsaken');
    expect(matchKnownGame('roblox: Grow a Garden')?.query).toBe('Grow a Garden');
    expect(matchKnownGame("Dandy's World roblox")?.query).toBe("Dandy's World");
    expect(matchKnownGame('play roblox games')?.query).toBeUndefined();
    // A sentence is not an experience name.
    expect(
      matchKnownGame('please add roblox so we can play it together every day after school')?.query,
    ).toBeUndefined();
  });

  it('is spacing and apostrophe insensitive, on whole words', () => {
    expect(id('stardewvalley')).toBe('stardew');
    expect(id('Stardew  Valley')).toBe('stardew');
    expect(id('stardew')).toBe('stardew');
    expect(id('Mine craft')).toBe('minecraft');
    expect(id('dont starve together')).toBe('dontstarve');
    expect(id("Don’t Starve")).toBe('dontstarve');
    expect(id('DST')).toBe('dontstarve');
    expect(id('chess')).toBe('chess');
    expect(id('Draw!')).toBe('draw');
    // Part of a longer word is not the game.
    expect(id('drawing')).toBeNull();
    expect(id('chessboard')).toBeNull();
    expect(id('robloxian')).toBeNull();
  });

  it('matches the UI-language names', () => {
    expect(id('我的世界')).toBe('minecraft');
    expect(id('罗布乐思')).toBe('roblox');
    expect(id('星露谷物语')).toBe('stardew');
    expect(id('ロブロックス')).toBe('roblox');
    expect(id('майнкрафт')).toBe('minecraft');
    // No word span inside hanzi, so no query.
    expect(matchKnownGame('罗布乐思')?.query).toBeUndefined();
  });

  it('does not offer a different game that starts with one of ours', () => {
    expect(id('Minecraft Dungeons')).toBeNull();
    expect(id('minecraft bedrock')).toBeNull();
    expect(id('Minecraft Legends')).toBeNull();
    expect(id('minecraft modded')).toBe('minecraft');
  });

  it('says nothing for games we do not have', () => {
    for (const t of ['', '   ', 'COD MODER WARFARE 2', 'Rainbow six seige', 'fortnite', 'Focus', 'Suggest a game', 'valheim']) {
      expect(id(t), t).toBeNull();
    }
  });

  it('never offers a coming-soon tile as a game that already works (261115)', () => {
    for (const t of ['factorio', 'Terraria', 'Slay the Spire 2', 'keep talking and nobody explodes']) {
      expect(id(t), t).toBeNull();
    }
  });

  it('the game named first wins', () => {
    expect(id('chess or roblox')).toBe('chess');
    expect(id('roblox or chess')).toBe('roblox');
  });

  it('only a non-backseat game never carries a query', () => {
    expect(matchKnownGame('minecraft with mods')?.query).toBeUndefined();
  });

  it('every playable catalog game matches its own tile name', () => {
    for (const g of GAME_CATALOG.filter((x) => x.available)) {
      expect(id(g.name), g.name).toBe(g.id);
    }
  });
});
