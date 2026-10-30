/**
 * Facepack pilot (261028): leading [expression] tags on chat/voice lines are
 * read before stripAudioTags removes them, never reach a bubble, and the
 * FACE prompt block appears only when asked for.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./sdk', () => ({
  buildChatSdk: vi.fn(async () => ({ client: { messages: { create: vi.fn() } }, model: 'test-model' })),
}));

import { splitReply, splitReplyParts } from './chatService';
import { buildSystemBlocks } from './chatPrompts';
import { FACE_PROMPT } from '../../bot/brain/faceExpressions.js';

describe('splitReplyParts', () => {
  it('its text is exactly splitReply', () => {
    const samples = [
      '[happy] oh hey.\nwhat are you up to',
      'plain line.',
      '[smirk] told you\n[pout]',
      '[leans in] psst. [sad] i lost',
      '[happy]',
      'one... two.\n\n[excited] three!',
    ];
    for (const s of samples) {
      for (const spoken of [false, true]) {
        expect(splitReplyParts(s, 'casual', spoken).map((p) => p.text)).toEqual(splitReply(s, 'casual', spoken));
      }
    }
  });

  it('strips the tag and keeps it as the lead cue', () => {
    expect(splitReplyParts('[happy] oh hey.\nwhat are you up to')).toEqual([
      { text: 'oh hey', face: { lead: 'happy', trail: null } },
      { text: 'what are you up to', face: null },
    ]);
  });

  it('resolves aliases', () => {
    expect(splitReplyParts('[smirk] told you')[0]).toEqual({ text: 'told you', face: { lead: 'smug', trail: null } });
  });

  it('an unknown tag is stripped and changes nothing', () => {
    expect(splitReplyParts('[leans in] psst')).toEqual([{ text: 'psst', face: null }]);
  });

  it('a tag-only line carries to the next bubble', () => {
    expect(splitReplyParts('[thinking]\nhmm let me see')).toEqual([
      { text: 'hmm let me see', face: { lead: 'thinking', trail: null } },
    ]);
  });

  it('a tag-only last line becomes the previous bubble\'s trail', () => {
    expect(splitReplyParts('fine whatever\n[pout]')).toEqual([
      { text: 'fine whatever', face: { lead: null, trail: 'pout' } },
    ]);
  });

  it('a tag after words is the trail', () => {
    expect(splitReplyParts('fine [pout]')).toEqual([{ text: 'fine', face: { lead: null, trail: 'pout' } }]);
  });

  it('no tags means no faces', () => {
    expect(splitReplyParts('hi\nthere').every((p) => p.face === null)).toBe(true);
  });
});

describe('FACE prompt block', () => {
  const base = {
    persona: { source: 'A cheerful friend.', expanded: '' },
    name: 'Sui',
    preferredName: 'Ouen',
    proactiveness: 1,
    punctuation: 'casual',
    memory: '',
    summary: '',
    knowledge: '',
    openWorldDetected: false,
    inGame: false,
  } as Parameters<typeof buildSystemBlocks>[0];
  const text = (b: ReturnType<typeof buildSystemBlocks>) => JSON.stringify(b);

  it('is absent by default and identical to faceGuide:false', () => {
    const off = buildSystemBlocks(base);
    expect(text(off)).not.toContain('# FACE');
    expect(text(buildSystemBlocks({ ...base, faceGuide: false }))).toBe(text(off));
  });

  it('is present with faceGuide:true', () => {
    const on = text(buildSystemBlocks({ ...base, faceGuide: true }));
    expect(on).toContain(JSON.stringify(FACE_PROMPT).slice(1, -1));
  });
});
