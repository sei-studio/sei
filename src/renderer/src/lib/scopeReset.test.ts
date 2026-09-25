/**
 * resetAccountScopedState (260926): what app:scope-changed clears in the
 * renderer so nothing one account read shows to the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = {
    sei: { onChatMessage: () => () => {} },
  };
});

describe('resetAccountScopedState', () => {
  it('clears transcripts, avatar manifests, bot logs, deleted ids, feedback drafts and a pending first moment', async () => {
    const { useChatStore } = await import('./stores/useChatStore');
    const { useAvatarStore } = await import('./stores/useAvatarStore');
    const { useDataStore } = await import('./stores/useDataStore');
    const drafts = await import('./feedbackDraft');
    const { resetAccountScopedState } = await import('./scopeReset');

    useChatStore.setState({
      messages: { sui: [{ id: 'm1', role: 'user', text: 'private', ts: 0 }] },
      loaded: { sui: true },
    });
    useAvatarStore.getState().setManifest('sui', { name: 'model' } as never);
    useDataStore.setState({
      logs: [{ line: 'sui said private' } as never],
      recentlyDeletedIds: new Set(['sui']),
    });
    drafts.setFeedbackDraft('bug', 'my unsent words');
    const { useFirstMomentStore } = await import('./stores/useFirstMomentStore');
    useFirstMomentStore.getState().arm('sui');

    resetAccountScopedState();

    expect(useChatStore.getState().messages).toEqual({});
    expect(useChatStore.getState().loaded).toEqual({});
    expect(useAvatarStore.getState().manifests).toEqual({});
    expect(useDataStore.getState().logs).toEqual([]);
    expect(useDataStore.getState().recentlyDeletedIds.size).toBe(0);
    expect(drafts.getFeedbackDraft('bug')).toBe('');
    expect(useFirstMomentStore.getState().status).toBeNull();
  });

  it('an avatar fetch begun for the old account does not land after the reset', async () => {
    let release: (m: unknown) => void = () => {};
    const w = globalThis as unknown as { window: { sei: Record<string, unknown> } };
    w.window.sei.avatarGet = vi.fn(() => new Promise((r) => (release = r)));
    const { useAvatarStore } = await import('./stores/useAvatarStore');
    const { resetAccountScopedState } = await import('./scopeReset');
    useAvatarStore.getState().ensure('sui');
    resetAccountScopedState();
    release({ name: 'account-a-model' });
    await new Promise((r) => setTimeout(r, 0));
    expect(useAvatarStore.getState().manifests).toEqual({});
  });
});
