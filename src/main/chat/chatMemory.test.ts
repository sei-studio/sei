/**
 * 261008: remember() on the chat surface. Typed chat and voice calls both
 * offer the chat-only CHAT_REMEMBER_TOOL (same schema as REMEMBER_TOOL, so
 * the dispatcher and honorRememberCalls see the same input), and the status
 * block ends with CHAT_MEMORY_CHECK only when the caller asks for it.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSystemBlocks,
  chatSurfaceTools,
  CHAT_MEMORY_CHECK,
  CHAT_REMEMBER_TOOL,
  REMEMBER_TOOL,
  END_CALL_TOOL,
  LAUNCH_TOOL,
  VOICE_CALL_TEXT_LINE,
} from './chatPrompts';
import { VOICE_CALL_PRIMER, VOICE_CALL_PRIMER_BASE, VOICE_CALL_SAY_FIRST } from '../../bot/brain/promptLibrary.js';

const WEB = [{ name: 'search' }];

function blocks(over: Record<string, unknown> = {}) {
  return buildSystemBlocks({
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
    ...over,
  } as Parameters<typeof buildSystemBlocks>[0]);
}

describe('chatSurfaceTools', () => {
  it('offers remember on typed chat, without end_call', () => {
    const names = chatSurfaceTools(false, WEB).map((t) => (t as { name: string }).name);
    expect(names).toEqual(['launch', 'quit_game', 'remember', 'search']);
    expect(chatSurfaceTools(false, WEB)).toContain(CHAT_REMEMBER_TOOL);
  });

  it('offers end_call and remember on a voice call', () => {
    const tools = chatSurfaceTools(true, WEB);
    expect(tools[0]).toBe(LAUNCH_TOOL);
    expect(tools).toContain(END_CALL_TOOL);
    expect(tools).toContain(CHAT_REMEMBER_TOOL);
    expect(tools).not.toContain(REMEMBER_TOOL);
  });
});

describe('CHAT_REMEMBER_TOOL', () => {
  it('keeps the shared remember schema and name', () => {
    expect(CHAT_REMEMBER_TOOL.name).toBe('remember');
    expect(CHAT_REMEMBER_TOOL.input_schema).toBe(REMEMBER_TOOL.input_schema);
  });

  it('does not change the tool other surfaces use', () => {
    expect(CHAT_REMEMBER_TOOL.description).not.toBe(REMEMBER_TOOL.description);
  });
});

describe('memory check in the status block', () => {
  it('ends the last block with the memory check when memoryGuide is set', () => {
    const b = blocks({ memoryGuide: true });
    expect(b[b.length - 1].text.endsWith(`\n${CHAT_MEMORY_CHECK}`)).toBe(true);
  });

  it('is absent when memoryGuide is not set', () => {
    const b = blocks();
    expect(b.some((x) => x.text.includes(CHAT_MEMORY_CHECK))).toBe(false);
  });

  it('is absent on the game surface', () => {
    const b = blocks({ surface: 'game', memoryGuide: true });
    expect(b.some((x) => x.text.includes(CHAT_MEMORY_CHECK))).toBe(false);
  });

  it('is plain text with no em-dashes', () => {
    expect(CHAT_MEMORY_CHECK).not.toMatch(/—/);
    expect(CHAT_REMEMBER_TOOL.description).not.toMatch(/—/);
  });
});

/**
 * 261010: a surface can add one line to the memory block's header. Backseat
 * uses it to say the notes are real-life facts, not things on the screen.
 */
describe('memoryNote', () => {
  const memText = (bs: Array<{ text: string }>) => bs.find((b) => b.text.includes('What you remember'))?.text ?? '';

  it('adds the note to the memory header, ahead of the notes', () => {
    const t = memText(blocks({ memory: '- Ouen has a dog called Mochi.', memoryNote: 'These are real-life facts.' }));
    expect(t).toContain('These are real-life facts.');
    expect(t.indexOf('These are real-life facts.')).toBeLessThan(t.indexOf('Mochi'));
  });

  it('leaves the header unchanged when no surface passes one', () => {
    const a = memText(blocks({ memory: '- note' }));
    const b = memText(blocks({ memory: '- note', memoryNote: '  ' }));
    expect(a).toBe(b);
    expect(a).not.toContain('undefined');
  });
});

/**
 * 261010: Backseat always speaks on a look, so it can leave the voice-call
 * primer's (silence) option out. Every other surface keeps it.
 */
describe('allowSilence', () => {
  const head = (over: Record<string, unknown>) => blocks({ voiceCall: true, ...over })[0].text as string;

  it('offers (silence) on a voice call by default', () => {
    expect(head({})).toContain('reply with exactly (silence)');
  });

  it('leaves it out when the surface says a reply is always due', () => {
    const t = head({ allowSilence: false });
    expect(t).toContain('[voice call]');
    expect(t).not.toContain('You do not have to answer every line');
    expect(t).not.toContain('reply with exactly (silence) and nothing else');
  });
});

/**
 * 261010: Backseat's reply text is the spoken line and it has no say() tool,
 * so the primer's say()-first sentence is swapped there. Everyone else keeps
 * the primer exactly as it was.
 */
describe('voiceSpeech', () => {
  const head = (over: Record<string, unknown>) => blocks({ voiceCall: true, ...over })[0].text as string;

  it('keeps the say()-first primer by default', () => {
    expect(head({})).toContain(VOICE_CALL_PRIMER);
    expect(VOICE_CALL_PRIMER).toBe(VOICE_CALL_PRIMER_BASE + VOICE_CALL_SAY_FIRST);
  });

  it('tells a text surface its text is the line, with no say()', () => {
    const t = head({ voiceSpeech: 'text' });
    expect(t).toContain(VOICE_CALL_PRIMER_BASE);
    expect(t).toContain(VOICE_CALL_TEXT_LINE);
    expect(t).not.toContain(VOICE_CALL_SAY_FIRST);
  });
});
