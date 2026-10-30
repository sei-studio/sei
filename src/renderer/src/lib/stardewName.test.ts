// The renderer mirror of the Stardew companion name (261027 accent fold).
// Same cases as src/main/games/stardew/index.test.ts and the bot's
// runtime.test.js, so the three stay in agreement.
import { describe, it, expect } from 'vitest';
import { effectiveStardewName } from './stardewName';

describe('renderer effectiveStardewName', () => {
  it('folds accents like main and the bot', () => {
    expect(effectiveStardewName({ name: 'Sui', username: null })).toBe('Sui');
    expect(effectiveStardewName({ name: 'Martín Salazar', username: null })).toBe('Martin Salazar');
    expect(effectiveStardewName({ name: 'Lucía', username: '' })).toBe('Lucia');
    expect(effectiveStardewName({ name: '晨辉 (Chénhuī)', username: null })).toBe('Chenhui');
    expect(effectiveStardewName({ name: '诗诗', username: null })).toBe('Sei');
    expect(effectiveStardewName({ name: 'x', username: 'Marv_2' })).toBe('Marv_2');
  });
});
