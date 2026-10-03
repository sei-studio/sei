/**
 * Roblox titles cleaned for display and for the companion's line (261004).
 * The raw titles are real ones from Roblox's popular and search lists.
 */
import { describe, it, expect } from 'vitest';
import { cleanGameTitle, endsWithPunctuation, spokenGameName, SPOKEN_NAME_MAX } from './gameTitle';

describe('cleanGameTitle', () => {
  it.each([
    ['[🎃] Adopt Me!', 'Adopt Me!'],
    ['[SKY ASSASSIN] Jujutsu Shenanigans', 'Jujutsu Shenanigans'],
    ['Brookhaven 🏡RP', 'Brookhaven RP'],
    ['[💰X2] Cameraman Tower Defense', 'Cameraman Tower Defense'],
    ["Dandy's World [ALPHA]", "Dandy's World"],
    ["🎃 Dandy's World [ALPHA]", "Dandy's World"],
    ['99 Nights in the Forest 🔦', '99 Nights in the Forest'],
    ['[🪓EXE REWORK] Tower Defense Simulator', 'Tower Defense Simulator'],
    ['SNACK Defense! 🍉 [TD]', 'SNACK Defense!'],
    ['[🎉FIXES🎉] Slop Tower Defense! 💔', 'Slop Tower Defense!'],
    ['[🟣 OMEGA] Alliance Tower Defense! ⚔️', 'Alliance Tower Defense!'],
    ['[UPD] [X2] - Blox Fruits', 'Blox Fruits'],
    ['【NEW】 Doors', 'Doors'],
    ['Pet Sim (UPD 5)', 'Pet Sim'],
    ['  Murder   Mystery 2  ', 'Murder Mystery 2'],
  ])('%s -> %s', (raw, clean) => {
    expect(cleanGameTitle(raw)).toBe(clean);
  });

  it('keeps a name that only looks like a tag in the middle or is lowercase', () => {
    expect(cleanGameTitle('Piggy (Book 2)')).toBe('Piggy (Book 2)');
    expect(cleanGameTitle('Steal An Egg')).toBe('Steal An Egg');
    expect(cleanGameTitle('Tower [of] Hell')).toBe('Tower [of] Hell');
  });

  it('falls back to the raw title when cleaning would leave nothing', () => {
    expect(cleanGameTitle('[🎃]')).toBe('[🎃]');
    expect(cleanGameTitle('🔥🔥')).toBe('🔥🔥');
    expect(cleanGameTitle('[OBBY]')).toBe('[OBBY]');
  });
});

describe('spokenGameName', () => {
  it('is the clean name when it is short enough to say', () => {
    expect(spokenGameName('[SKY ASSASSIN] Jujutsu Shenanigans')).toBe('Jujutsu Shenanigans');
  });

  it('cuts a long title to its main part, or drops it', () => {
    expect(spokenGameName('Ninja Legends 2: The Very Long Rebirth Update Edition')).toBe('Ninja Legends 2');
    expect(spokenGameName('Super Mega Ultra Long Obby With No Subtitle At All Whatsoever')).toBeNull();
  });

  it('never returns more than SPOKEN_NAME_MAX characters', () => {
    for (const raw of ['x'.repeat(200), 'A: ' + 'b'.repeat(100), '[🎃] ' + 'Adopt Me '.repeat(10)]) {
      const s = spokenGameName(raw);
      if (s !== null) expect(Array.from(s).length).toBeLessThanOrEqual(SPOKEN_NAME_MAX);
    }
  });
});

describe('endsWithPunctuation', () => {
  it('spots a name that already ends a sentence', () => {
    expect(endsWithPunctuation('Adopt Me!')).toBe(true);
    expect(endsWithPunctuation('Who Is It?')).toBe(true);
    expect(endsWithPunctuation('Blox Fruits')).toBe(false);
  });
});
