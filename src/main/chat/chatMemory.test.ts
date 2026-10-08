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
} from './chatPrompts';

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
