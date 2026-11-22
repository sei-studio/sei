/**
 * ChatgptPlanHost (261017, issue #46, review round 2): the welcome waits for
 * ChatGPT to be the backend actually in use, and the latched AUTH_REJECTED /
 * REQUEST_REJECTED answers open their own dialogs. Rendered with
 * react-dom/server against seeded stand-ins for the two stores (SSR reads a
 * zustand store's INITIAL state, as in SeiProfileModals.test.tsx).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatgptStatus } from '@shared/chatgptPlan';

vi.mock('../lib/ipcClient', () => ({ sei: { platform: 'darwin' } }));

const chat: Record<string, unknown> = {};
const ui: Record<string, unknown> = {};
vi.mock('../lib/stores/useChatgptStore', async (orig) => {
  const real = await orig<typeof import('../lib/stores/useChatgptStore')>();
  Object.assign(chat, real.useChatgptStore.getState());
  return { ...real, useChatgptStore: Object.assign((sel: (s: typeof chat) => unknown) => sel(chat), { getState: () => chat }) };
});
vi.mock('../lib/stores/useUiStore', async (orig) => {
  const real = await orig<typeof import('../lib/stores/useUiStore')>();
  Object.assign(ui, real.useUiStore.getState());
  return { ...real, useUiStore: Object.assign((sel: (s: typeof ui) => unknown) => sel(ui), { getState: () => ui }) };
});

const { ChatgptPlanHost } = await import('./ChatgptPlanHost');

function status(over: Partial<ChatgptStatus> = {}): ChatgptStatus {
  return {
    accounts: [{ id: 'a1', email: 'p@example.com', label: 'p@example.com', signedIn: true, planEnabled: true }],
    activeId: 'a1',
    signingIn: false,
    usageLimited: false,
    blockedCode: null,
    welcomeSeen: false,
    models: [],
    ...over,
  };
}

function render(s: ChatgptStatus, opts: { llmProvider?: string | null; blockDialog?: string | null } = {}): string {
  Object.assign(chat, { status: s, limitDialog: false, blockDialog: opts.blockDialog ?? null });
  ui.llmProvider = opts.llmProvider ?? null;
  return renderToStaticMarkup(React.createElement(ChatgptPlanHost));
}

describe('ChatgptPlanHost', () => {
  it('holds the welcome while the cloud plan is still the backend (switch not confirmed)', () => {
    expect(render(status(), { llmProvider: null })).not.toContain("using your ChatGPT plan");
  });

  it('shows the welcome once ChatGPT is the backend in use', () => {
    expect(render(status(), { llmProvider: 'chatgpt' })).toContain("using your ChatGPT plan");
    expect(render(status({ welcomeSeen: true }), { llmProvider: 'chatgpt' })).toBe('');
  });

  it('a rejected sign-in opens the re-sign-in dialog with the ChatGPT button', () => {
    const html = render(status({ blockedCode: 'CHATGPT_AUTH_REJECTED', welcomeSeen: true }), {
      llmProvider: 'chatgpt',
      blockDialog: 'CHATGPT_AUTH_REJECTED',
    });
    expect(html).toContain('Sign in to ChatGPT again');
    expect(html).toContain('Continue with ChatGPT');
  });

  it('a rejected request opens its own dialog with Try again', () => {
    const html = render(status({ blockedCode: 'CHATGPT_REQUEST_REJECTED', welcomeSeen: true }), {
      llmProvider: 'chatgpt',
      blockDialog: 'CHATGPT_REQUEST_REJECTED',
    });
    expect(html).toContain('ChatGPT rejected the request');
    expect(html).toContain('Try again');
  });
});




