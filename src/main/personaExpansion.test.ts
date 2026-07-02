/**
 * personaExpansion.test.ts
 *
 * Locks in: buildExpansionUserMessage emits the "Character name: <name>" header
 * line AND the franchise-context closing nudge, the four-section base-personality
 * contract (CORE / VOICE / EXTERNAL / INTERNAL), the leading
 * `PROACTIVENESS: <word>` line being parsed to a level and stripped from the
 * persona text, the real-person likeness guard, and streaming progress.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExpansionUserMessage,
  expandPersona,
  computeExpansionProgress,
  parseProactivenessLine,
  EXPANSION_SYSTEM,
  type ExpansionProgress,
} from './personaExpansion';

const FOUR_SECTIONS = [
  '# CORE', 'skzzy, agender, ageless. an original moss-goblin.',
  '# VOICE', 'lowercase. terse. you call the player "you" never their name as subject.',
  '# EXTERNAL', 'prickly in a crowd, softens one-on-one. competitive but not cruel.',
  '# INTERNAL', 'values: mischief, moss, solitude. you need to be left to your own schemes.',
].join('\n\n');

// What the model actually returns: a leading PROACTIVENESS line + the sections.
const MODEL_OUTPUT = 'PROACTIVENESS: agentic\n\n' + FOUR_SECTIONS;

/** Build a `_clientFactory` fake whose `create` resolves to an async-iterable
 *  Stream of `content_block_delta` events — mirrors the SDK streaming shape. */
function streamingClientFactory(chunks: string[]) {
  return () => ({
    messages: {
      create: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } };
          for (const text of chunks) {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
          }
          yield { type: 'message_stop' };
        },
      }),
    },
  });
}

describe('buildExpansionUserMessage carries the character name', () => {
  it('puts "Character name: <name>" at the top of the user message', () => {
    const msg = buildExpansionUserMessage('Pikachu', 'a friendly companion');
    expect(msg.startsWith('Character name: Pikachu')).toBe(true);
  });

  it('includes the source blurb under a labeled header', () => {
    const msg = buildExpansionUserMessage('Goku', 'cheerful saiyan warrior');
    expect(msg).toContain('Source persona (user-written blurb):');
    expect(msg).toContain('cheerful saiyan warrior');
  });

  it('appends prior expanded persona when provided', () => {
    const msg = buildExpansionUserMessage('Mario', 'plumber', '# IDENTITY\nYou are Mario...');
    expect(msg).toContain('Prior expanded persona');
    expect(msg).toContain('# IDENTITY\nYou are Mario...');
  });

  it('omits the prior-expanded block when not provided', () => {
    expect(buildExpansionUserMessage('Link', 'silent hero')).not.toContain('Prior expanded persona');
  });

  it('does NOT inject any proactiveness tier hint (the expander chooses now)', () => {
    const msg = buildExpansionUserMessage('Sui', 'chaotic builder');
    expect(msg).not.toMatch(/Proactiveness tier/i);
  });

  it('closes with the franchise-context nudge', () => {
    const msg = buildExpansionUserMessage('Pikachu', 'pocket monster');
    expect(msg).toContain('If the name matches a known franchise character (e.g. Pikachu, Goku)');
    expect(msg).toContain('CORE and VOICE sections');
  });
});

describe('parseProactivenessLine', () => {
  it('maps the chosen word to a level and strips the line from the body', () => {
    expect(parseProactivenessLine('PROACTIVENESS: passive\n\n# IDENTITY\nx'))
      .toEqual({ level: 0, body: '# IDENTITY\nx' });
    expect(parseProactivenessLine('PROACTIVENESS: reactive\n\n# IDENTITY\nx').level).toBe(1);
    expect(parseProactivenessLine('PROACTIVENESS: agentic\n\n# IDENTITY\nx').level).toBe(2);
  });

  it('defaults to reactive (1) and keeps the text when the line is absent', () => {
    const r = parseProactivenessLine('# IDENTITY\nno proactiveness line here');
    expect(r.level).toBe(1);
    expect(r.body).toContain('# IDENTITY');
  });
});

describe('EXPANSION_SYSTEM contract', () => {
  it('describes the four base sections and the three proactiveness levels', () => {
    for (const h of ['# CORE', '# VOICE', '# EXTERNAL', '# INTERNAL']) {
      expect(EXPANSION_SYSTEM).toContain(h);
    }
    for (const w of ['passive', 'reactive', 'agentic']) {
      expect(EXPANSION_SYSTEM).toContain(w);
    }
    // The retired six-section headers are gone.
    expect(EXPANSION_SYSTEM).not.toContain('# REACTIONS');
    expect(EXPANSION_SYSTEM).not.toContain('# DEFAULT DYNAMIC');
  });

  it('asks for the parseable, config-only PROACTIVENESS first line', () => {
    expect(EXPANSION_SYSTEM).toContain('PROACTIVENESS: <passive|reactive|agentic>');
  });

  it('keeps EXTERNAL about personality, not activity level, and drops the old stance derivation', () => {
    expect(EXPANSION_SYSTEM).not.toContain('PLAYER-STANCE');
    expect(EXPANSION_SYSTEM).not.toContain('`follow`');
    expect(EXPANSION_SYSTEM).toContain('NOT how active or self-directed they are');
  });

  it('forbids leaking game mechanics into the base personality', () => {
    expect(EXPANSION_SYSTEM).toContain("do NOT reference any game's mechanics");
  });

  it('keeps the real-person likeness guard', () => {
    expect(EXPANSION_SYSTEM).toContain('REFUSED:REAL_PERSON');
    expect(EXPANSION_SYSTEM).toContain('real living person');
    expect(EXPANSION_SYSTEM).toContain('public figure');
  });
});

describe('expandPersona', () => {
  it('parses the proactiveness level, strips its line, and returns the four-section body', async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: 'text' as const, text: MODEL_OUTPUT }] }) },
    };
    const result = await expandPersona({
      name: 'Skzzy',
      source: 'a small moss-covered goblin',
      apiKey: 'sk-test',
      _clientFactory: () => fakeClient,
    });
    expect(result.proactiveness).toBe(2);
    expect(result.expanded).toBe(FOUR_SECTIONS);
    expect(result.expanded).not.toContain('PROACTIVENESS:');
  });

  it('defaults proactiveness to reactive (1) when the model omits the line', async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: 'text' as const, text: FOUR_SECTIONS }] }) },
    };
    const result = await expandPersona({
      name: 'Skzzy', source: 'goblin', apiKey: 'sk-test', _clientFactory: () => fakeClient,
    });
    expect(result.proactiveness).toBe(1);
    expect(result.expanded).toBe(FOUR_SECTIONS);
  });

  it('throws a friendly error on the refusal sentinel', async () => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: 'text' as const, text: 'REFUSED:REAL_PERSON' }] }) },
    };
    await expect(
      expandPersona({ name: 'Elvis', source: 'the king of rock and roll', apiKey: 'sk-test', _clientFactory: () => fakeClient }),
    ).rejects.toThrow(/real people/);
  });
});

describe('streaming expansion', () => {
  it('accumulates chunks, strips the proactiveness line, and returns the body', async () => {
    const chunks = MODEL_OUTPUT.match(/.{1,12}/gs) ?? [MODEL_OUTPUT];
    const result = await expandPersona({
      name: 'Skzzy', source: 'goblin', apiKey: 'sk-test', _clientFactory: streamingClientFactory(chunks),
    });
    expect(result.proactiveness).toBe(2);
    expect(result.expanded).toBe(FOUR_SECTIONS);
  });

  it('emits monotonic-ish onProgress ticks ending near completion', async () => {
    const chunks = MODEL_OUTPUT.match(/.{1,12}/gs) ?? [MODEL_OUTPUT];
    const ticks: ExpansionProgress[] = [];
    await expandPersona({
      name: 'Skzzy', source: 'goblin', apiKey: 'sk-test',
      onProgress: (p) => ticks.push(p), _clientFactory: streamingClientFactory(chunks),
    });
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks[0]?.section).toBe('Connecting');
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.fraction).toBeGreaterThanOrEqual(ticks[i - 1]!.fraction);
    }
    const last = ticks[ticks.length - 1]!;
    expect(last.fraction).toBeGreaterThan(0.5);
    expect(last.section).toBe('Values & needs');
  });

  it('still validates missing sections on the streamed text', async () => {
    await expect(
      expandPersona({
        name: 'Skzzy', source: 'goblin', apiKey: 'sk-test',
        _clientFactory: streamingClientFactory(['# IDENTITY\nonly one section']),
      }),
    ).rejects.toThrow(/missing sections/);
  });

  it('detects the refusal sentinel when streamed', async () => {
    await expect(
      expandPersona({
        name: 'Elvis', source: 'the king', apiKey: 'sk-test',
        _clientFactory: streamingClientFactory(['REFUSED', ':REAL_PERSON']),
      }),
    ).rejects.toThrow(/real people/);
  });
});

describe('computeExpansionProgress', () => {
  it('reports "Warming up" with a small fraction before any header', () => {
    const p = computeExpansionProgress('the model is just starting to think');
    expect(p.section).toBe('Warming up');
    expect(p.fraction).toBeLessThan(0.2);
  });

  it('labels the current section as headers stream in', () => {
    expect(computeExpansionProgress('# CORE\nyou are…').section).toBe('Core');
    expect(computeExpansionProgress('# CORE\nx\n\n# VOICE\nlowercase').section).toBe('Voice & samples');
  });

  it('caps the fraction at 0.97 even for a complete four-section text', () => {
    const p = computeExpansionProgress(FOUR_SECTIONS + '\n'.repeat(50) + 'x'.repeat(2000));
    expect(p.section).toBe('Values & needs');
    expect(p.fraction).toBeLessThanOrEqual(0.97);
    expect(p.fraction).toBeGreaterThan(0.8);
  });
});
