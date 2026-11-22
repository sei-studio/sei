/**
 * useChatgptStore (261017, issue #46, review round 2): a latched
 * AUTH_REJECTED / REQUEST_REJECTED opens its dialog once, on the transition,
 * and the dialog closes when main lifts the latch.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatgptStatus } from '@shared/chatgptPlan';

let push: ((s: ChatgptStatus) => void) | null = null;
vi.mock('../ipcClient', () => ({
  sei: {
    onChatgptStatus: (fn: (s: ChatgptStatus) => void) => {
      push = fn;
      return () => {
        push = null;
      };
    },
    chatgptStatus: async () => null,
  },
}));

const { useChatgptStore } = await import('./useChatgptStore');

const base: ChatgptStatus = {
  accounts: [{ id: 'a1', email: null, label: 'ChatGPT account', signedIn: true, planEnabled: true }],
  activeId: 'a1',
  signingIn: false,
  usageLimited: false,
  blockedCode: null,
  welcomeSeen: true,
  models: [],
};

describe('useChatgptStore block dialog', () => {
  it('opens on the transition into AUTH_REJECTED, stays dismissed, closes when the latch lifts', () => {
    const off = useChatgptStore.getState().subscribe();
    push!(base);
    expect(useChatgptStore.getState().blockDialog).toBeNull();
    push!({ ...base, blockedCode: 'CHATGPT_AUTH_REJECTED' });
    expect(useChatgptStore.getState().blockDialog).toBe('CHATGPT_AUTH_REJECTED');
    useChatgptStore.getState().closeBlockDialog();
    push!({ ...base, blockedCode: 'CHATGPT_AUTH_REJECTED' });
    expect(useChatgptStore.getState().blockDialog).toBeNull();
    push!({ ...base, blockedCode: 'CHATGPT_REQUEST_REJECTED' });
    expect(useChatgptStore.getState().blockDialog).toBe('CHATGPT_REQUEST_REJECTED');
    push!(base);
    expect(useChatgptStore.getState().blockDialog).toBeNull();
    off();
  });

  it('openBlockDialog reopens a closed dialog for a dialog code only', () => {
    useChatgptStore.getState().closeBlockDialog();
    useChatgptStore.getState().openBlockDialog('CHATGPT_FORBIDDEN');
    expect(useChatgptStore.getState().blockDialog).toBeNull();
    useChatgptStore.getState().openBlockDialog('CHATGPT_AUTH_REJECTED');
    expect(useChatgptStore.getState().blockDialog).toBe('CHATGPT_AUTH_REJECTED');
    useChatgptStore.getState().closeBlockDialog();
  });

  it('NOT_ELIGIBLE / FORBIDDEN keep using the error copy, no dialog', () => {
    const off = useChatgptStore.getState().subscribe();
    push!({ ...base, blockedCode: 'CHATGPT_FORBIDDEN' });
    expect(useChatgptStore.getState().blockDialog).toBeNull();
    off();
  });
});




