import { describe, expect, it } from 'vitest';
import { gameDisplayName, gameIdFromName, nameInSentence } from './homeNextStep';

describe('nameInSentence (261014)', () => {
  it('raises the first letter of an all-lowercase name', () => {
    expect(nameInSentence('red')).toBe('Red');
    expect(nameInSentence('sui-chan')).toBe('Sui-chan');
    expect(nameInSentence('_marv')).toBe('_Marv');
  });

  it('leaves names with a capital, no cased letters, or nothing alone', () => {
    expect(nameInSentence('Sui')).toBe('Sui');
    expect(nameInSentence('xXSuiXx')).toBe('xXSuiXx');
    expect(nameInSentence('DeepSeek')).toBe('DeepSeek');
    expect(nameInSentence('水星')).toBe('水星');
    expect(nameInSentence('42')).toBe('42');
    expect(nameInSentence('')).toBe('');
  });
});

describe('gameIdFromName (261020)', () => {
  it('reads a bot game by name or id, in any case and punctuation', () => {
    expect(gameIdFromName('Minecraft')).toBe('minecraft');
    expect(gameIdFromName('Stardew Valley')).toBe('stardew');
    expect(gameIdFromName('stardew')).toBe('stardew');
    expect(gameIdFromName("Don't Starve Together")).toBe('dontstarve');
    expect(gameIdFromName('Don’t Starve Together.')).toBe('dontstarve');
    expect(gameIdFromName('the Minecraft world')).toBe('minecraft');
  });

  it('is null for no game, an unknown one, or two at once', () => {
    expect(gameIdFromName(null)).toBeNull();
    expect(gameIdFromName('')).toBeNull();
    expect(gameIdFromName('Hollow Knight')).toBeNull();
    expect(gameIdFromName('Chess')).toBeNull();
    expect(gameIdFromName('Minecraft and Stardew Valley')).toBeNull();
  });

  it('names a game the way plan lines write it', () => {
    expect(gameDisplayName('stardew')).toBe('Stardew Valley');
    expect(gameDisplayName('dontstarve')).toBe("Don't Starve Together");
    expect(gameIdFromName(gameDisplayName('minecraft'))).toBe('minecraft');
  });
});
