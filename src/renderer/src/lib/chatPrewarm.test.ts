import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatPrewarm = vi.fn(async () => {});
vi.mock('./ipcClient', () => ({ sei: { chatPrewarm: () => chatPrewarm() } }));

import { noteComposerTyping, _resetComposerTyping, CHAT_PREWARM_IPC_INTERVAL_MS } from './chatPrewarm';

describe('noteComposerTyping (261125)', () => {
  beforeEach(() => {
    _resetComposerTyping();
    chatPrewarm.mockClear();
  });

  it('asks main once per interval while text is being typed', () => {
    expect(noteComposerTyping('h', 10_000)).toBe(true);
    expect(noteComposerTyping('he', 10_000 + 200)).toBe(false);
    expect(noteComposerTyping('hey', 10_000 + CHAT_PREWARM_IPC_INTERVAL_MS)).toBe(true);
    expect(chatPrewarm).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty or whitespace draft (cleared composer)', () => {
    expect(noteComposerTyping('', 10_000)).toBe(false);
    expect(noteComposerTyping('   ', 20_000)).toBe(false);
    expect(chatPrewarm).not.toHaveBeenCalled();
  });
});
