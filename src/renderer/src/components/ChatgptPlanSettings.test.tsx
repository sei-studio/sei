/**
 * ChatgptPlanSettings (261017, issue #46, review round 3): a latched plan
 * answer shows the action that lifts it, since the dialog that first showed
 * it may be closed. Seeded store stand-in, SSR render (as in
 * ChatgptPlanHost.test.tsx).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatgptStatus } from '@shared/chatgptPlan';

vi.mock('../lib/ipcClient', () => ({ sei: { platform: 'darwin' } }));

const chat: Record<string, unknown> = {};
vi.mock('../lib/stores/useChatgptStore', async (orig) => {
  const real = await orig<typeof import('../lib/stores/useChatgptStore')>();
  Object.assign(chat, real.useChatgptStore.getState());
  return { ...real, useChatgptStore: Object.assign((sel: (s: typeof chat) => unknown) => sel(chat), { getState: () => chat }) };
});

const { ChatgptPlanSettings } = await import('./ChatgptPlanSettings');

function render(blockedCode: string | null): string {
  const status: ChatgptStatus = {
    accounts: [{ id: 'a1', email: 'p@example.com', label: 'p@example.com', signedIn: true, planEnabled: true }],
    activeId: 'a1',
    signingIn: false,
    usageLimited: false,
    blockedCode,
    welcomeSeen: true,
    models: [],
  };
  Object.assign(chat, { status, signInError: null, signOutUnconfirmed: false });
  return renderToStaticMarkup(React.createElement(ChatgptPlanSettings, { active: true, onUsePlan: () => {} }));
}

describe('ChatgptPlanSettings blocked notice', () => {
  it('AUTH_REJECTED offers Continue with ChatGPT (a new sign-in)', () => {
    const html = render('CHATGPT_AUTH_REJECTED');
    expect(html).toContain('Sign in again to keep using your plan');
    expect(html).toContain('Continue with ChatGPT');
  });

  it('REQUEST_REJECTED offers Try again', () => {
    const html = render('CHATGPT_REQUEST_REJECTED');
    expect(html).toContain("last request, so ChatGPT requests are paused");
    expect(html).toContain('Try again');
  });

  it('FORBIDDEN reads as a region or plan restriction, with Try again', () => {
    const html = render('CHATGPT_FORBIDDEN');
    expect(html).toContain('region');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Continue with ChatGPT');
  });

  it('nothing latched: no notice', () => {
    expect(render(null)).not.toContain('Try again');
  });
});




