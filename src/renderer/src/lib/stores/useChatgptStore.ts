/**
 * useChatgptStore â€” the renderer's view of the ChatGPT-plan sign-in
 * ("Continue with ChatGPT", 261017, issue #46).
 *
 * Main owns the OAuth session and every token (src/main/chatgptPlan); this
 * store holds only the account summaries main reports, kept current by the
 * chatgpt:status-changed push. Account scoped like the chat store: the
 * accounts file lives in the profile, so resetAccountScopedState calls
 * reset(), which drops the old account's view and reloads.
 *
 * Two pieces of UI state live here because more than one surface reads them:
 * `limitDialog` (the "Usage limit reached" dialog App.tsx renders when a
 * request comes back limited), and `signOutUnconfirmed` (Settings shows the
 * "disconnect Sei in ChatGPT settings" notice when revocation could not be
 * confirmed), and `blockDialog` (the re-sign-in / rejected-request dialog,
 * opened when main latches CHATGPT_AUTH_REJECTED or CHATGPT_REQUEST_REJECTED).
 */
import { create } from 'zustand';
import type { ChatgptSignInFailure, ChatgptSignInResult, ChatgptStatus } from '@shared/chatgptPlan';
import { sei } from '../ipcClient';

interface ChatgptState {
  status: ChatgptStatus | null;
  /** The last sign-in attempt's failure, for the inline error line. */
  signInError: ChatgptSignInFailure | null;
  /** The last sign-out could not confirm remote revocation. */
  signOutUnconfirmed: boolean;
  /** The usage-limit dialog is open (opened when a latch turns on). */
  limitDialog: boolean;
  /** The latched code whose dialog is open (see DIALOG_BLOCKS), or null. */
  blockDialog: string | null;
  epoch: number;
  load: () => Promise<void>;
  /** Wire the main push once (App.tsx). Returns the unsubscribe. */
  subscribe: () => () => void;
  signIn: (opts?: { accountId?: string | null; enablePlan?: boolean }) => Promise<ChatgptSignInResult | null>;
  cancelSignIn: () => void;
  signOut: (accountId?: string) => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  dismissWelcome: () => Promise<void>;
  clearLimit: () => Promise<void>;
  closeLimitDialog: () => void;
  closeBlockDialog: () => void;
  /** Reopen a latched code's dialog (a chat turn just failed on it). */
  openBlockDialog: (code: string) => void;
  reset: () => void;
}

/** True when a status says plan requests can be made right now. */
export function chatgptReady(s: ChatgptStatus | null): boolean {
  const a = s?.accounts.find((x) => x.id === s.activeId);
  return !!a && a.signedIn && a.planEnabled;
}

/** Latched codes that open a dialog of their own (ChatgptPlanHost). */
export const DIALOG_BLOCKS: ReadonlySet<string> = new Set(['CHATGPT_AUTH_REJECTED', 'CHATGPT_REQUEST_REJECTED']);

export const useChatgptStore = create<ChatgptState>((set, get) => {
  const apply = (next: ChatgptStatus): void => {
    const prev = get().status;
    // Open the dialog on the transition into a paused plan, not on every push
    // while it stays paused (a dismissed dialog stays dismissed).
    const opened = next.usageLimited && !prev?.usageLimited;
    const block = next.blockedCode && DIALOG_BLOCKS.has(next.blockedCode) ? next.blockedCode : null;
    const blockOpened = !!block && block !== prev?.blockedCode;
    set({
      status: next,
      ...(opened ? { limitDialog: true } : {}),
      ...(next.usageLimited ? {} : { limitDialog: false }),
      ...(blockOpened ? { blockDialog: block } : {}),
      ...(block ? {} : { blockDialog: null }),
    });
  };
  return {
    status: null,
    signInError: null,
    signOutUnconfirmed: false,
    limitDialog: false,
    blockDialog: null,
    epoch: 0,
    load: async () => {
      const epoch = get().epoch;
      try {
        const s = await sei.chatgptStatus();
        if (get().epoch === epoch && s) apply(s);
      } catch {
        /* main unreachable: keep what we have */
      }
    },
    subscribe: () => sei.onChatgptStatus((s) => apply(s)),
    signIn: async (opts) => {
      set({ signInError: null, signOutUnconfirmed: false });
      try {
        const r = await sei.chatgptSignIn(opts);
        if (r.ok) apply(r.status);
        else set({ signInError: r.reason });
        return r;
      } catch {
        set({ signInError: 'network' });
        return null;
      }
    },
    cancelSignIn: () => {
      void sei.chatgptCancelSignIn().catch(() => {});
    },
    signOut: async (accountId) => {
      try {
        const r = await sei.chatgptSignOut(accountId);
        apply(r.status);
        set({ signOutUnconfirmed: !r.revoked });
      } catch {
        set({ signOutUnconfirmed: true });
      }
    },
    switchAccount: async (accountId) => {
      try {
        apply(await sei.chatgptSwitchAccount(accountId));
      } catch {
        /* status push will correct */
      }
    },
    dismissWelcome: async () => {
      try {
        apply(await sei.chatgptDismissWelcome());
      } catch {
        /* shown again next time: harmless */
      }
    },
    clearLimit: async () => {
      set({ limitDialog: false, blockDialog: null });
      try {
        apply(await sei.chatgptClearLimit());
      } catch {
        /* keep the pause */
      }
    },
    closeLimitDialog: () => set({ limitDialog: false }),
    closeBlockDialog: () => set({ blockDialog: null }),
    openBlockDialog: (code) => {
      if (DIALOG_BLOCKS.has(code)) set({ blockDialog: code });
    },
    reset: () => {
      set((s) => ({
        status: null,
        signInError: null,
        signOutUnconfirmed: false,
        limitDialog: false,
        blockDialog: null,
        epoch: s.epoch + 1,
      }));
      void get().load();
    },
  };
});




