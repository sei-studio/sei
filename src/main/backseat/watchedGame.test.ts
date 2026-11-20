/** 261031 (T278): Watch-together `game` from the shared window title, closed list only. */
import { describe, expect, it } from 'vitest';
import { WATCHED_GAME_IDS, WatchedTally, classifyWatched, watchedProps } from './watchedGame';

describe('classifyWatched', () => {
  it('names well-known games from their window titles', () => {
    expect(classifyWatched('VALORANT  ')).toEqual({ kind: 'game', game: 'valorant' });
    expect(classifyWatched('Minecraft* 1.21.1 - Multiplayer (LAN)')).toEqual({ kind: 'game', game: 'minecraft' });
    expect(classifyWatched('Minecraft Dungeons')).toEqual({ kind: 'game', game: 'minecraft_dungeons' });
    expect(classifyWatched('League of Legends (TM) Client')).toEqual({ kind: 'game', game: 'league_of_legends' });
    expect(classifyWatched('Counter-Strike 2')).toEqual({ kind: 'game', game: 'counter_strike' });
    expect(classifyWatched('ELDEN RING™')).toEqual({ kind: 'game', game: 'elden_ring' });
    expect(classifyWatched('Roblox')).toEqual({ kind: 'game', game: 'roblox' });
    expect(classifyWatched('Stardew Valley')).toEqual({ kind: 'game', game: 'stardew_valley' });
    expect(classifyWatched('Rust')).toEqual({ kind: 'game', game: 'rust' });
  });

  it('a browser tab about a game is the browser, a video service is video', () => {
    expect(classifyWatched('Roblox - Google Chrome')).toEqual({ kind: 'browser' });
    expect(classifyWatched('Minecraft speedrun - YouTube - Google Chrome')).toEqual({ kind: 'video' });
    expect(classifyWatched('Netflix')).toEqual({ kind: 'video' });
  });

  it('unrelated titles are other, screens and empty are unknown', () => {
    expect(classifyWatched('main.rs - rust - Visual Studio Code')).toEqual({ kind: 'other' });
    expect(classifyWatched('Untitled - Notepad')).toEqual({ kind: 'other' });
    expect(classifyWatched('Entire screen')).toEqual({ kind: 'unknown' });
    expect(classifyWatched('Screen 1')).toEqual({ kind: 'unknown' });
    expect(classifyWatched('')).toEqual({ kind: 'unknown' });
    expect(classifyWatched(null)).toEqual({ kind: 'unknown' });
  });

  it('ids are snake_case and unique', () => {
    expect(new Set(WATCHED_GAME_IDS).size).toBe(WATCHED_GAME_IDS.length);
    for (const id of WATCHED_GAME_IDS) expect(id).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('WatchedTally', () => {
  it('the most frequent class wins; a game wins a tie', () => {
    const t = new WatchedTally();
    t.note('Entire screen');
    t.note('Steam');
    t.note('Lethal Company');
    expect(t.top()).toEqual({ kind: 'game', game: 'lethal_company' });
    t.note('Steam');
    expect(t.top()).toEqual({ kind: 'other' });
    expect(new WatchedTally().top()).toEqual({ kind: 'unknown' });
  });
});

describe('watchedProps', () => {
  it('a tile id wins; a detected game is tagged title; else only the kind', () => {
    expect(watchedProps('roblox', { kind: 'other' })).toEqual({ game: 'roblox', game_source: 'tile', watched_kind: 'game' });
    expect(watchedProps(null, { kind: 'game', game: 'valorant' })).toEqual({
      game: 'valorant',
      game_source: 'title',
      watched_kind: 'game',
    });
    expect(watchedProps(null, { kind: 'video' })).toEqual({ watched_kind: 'video' });
  });
});
