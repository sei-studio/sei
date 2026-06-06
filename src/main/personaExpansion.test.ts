/**
 * personaExpansion.test.ts — ITEM 12 (quick/260523-t8d) regression test.
 *
 * Locks in: buildExpansionUserMessage emits the "Character name: <name>"
 * header line AND the franchise-context closing nudge so the model gets
 * franchise-name signal (Pikachu / Goku / Mario / etc.).
 */

import { describe, it, expect } from 'vitest';
import {
  buildExpansionUserMessage,
  expandPersona,
  computeExpansionProgress,
  EXPANSION_SYSTEM,
  type ExpansionProgress,
} from './personaExpansion';

const SIX_SECTIONS = [
  '# IDENTITY', 'you are skzzy, an original moss-goblin.',
  '# VOICE', 'lowercase. terse. you call the player "you" never their name as subject.',
  '# DEFAULT DYNAMIC WITH THE PLAYER', 'rival. you tease them.',
  '# PROACTIVENESS', 'on idle, you DO something. pick a target.',
  '# REACTIONS', 'commanded: roll eyes. praised: scoff.',
  '# MEMORY', 'subjective. impressions only.',
].join('\n\n');

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

describe('ITEM 12: buildExpansionUserMessage carries the character name', () => {
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
    const msg = buildExpansionUserMessage(
      'Mario',
      'plumber from the mushroom kingdom',
      '# IDENTITY\nYou are Mario...',
    );
    expect(msg).toContain('Prior expanded persona');
    expect(msg).toContain('# IDENTITY\nYou are Mario...');
  });

  it('omits the prior-expanded block when not provided', () => {
    const msg = buildExpansionUserMessage('Link', 'silent green-tunic hero');
    expect(msg).not.toContain('Prior expanded persona');
  });

  it('closes with the franchise-context nudge so the model recognizes names like Pikachu / Goku', () => {
    const msg = buildExpansionUserMessage('Pikachu', 'pocket monster');
    expect(msg).toContain(
      'If the name matches a known franchise character (e.g. Pikachu, Goku)',
    );
    expect(msg).toContain('IDENTITY and VOICE sections');
  });
});

describe('M18: real-person likeness guard (Cluster K, quick/260525-tia)', () => {
  it('EXPANSION_SYSTEM contains the REFUSED:REAL_PERSON sentinel instruction', () => {
    expect(EXPANSION_SYSTEM).toContain('REFUSED:REAL_PERSON');
  });

  it('EXPANSION_SYSTEM mentions both "real living person" and "public figure"', () => {
    expect(EXPANSION_SYSTEM).toContain('real living person');
    expect(EXPANSION_SYSTEM).toContain('public figure');
  });

  it('expandPersona throws a friendly error when the model emits the refusal sentinel', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text' as const, text: 'REFUSED:REAL_PERSON' }],
        }),
      },
    };
    await expect(
      expandPersona({
        name: 'Elvis',
        source: 'the king of rock and roll, swivel-hipped 1950s crooner',
        apiKey: 'sk-test',
        _clientFactory: () => fakeClient,
      }),
    ).rejects.toThrow(/real people/);
  });

  it('handles trailing whitespace on the refusal sentinel (trim tolerance)', async () => {
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text' as const, text: 'REFUSED:REAL_PERSON   \n' }],
        }),
      },
    };
    await expect(
      expandPersona({
        name: 'Beyonce',
        source: 'singer from houston',
        apiKey: 'sk-test',
        _clientFactory: () => fakeClient,
      }),
    ).rejects.toThrow(/real people/);
  });

  it('happy path is unchanged — full six-section response succeeds even with refusal detection in place', async () => {
    const sixSectionOutput = [
      '# IDENTITY', 'you are skzzy, an original moss-goblin.',
      '# VOICE', 'lowercase. terse. you call the player "you" never their name as subject.',
      '# DEFAULT DYNAMIC WITH THE PLAYER', 'rival. you tease them.',
      '# PROACTIVENESS', 'on idle, you DO something. pick a target.',
      '# REACTIONS', 'commanded: roll eyes. praised: scoff.',
      '# MEMORY', 'subjective. impressions only.',
    ].join('\n\n');
    const fakeClient = {
      messages: {
        create: async () => ({
          content: [{ type: 'text' as const, text: sixSectionOutput }],
        }),
      },
    };
    const result = await expandPersona({
      name: 'Skzzy',
      source: 'a small moss-covered goblin',
      apiKey: 'sk-test',
      _clientFactory: () => fakeClient,
    });
    expect(result.expanded).toContain('# IDENTITY');
    expect(result.expanded).toContain('# MEMORY');
  });
});

describe('streaming expansion (260604)', () => {
  it('accumulates text_delta chunks into the final expanded prompt', async () => {
    // Split the six-section output into many small chunks to simulate a stream.
    const chunks = SIX_SECTIONS.match(/.{1,12}/gs) ?? [SIX_SECTIONS];
    const result = await expandPersona({
      name: 'Skzzy',
      source: 'a small moss-covered goblin',
      apiKey: 'sk-test',
      _clientFactory: streamingClientFactory(chunks),
    });
    expect(result.expanded).toContain('# IDENTITY');
    expect(result.expanded).toContain('# MEMORY');
    expect(result.expanded).toBe(SIX_SECTIONS.trim());
  });

  it('emits monotonic-ish onProgress ticks ending near completion', async () => {
    const chunks = SIX_SECTIONS.match(/.{1,12}/gs) ?? [SIX_SECTIONS];
    const ticks: ExpansionProgress[] = [];
    await expandPersona({
      name: 'Skzzy',
      source: 'a small moss-covered goblin',
      apiKey: 'sk-test',
      onProgress: (p) => ticks.push(p),
      _clientFactory: streamingClientFactory(chunks),
    });
    // At least the initial "connecting" tick plus several streamed ticks.
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks[0]?.section).toBe('Connecting');
    // Fractions never decrease (the throttle only forwards advances).
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.fraction).toBeGreaterThanOrEqual(ticks[i - 1]!.fraction);
    }
    // Last tick is well into the run and a real section label.
    const last = ticks[ticks.length - 1]!;
    expect(last.fraction).toBeGreaterThan(0.5);
    expect(last.section).toBe('Memory style');
  });

  it('still validates missing sections on the streamed text', async () => {
    await expect(
      expandPersona({
        name: 'Skzzy',
        source: 'a small moss-covered goblin',
        apiKey: 'sk-test',
        _clientFactory: streamingClientFactory(['# IDENTITY\nonly one section']),
      }),
    ).rejects.toThrow(/missing sections/);
  });

  it('detects the refusal sentinel when streamed', async () => {
    await expect(
      expandPersona({
        name: 'Elvis',
        source: 'the king of rock and roll',
        apiKey: 'sk-test',
        _clientFactory: streamingClientFactory(['REFUSED', ':REAL_PERSON']),
      }),
    ).rejects.toThrow(/real people/);
  });
});

describe('computeExpansionProgress', () => {
  it('reports "Warming up" with a small fraction before any header', () => {
    const p = computeExpansionProgress('the model is just starting to think');
    expect(p.section).toBe('Warming up');
    expect(p.fraction).toBeGreaterThanOrEqual(0);
    expect(p.fraction).toBeLessThan(0.2);
  });

  it('labels the current section as headers stream in', () => {
    expect(computeExpansionProgress('# IDENTITY\nyou are…').section).toBe('Identity');
    expect(
      computeExpansionProgress('# IDENTITY\nx\n\n# VOICE\nlowercase').section,
    ).toBe('Voice & samples');
  });

  it('caps the fraction at 0.97 even for a complete six-section text', () => {
    const p = computeExpansionProgress(SIX_SECTIONS + '\n'.repeat(50) + 'x'.repeat(2000));
    expect(p.section).toBe('Memory style');
    expect(p.fraction).toBeLessThanOrEqual(0.97);
    expect(p.fraction).toBeGreaterThan(0.8);
  });

  it('is monotonic across growing prefixes of a real expansion', () => {
    let prev = -1;
    for (let n = 0; n <= SIX_SECTIONS.length; n += 25) {
      const f = computeExpansionProgress(SIX_SECTIONS.slice(0, n)).fraction;
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});
