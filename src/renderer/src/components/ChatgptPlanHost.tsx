/**
 * ChatgptPlanHost — the app-wide ChatGPT-plan dialogs (261017, issue #46).
 * Mounted once in App.tsx; subscribes the store to main's status push.
 *
 * Two dialogs from OpenAI's UI guidelines:
 * - the one-time welcome, "You're using your ChatGPT plan", shown after the
 *   first successful plan sign-in (welcomeSeen is persisted in main), with a
 *   single "Got it";
 * - "Usage limit reached", opened when a request comes back limited. Manage
 *   usage (chatgpt.com/settings/usage) is the primary action. Main pauses
 *   plan requests while the limit stands (no retry storm); Try again lifts
 *   the pause for one attempt.
 *
 * Plus two of Sei's own, for answers main latches so they are not retried
 * every turn: "Sign in to ChatGPT again" (a 401 even after a fresh token)
 * and "ChatGPT rejected the request" (a 400 on Sei's request format).
 *
 * 261023: after "Continue with ChatGPT" as an ACCOUNT sign-in (or Settings'
 * Link ChatGPT) granted plan usage, main holds a one-shot plan offer. The host
 * takes it on a calm screen (Home, Settings or Playtime, no tour running) and routes to
 * Playtime's ChatGPT tab with view.useChatgptPlan, which runs the switch path: the
 * cloud -> local confirm when Sei credits are in use (the user can say no),
 * or just the provider pick on the local backend. Nothing switches silently
 * away from Sei credits.
 *
 * The welcome waits until ChatGPT is the backend actually in use (the main
 * push behind useUiStore.llmProvider), so it never claims "You're using your
 * ChatGPT plan" while the cloud plan is still selected or the switch failed.
 */
import React, { useEffect } from 'react';
import { CHATGPT_USAGE_URL } from '@shared/chatgptPlan';
import { useT } from '../lib/i18n';
import { sei } from '../lib/ipcClient';
import { chatgptReady, useChatgptStore } from '../lib/stores/useChatgptStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useTutorialStore } from '../lib/stores/useTutorialStore';
import { Button } from './Button';
import { ChatgptLogo } from './ChatgptLogo';
import { ContinueWithChatGPTButton } from './ContinueWithChatGPTButton';
import { ModalFooter, ModalShell } from './ModalShell';
import styles from './ChatgptPlanHost.module.css';

export function ChatgptPlanHost(): React.ReactElement | null {
  const t = useT();
  const status = useChatgptStore((s) => s.status);
  const limitDialog = useChatgptStore((s) => s.limitDialog);
  const dismissWelcome = useChatgptStore((s) => s.dismissWelcome);
  const clearLimit = useChatgptStore((s) => s.clearLimit);
  const closeLimitDialog = useChatgptStore((s) => s.closeLimitDialog);
  const blockDialog = useChatgptStore((s) => s.blockDialog);
  const closeBlockDialog = useChatgptStore((s) => s.closeBlockDialog);
  const signIn = useChatgptStore((s) => s.signIn);
  const llmProvider = useUiStore((s) => s.llmProvider);
  const viewKind = useUiStore((s) => s.view.kind);
  const signedIn = useAuthStore((s) => s.state.kind === 'signed_in');
  const tourActive = useTutorialStore((s) => s.active);
  const ready = chatgptReady(status);

  useEffect(() => {
    const store = useChatgptStore.getState();
    const off = store.subscribe();
    void store.load();
    return off;
  }, []);

  // Plan offer after a ChatGPT account sign-in (see header).
  useEffect(() => {
    if (!signedIn || !ready || tourActive) return;
    if (viewKind !== 'home' && viewKind !== 'settings' && viewKind !== 'credits') return;
    // No cleanup-cancel: the offer is one-shot in main, so a re-run of this
    // effect while the answer is in flight must not drop it.
    void sei
      .takeChatgptPlanOffer()
      .then((offer) => {
        if (!offer) return;
        if (useUiStore.getState().llmProvider === 'chatgpt') return;
        useUiStore.getState().navigate({ kind: 'credits', tab: 'chatgpt', useChatgptPlan: true });
      })
      .catch(() => undefined);
  }, [signedIn, ready, tourActive, viewKind, status?.activeId]);

  if (limitDialog && status?.usageLimited) {
    return (
      <ModalShell title={t('Usage limit reached')} width={420} onClose={closeLimitDialog} tier="stacked">
        <p className={styles.body}>
          {t(
            "You've used the ChatGPT plan usage available to Sei for now. Check Manage usage to see when it resets. Sei pauses ChatGPT requests until then.",
          )}
        </p>
        <ModalFooter>
          <Button kind="quiet" onClick={() => void clearLimit()}>
            {t('Try again')}
          </Button>
          <Button kind="primary" onClick={() => void sei.openExternal(CHATGPT_USAGE_URL)}>
            {t('Manage usage')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  if (blockDialog === 'CHATGPT_AUTH_REJECTED' && status?.blockedCode === blockDialog) {
    const signingIn = status.signingIn;
    return (
      <ModalShell title={t('Sign in to ChatGPT again')} width={420} onClose={closeBlockDialog} tier="stacked">
        <p className={styles.body}>
          {t(
            "ChatGPT didn't accept Sei's sign-in, even after renewing it. Sign in again to keep using your ChatGPT plan, or pick another AI option in Playtime.",
          )}
        </p>
        <ModalFooter>
          <Button kind="quiet" onClick={closeBlockDialog}>
            {t('Cancel')}
          </Button>
          <ContinueWithChatGPTButton
            disabled={signingIn}
            busy={signingIn}
            onClick={() => {
              void signIn({ accountId: status.activeId }).then((r) => {
                if (r?.ok) closeBlockDialog();
              });
            }}
          />
        </ModalFooter>
      </ModalShell>
    );
  }

  if (blockDialog === 'CHATGPT_REQUEST_REJECTED' && status?.blockedCode === blockDialog) {
    return (
      <ModalShell title={t('ChatGPT rejected the request')} width={420} onClose={closeBlockDialog} tier="stacked">
        <p className={styles.body}>
          {t(
            "ChatGPT didn't accept the request Sei sent, so your companion stopped instead of retrying. Try again, or pick another AI option in Playtime.",
          )}
        </p>
        <ModalFooter>
          <Button kind="quiet" onClick={closeBlockDialog}>
            {t('Close')}
          </Button>
          <Button kind="primary" onClick={() => void clearLimit()}>
            {t('Try again')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  if (status && llmProvider === 'chatgpt' && chatgptReady(status) && !status.welcomeSeen) {
    return (
      <ModalShell title={null} width={400} escClose={false} tier="stacked" aria-label={t("You're using your ChatGPT plan")}>
        <div className={styles.welcomeHead}>
          <ChatgptLogo size={28} />
          <h3 className={styles.welcomeTitle}>{t("You're using your ChatGPT plan")}</h3>
        </div>
        <p className={styles.body}>
          {t(
            'Your companions now run on your ChatGPT plan. Eligible requests count toward your plan usage or credits balance, not Sei credits.',
          )}
        </p>
        <ModalFooter>
          <Button kind="primary" onClick={() => void dismissWelcome()}>
            {t('Got it')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  return null;
}
