/**
 * Startup popup actions, renderer side (261029): the chatgpt-plan action
 * mirrors what the ChatGPT row in Settings offers, and an unknown name does
 * nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatgptSignInResult, ChatgptStatus } from '@shared/chatgptPlan';

const h = vi.hoisted(() => ({
  status: null as ChatgptStatus | null,
  signInCalls: [] as unknown[],
  signInResult: null as ChatgptSignInResult | null,
}));

vi.mock('./ipcClient', () => ({
  sei: {
    chatgptStatus: async () => h.status,
    onChatgptStatus: () => () => undefined,
    chatgptSignIn: async (opts: unknown) => {
      h.signInCalls.push(opts);
      return h.signInResult;
    },
  },
}));

const { planChatgptPlanAction, runPopupAction, _resetPopupActionLatch, POPUP_ACTION_LATCH_MS } = await import(
  './popupActions'
);
const { useChatgptStore } = await import('./stores/useChatgptStore');
const { useUiStore } = await import('./stores/useUiStore');

const acct = (signedIn: boolean, planEnabled: boolean) => ({
  id: 'a1',
  email: null,
  label: 'ChatGPT account',
  signedIn,
  planEnabled,
});
const status = (over: Partial<ChatgptStatus> = {}): ChatgptStatus => ({
  accounts: [],
  activeId: null,
  signingIn: false,
  usageLimited: false,
  blockedCode: null,
  welcomeSeen: true,
  models: [],
  ...over,
});
const ready = status({ accounts: [acct(true, true)], activeId: 'a1' });

describe('planChatgptPlanAction', () => {
  it('starts the sign-in when no ChatGPT account is connected', () => {
    expect(planChatgptPlanAction(status(), null)).toEqual({ kind: 'sign-in' });
    expect(planChatgptPlanAction(null, 'anthropic')).toEqual({ kind: 'sign-in' });
  });

  it('a signed-in plan not in use runs the switch (with its confirm), never a second sign-in', () => {
    expect(planChatgptPlanAction(ready, null)).toEqual({ kind: 'switch' });
    expect(planChatgptPlanAction(ready, 'anthropic')).toEqual({ kind: 'switch' });
  });

  it('already using the plan: only show the row', () => {
    expect(planChatgptPlanAction(ready, 'chatgpt')).toEqual({ kind: 'show' });
  });

  it('signed in with plan use declined, plan not picked: sign in again ASKING for plan use', () => {
    // A plain sign-in re-approves the same scopes and leaves the plan off.
    const declined = status({ accounts: [acct(true, false)], activeId: 'a1' });
    expect(planChatgptPlanAction(declined, null)).toEqual({ kind: 'sign-in', opts: { accountId: 'a1', enablePlan: true } });
    expect(planChatgptPlanAction(declined, 'anthropic')).toEqual({
      kind: 'sign-in',
      opts: { accountId: 'a1', enablePlan: true },
    });
  });

  it('a sign-in already running: only show the row', () => {
    expect(planChatgptPlanAction(status({ signingIn: true }), null)).toEqual({ kind: 'show' });
  });

  it('plan picked but the account cannot run: re-sign that account', () => {
    expect(planChatgptPlanAction(status(), 'chatgpt')).toEqual({ kind: 'sign-in' });
    expect(
      planChatgptPlanAction(status({ accounts: [acct(false, true)], activeId: 'a1' }), 'chatgpt'),
    ).toEqual({ kind: 'sign-in', opts: { accountId: 'a1' } });
    expect(
      planChatgptPlanAction(status({ accounts: [acct(true, false)], activeId: 'a1' }), 'chatgpt'),
    ).toEqual({ kind: 'sign-in', opts: { accountId: 'a1', enablePlan: true } });
  });
});

describe('runPopupAction', () => {
  beforeEach(() => {
    _resetPopupActionLatch();
    h.status = null;
    h.signInCalls = [];
    h.signInResult = null;
    useChatgptStore.setState({ status: null });
    useUiStore.setState({ view: { kind: 'home' }, llmProvider: null });
  });

  it('ignores an unknown name: no navigation, no sign-in', async () => {
    for (const name of ['nope', '', 'CHATGPT-PLAN', null, 42, { kind: 'chatgpt-plan' }]) {
      expect(await runPopupAction(name)).toBe(false);
    }
    expect(useUiStore.getState().view).toEqual({ kind: 'home' });
    expect(h.signInCalls).toEqual([]);
  });

  it('chatgpt-plan, not connected: Settings at the row, starts the sign-in, then the switch', async () => {
    h.status = status();
    h.signInResult = { ok: true, status: ready, planEnabled: true };
    expect(await runPopupAction('chatgpt-plan')).toBe(true);
    expect(h.signInCalls).toEqual([undefined]);
    expect(useUiStore.getState().view).toEqual({ kind: 'settings', useChatgptPlan: true });
  });

  it('chatgpt-plan, sign-in cancelled: stays on the row, no switch', async () => {
    h.status = status();
    h.signInResult = { ok: false, reason: 'cancelled' };
    await runPopupAction('chatgpt-plan');
    expect(h.signInCalls).toHaveLength(1);
    expect(useUiStore.getState().view).toEqual({ kind: 'settings', focus: 'chatgpt-plan' });
  });

  it('chatgpt-plan, already signed in: the switch, no sign-in', async () => {
    h.status = ready;
    await runPopupAction('chatgpt-plan');
    expect(h.signInCalls).toEqual([]);
    expect(useUiStore.getState().view).toEqual({ kind: 'settings', focus: 'chatgpt-plan', useChatgptPlan: true });
  });

  it('chatgpt-plan, already using it: just shows the row', async () => {
    h.status = ready;
    useUiStore.setState({ llmProvider: 'chatgpt' });
    await runPopupAction('chatgpt-plan');
    expect(h.signInCalls).toEqual([]);
    expect(useUiStore.getState().view).toEqual({ kind: 'settings', focus: 'chatgpt-plan' });
  });

  it('chatgpt-plan, plan use declined again: no switch intent is left behind', async () => {
    const declined = status({ accounts: [acct(true, false)], activeId: 'a1' });
    h.status = declined;
    h.signInResult = { ok: true, status: declined, planEnabled: false };
    await runPopupAction('chatgpt-plan');
    expect(h.signInCalls).toEqual([{ accountId: 'a1', enablePlan: true }]);
    expect(useUiStore.getState().view).toEqual({ kind: 'settings', focus: 'chatgpt-plan' });
  });

  it('a double click starts ONE sign-in: the second action is ignored while the first runs', async () => {
    h.status = status();
    let finish: (r: ChatgptSignInResult) => void = () => undefined;
    const origSignIn = useChatgptStore.getState().signIn;
    let calls = 0;
    useChatgptStore.setState({
      signIn: () => {
        calls += 1;
        return new Promise((r) => (finish = r));
      },
    });
    try {
      const first = runPopupAction('chatgpt-plan');
      // The second click lands before main has pushed signingIn: true.
      expect(await runPopupAction('chatgpt-plan')).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      finish({ ok: false, reason: 'cancelled' });
      await first;
      expect(calls).toBe(1);
      // Settled: the latch is free again.
      const again = runPopupAction('chatgpt-plan');
      await new Promise((r) => setTimeout(r, 0));
      finish({ ok: false, reason: 'cancelled' });
      await again;
      expect(calls).toBe(2);
    } finally {
      useChatgptStore.setState({ signIn: origSignIn });
    }
  });

  it('a sign-in that never settles frees the latch after POPUP_ACTION_LATCH_MS', async () => {
    vi.useFakeTimers();
    h.status = status();
    const origSignIn = useChatgptStore.getState().signIn;
    let calls = 0;
    useChatgptStore.setState({
      signIn: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
    });
    try {
      void runPopupAction('chatgpt-plan');
      await vi.advanceTimersByTimeAsync(0);
      void runPopupAction('chatgpt-plan');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(POPUP_ACTION_LATCH_MS);
      void runPopupAction('chatgpt-plan');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
    } finally {
      useChatgptStore.setState({ signIn: origSignIn });
      vi.useRealTimers();
    }
  });

  it('does not switch a player who left Settings during the browser step', async () => {
    h.status = status();
    h.signInResult = { ok: true, status: ready, planEnabled: true };
    const origSignIn = useChatgptStore.getState().signIn;
    useChatgptStore.setState({
      signIn: async (opts) => {
        useUiStore.setState({ view: { kind: 'home' } });
        return origSignIn(opts);
      },
    });
    try {
      await runPopupAction('chatgpt-plan');
    } finally {
      useChatgptStore.setState({ signIn: origSignIn });
    }
    expect(useUiStore.getState().view).toEqual({ kind: 'home' });
  });
});
