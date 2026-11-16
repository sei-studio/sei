/**
 * 261116 (product call 261116): a World companion (someone else's character)
 * whose description names a language. Aria's creator wrote "Speak primarily
 * in natural, casual Spanish", and with an English player the # LANGUAGE
 * directive is empty, so the persona's instruction won. The adopted note sits
 * in the persona block AFTER the persona text and names the player's language.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemBlocks } from './chatPrompts';
import { renderAdoptedLanguageNote } from '../../bot/brain/promptLibrary.js';

const args = (extra: Record<string, unknown>) =>
  ({
    persona: { source: 'p', expanded: 'You talk in relaxed, natural Spanish.' },
    name: 'Aria',
    preferredName: 'Ren',
    proactiveness: 1,
    punctuation: 'casual',
    memory: '',
    summary: '',
    openWorldDetected: false,
    inGame: false,
    ...extra,
  }) as Parameters<typeof buildSystemBlocks>[0];

const text = (blocks: Array<{ text: string }>) => blocks.map((b) => b.text).join('\n');

describe('adopted-language note', () => {
  it('is absent for the player’s own companions', () => {
    const all = text(buildSystemBlocks(args({ language: 'en' })));
    expect(all).not.toContain('Someone else wrote your description');
  });

  it('names English for an English player and follows the persona text', () => {
    const blocks = buildSystemBlocks(args({ language: 'en', adoptedLanguage: true }));
    const persona = blocks[1].text;
    expect(persona).toContain(renderAdoptedLanguageNote('en'));
    expect(persona).toContain('talk to this player in English');
    expect(persona.indexOf('Someone else wrote')).toBeGreaterThan(persona.indexOf('natural Spanish'));
  });

  it('names the resolved language for other players', () => {
    const persona = buildSystemBlocks(args({ language: 'ja', adoptedLanguage: true }))[1].text;
    expect(persona).toContain('talk to this player in Japanese');
    const pt = buildSystemBlocks(args({ language: 'pt', adoptedLanguage: true }))[1].text;
    expect(pt).toContain('talk to this player in Brazilian Portuguese');
  });

  it('renders nothing for an unknown code', () => {
    expect(renderAdoptedLanguageNote('xx')).toBe('');
  });
});
