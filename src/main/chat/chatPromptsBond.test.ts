import { describe, expect, it } from 'vitest';
import { buildSystemBlocks } from './chatPrompts';
import { renderBond } from '../../bot/brain/promptLibrary.js';
import { mergeBond } from '../../bot/brain/memory/bond.js';
import type { Bond } from '../../shared/bondSchema';

const bond = mergeBond(
  null,
  { treated: 'warm', stage: 'familiar', lists: { how_i_feel: ['i like them'], running_jokes: ['the turnip wolf'] } },
  Date.UTC(2026, 10, 13),
) as Bond;

function blocks(over: Partial<Parameters<typeof buildSystemBlocks>[0]> = {}) {
  return buildSystemBlocks({
    persona: { source: 'A cheerful companion.', expanded: 'Sui is cheerful.' },
    name: 'Sui',
    preferredName: 'Alex',
    proactiveness: 1,
    punctuation: 'casual',
    memory: 'm',
    summary: 's',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
    ...over,
  });
}

describe('the bond in the chat prompt (261113, v0.7 D3)', () => {
  it('sits in the cached persona block, after the persona, as renderBond renders it', () => {
    const b = blocks({ bond });
    const persona = b[1].text;
    expect(b[1].cache_control).toEqual({ type: 'ephemeral' });
    const text = renderBond(bond, { userName: 'Alex' });
    expect(persona).toContain(text);
    expect(persona.indexOf(text)).toBeGreaterThan(persona.indexOf('Sui is cheerful.'));
  });

  it('no bond: the prompt is byte-identical to before', () => {
    expect(JSON.stringify(blocks({ bond: null }))).toBe(JSON.stringify(blocks()));
    expect(blocks()[1].text).not.toContain('# YOU AND');
  });

  it('the same text on a call, a game surface and text chat', () => {
    const text = renderBond(bond, { userName: 'Alex' });
    for (const over of [{ voiceCall: true }, { surface: 'game' as const }, {}]) expect(blocks({ bond, ...over })[1].text).toContain(text);
  });
});
