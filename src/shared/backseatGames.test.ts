/**
 * Backseat game registry (260929): link parsing and the share-picker hint.
 */
import { describe, it, expect } from 'vitest';
import {
  BACKSEAT_GAMES,
  backseatGame,
  isBackseatGameId,
  looksLikeLink,
  parseRobloxLink,
  pickHintedSource,
} from './backseatGames';

describe('parseRobloxLink', () => {
  it.each([
    ['https://www.roblox.com/games/4924922222/Brookhaven-RP', 4924922222],
    ['http://www.roblox.com/games/4924922222/Brookhaven-RP', 4924922222],
    ['https://roblox.com/games/4924922222', 4924922222],
    ['www.roblox.com/games/4924922222/Brookhaven-RP', 4924922222],
    ['roblox.com/games/4924922222/', 4924922222],
    ['https://web.roblox.com/games/2753915549/Blox-Fruits?gameSetTypeId=1', 2753915549],
    ['https://m.roblox.com/games/142823291', 142823291],
    ['https://www.roblox.com/de/games/1962086868/Tower-of-Hell', 1962086868],
    ['https://www.roblox.com/pt-br/games/1962086868/Tower-of-Hell#!/about', 1962086868],
    ['https://www.roblox.com/games/start?placeId=6516141723&launchData=x', 6516141723],
    ['  https://www.roblox.com/games/79546208627805/99-Nights  ', 79546208627805],
  ])('reads %s', (input, placeId) => {
    expect(parseRobloxLink(input)).toEqual({ placeId });
  });

  it.each([
    'brookhaven',
    '4924922222',
    'https://www.roblox.com/share?code=abc&type=ExperienceDetails',
    'https://www.roblox.com/users/1/profile',
    'https://www.roblox.com/games/',
    'https://www.roblox.com/games/abc/x',
    'https://www.roblox.com/games/0/x',
    'https://evil-roblox.com/games/4924922222',
    'https://roblox.com.evil.io/games/4924922222',
    'javascript://roblox.com/games/1',
    'ftp://roblox.com/games/4924922222',
    'https://www.roblox.com/games/99999999999999999999/x',
    'https://www.roblox.com/games/start?placeId=nope',
    'roblox.com/games/4924922222 and more',
  ])('rejects %s', (input) => {
    expect(parseRobloxLink(input)).toBeNull();
  });

  it('tells a link attempt from a search', () => {
    expect(looksLikeLink('https://www.roblox.com/share?code=abc')).toBe(true);
    expect(looksLikeLink('www.something')).toBe(true);
    expect(looksLikeLink('roblox.com/whatever')).toBe(true);
    expect(looksLikeLink('blox fruits')).toBe(false);
    expect(looksLikeLink('Dr. Seuss obby')).toBe(false);
  });
});

describe('pickHintedSource', () => {
  const w = (id: string, name: string) => ({ id, name, kind: 'window' as const });
  const names = backseatGame('roblox')!.windowNames;

  it('prefers the exact window title, case-insensitively', () => {
    const sources = [
      w('window:1', 'Roblox Studio'),
      w('window:2', 'roblox'),
      { id: 'screen:0', name: 'Roblox', kind: 'screen' as const },
    ];
    expect(pickHintedSource(sources, names)?.id).toBe('window:2');
  });

  it('falls back to a word match, but never a browser tab or a screen', () => {
    expect(pickHintedSource([w('window:3', 'Roblox Player - Brookhaven')], names)?.id).toBe('window:3');
    expect(
      pickHintedSource([w('window:4', 'Brookhaven - Roblox - Google Chrome')], names),
    ).toBeNull();
    expect(pickHintedSource([{ id: 'screen:0', name: 'Roblox', kind: 'screen' as const }], names)).toBeNull();
    expect(pickHintedSource([w('window:5', 'Robloxian fan art')], names)).toBeNull();
    expect(pickHintedSource([w('window:6', 'Roblox')], [])).toBeNull();
  });
});

describe('registry', () => {
  it('knows its games and nothing else', () => {
    expect(isBackseatGameId('roblox')).toBe(true);
    expect(isBackseatGameId('minecraft')).toBe(false);
    expect(isBackseatGameId(undefined)).toBe(false);
  });

  it('has user-facing copy and knowledge with no em dashes', () => {
    for (const g of BACKSEAT_GAMES) {
      for (const text of [g.name, g.tileName, g.promptName, g.tileDescription, g.introCopy, g.knowledge]) {
        expect(text).not.toMatch(/—/);
      }
    }
  });

  it('keeps the exact intro copy from the brief', () => {
    expect(backseatGame('roblox')!.introCopy).toBe(
      'Roblox is available via Backseat: your companion can watch you play through your screen.',
    );
  });
});
