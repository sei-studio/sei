/**
 * Roblox titles cleaned for the pick step's card captions (261004).
 * The raw titles are real ones from Roblox's popular and search lists.
 */
import { describe, it, expect } from 'vitest';
import { cleanGameTitle } from './gameTitle';

describe('cleanGameTitle', () => {
  it.each([
    ['[ðŸŽƒ] Adopt Me!', 'Adopt Me!'],
    ['[SKY ASSASSIN] Jujutsu Shenanigans', 'Jujutsu Shenanigans'],
    ['Brookhaven ðŸ¡RP', 'Brookhaven RP'],
    ['[ðŸ’°X2] Cameraman Tower Defense', 'Cameraman Tower Defense'],
    ["Dandy's World [ALPHA]", "Dandy's World"],
    ["ðŸŽƒ Dandy's World [ALPHA]", "Dandy's World"],
    ['99 Nights in the Forest ðŸ”¦', '99 Nights in the Forest'],
    ['[ðŸª“EXE REWORK] Tower Defense Simulator', 'Tower Defense Simulator'],
    ['SNACK Defense! ðŸ‰ [TD]', 'SNACK Defense!'],
    ['[ðŸŽ‰FIXESðŸŽ‰] Slop Tower Defense! ðŸ’”', 'Slop Tower Defense!'],
    ['[ðŸŸ£ OMEGA] Alliance Tower Defense! âš”ï¸', 'Alliance Tower Defense!'],
    ['[UPD] [X2] - Blox Fruits', 'Blox Fruits'],
    ['ã€NEWã€‘ Doors', 'Doors'],
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
    expect(cleanGameTitle('[ðŸŽƒ]')).toBe('[ðŸŽƒ]');
    expect(cleanGameTitle('ðŸ”¥ðŸ”¥')).toBe('ðŸ”¥ðŸ”¥');
    expect(cleanGameTitle('[OBBY]')).toBe('[OBBY]');
  });
});




