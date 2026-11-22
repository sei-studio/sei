import { describe, expect, it, vi } from 'vitest';

vi.mock('../ipcClient', () => ({ sei: {} }));

import { chatPreviewFor } from './useChatStore';
import type { ChatMessage } from '@shared/ipc';

describe('chatPreviewFor (product call (261116): desktop lines stay desktop bubbles)', () => {
  it('skips her WorldLink desktop rows like voice rows', () => {
    const rows: ChatMessage[] = [
      { id: '1', role: 'companion', text: 'see you in chat', ts: 1 },
      { id: '2', role: 'companion', text: 'yo you found me', ts: 2, desktop: true },
      { id: '3', role: 'companion', text: 'on a call', ts: 3, voice: true },
    ];
    const s = { messages: { c: rows }, previews: {} } as unknown as Parameters<typeof chatPreviewFor>[0];
    expect(chatPreviewFor(s, 'c')).toEqual({ role: 'companion', text: 'see you in chat', ts: 1 });
  });
});




