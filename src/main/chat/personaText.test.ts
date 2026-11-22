// 261013 (T111): the fold / chat-compaction persona fill.
import { describe, expect, it, vi } from 'vitest';

const getCharacter = vi.fn(async () => ({ name: 'Roger' }));
const loadConfig = vi.fn(async () => ({ preferred_name: 'Ouen' }));
vi.mock('../characterStore', () => ({ getCharacter }));
vi.mock('../configStore', () => ({ loadConfig }));

import { resolvePersonaText } from './personaText';

describe('resolvePersonaText', () => {
  it('fills placeholders from the character and profile names', async () => {
    expect(await resolvePersonaText('roger', '{{char}} looks up to {{user}}.')).toBe('Roger looks up to Ouen.');
  });

  it('skips the lookups when the text has no placeholders', async () => {
    getCharacter.mockClear();
    loadConfig.mockClear();
    expect(await resolvePersonaText('sui', 'plain persona')).toBe('plain persona');
    expect(await resolvePersonaText('sui', undefined)).toBe(undefined);
    expect(getCharacter).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });
});




