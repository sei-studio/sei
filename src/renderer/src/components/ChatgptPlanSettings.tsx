/**
 * ChatgptPlanSettings — the ChatGPT plan rows in Settings → AI (261017,
 * issue #46). Two shapes:
 *
 * - `active` (the picked provider is the ChatGPT plan): the account picker
 *   (every saved registration, the active one marked, add another), sign out,
 *   the "Using ChatGPT plan" line with Manage usage, the paused-plan notice,
 *   and the enable path for a sign-in that did not grant plan usage.
 * - otherwise (another local provider, or the cloud backend): ONE settings
 *   row, "Use your ChatGPT plan" (the card title from OpenAI's UI
 *   guidelines) with the Continue with ChatGPT button, or "Use ChatGPT plan"
 *   once an account is signed in. 261023 (Shawn: "a lot of text ... i'd
 *   rather have a clean signin to chatgpt button"): the card's two-sentence
 *   body moved into the row's info tip. It still says what OpenAI asks for
 *   (the guideline body copy, every Sei plan including Free, and that usage
 *   counts toward the ChatGPT plan, not Sei's subscription or credits), one
 *   hover away instead of on the page. The button label stays "Continue
 *   with ChatGPT": OpenAI's open-source plan-usage sign-in asks for that
 *   label (developers.openai.com/siwc/token-sharing-open-source/sign-in).
 *
 * `compact` (261023, the Credits page): the same row without the settings
 * row chrome; the caller supplies the heading line and the Learn more link.
 *
 * The non-compact rows sit in one wrapper marked
 * `data-settings-focus="chatgpt-plan"` (261029): Settings scrolls to it and
 * flashes it when opened with view.focus (the startup popup's chatgpt-plan
 * action, lib/popupActions.ts).
 *
 * Tokens never reach the renderer; this reads account summaries from
 * useChatgptStore only. The model picker below it is SettingsScreen's own.
 */
import React from 'react';
import type { ChatgptSignInFailure } from '@shared/chatgptPlan';
import { CHATGPT_USAGE_URL } from '@shared/chatgptPlan';
import { useT } from '../lib/i18n';
import { sei } from '../lib/ipcClient';
import { chatgptReady, useChatgptStore } from '../lib/stores/useChatgptStore';
import { Button } from './Button';
import { ChatgptLogo } from './ChatgptLogo';
import { ContinueWithChatGPTButton } from './ContinueWithChatGPTButton';
import { InfoTip } from './InfoTip';
import settings from '../screens/SettingsScreen.module.css';
import styles from './ChatgptPlanSettings.module.css';

/** User-facing line for a failed sign-in ('cancelled' says nothing). */
export function signInFailureText(reason: ChatgptSignInFailure, t: (s: string) => string): string | null {
  switch (reason) {
    case 'cancelled':
      return null;
    case 'denied':
      return t('Sign-in was cancelled in ChatGPT.');
    case 'timeout':
      return t('Sign-in timed out. Try again.');
    case 'account_mismatch':
      return t('That is a different ChatGPT account. Sign in with the same account, or add it as a new account.');
    case 'network':
      return t('Could not reach ChatGPT. Check your connection and try again.');
    case 'keychain_unavailable':
      return t('Sei could not save your sign-in securely on this device.');
    case 'browser_failed':
      return t('Could not open your browser. Try again.');
    case 'port_unavailable':
      return t('Sei could not start its sign-in listener. Try again.');
    default:
      return t('Sign-in did not finish. Try again.');
  }
}

/**
 * The ChatGPT plan disclosure (OpenAI's guideline body copy + which Sei plans
 * it works on + that it is not a Sei charge), shown in an info tip wherever
 * the plan is offered.
 */
export function chatgptPlanDisclosure(t: (s: string) => string): string {
  return `${t('Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.')} ${t(
    "Works with your ChatGPT Plus or Pro account. Usage counts toward your ChatGPT plan, not Sei's subscription or credits.",
  )}`;
}

/**
 * Scroll the ChatGPT plan rows into view and flash them (Settings with
 * view.focus = 'chatgpt-plan'). The rows render once Settings has read the
 * config, so this waits for them for a moment; gives up quietly.
 */
export function revealChatgptPlanRows(waitMs = 3000): void {
  const deadline = Date.now() + waitMs;
  const tick = (): void => {
    const el = document.querySelector<HTMLElement>('[data-settings-focus="chatgpt-plan"]');
    if (!el) {
      if (Date.now() < deadline) window.setTimeout(tick, 100);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove(styles.focusPulse);
    // Restart the animation when the class was already there.
    void el.offsetWidth;
    el.classList.add(styles.focusPulse);
    window.setTimeout(() => el.classList.remove(styles.focusPulse), 2600);
  };
  tick();
}

interface ChatgptPlanSettingsProps {
  active: boolean;
  /** Switch the provider to the ChatGPT plan (after a sign-in, or when one exists). */
  onUsePlan: () => Promise<void> | void;
  /** The bare action (button + notices), for a surface that draws its own row. */
  compact?: boolean;
}

export function ChatgptPlanSettings(props: ChatgptPlanSettingsProps): React.ReactElement {
  if (props.compact) return <ChatgptPlanRows {...props} />;
  return (
    <div data-settings-focus="chatgpt-plan" className={styles.focusTarget}>
      <ChatgptPlanRows {...props} />
    </div>
  );
}

function ChatgptPlanRows({ active, onUsePlan, compact = false }: ChatgptPlanSettingsProps): React.ReactElement {
  const t = useT();
  const status = useChatgptStore((s) => s.status);
  const signInError = useChatgptStore((s) => s.signInError);
  const signOutUnconfirmed = useChatgptStore((s) => s.signOutUnconfirmed);
  const signIn = useChatgptStore((s) => s.signIn);
  const cancelSignIn = useChatgptStore((s) => s.cancelSignIn);
  const signOut = useChatgptStore((s) => s.signOut);
  const switchAccount = useChatgptStore((s) => s.switchAccount);
  const clearLimit = useChatgptStore((s) => s.clearLimit);

  const accounts = status?.accounts ?? [];
  const activeAcc = accounts.find((a) => a.id === status?.activeId) ?? null;
  const ready = chatgptReady(status);
  const signingIn = status?.signingIn === true;
  const errorLine = signInError ? signInFailureText(signInError, t) : null;
  const openUsage = (): void => void sei.openExternal(CHATGPT_USAGE_URL);

  const startSignIn = async (opts?: { accountId?: string | null; enablePlan?: boolean }): Promise<void> => {
    const r = await signIn(opts);
    if (r?.ok && !active) await onUsePlan();
  };

  const signingInRow = signingIn ? (
    <div className={settings.row}>
      <span className={settings.label}>{t('Finish signing in with ChatGPT in your browser.')}</span>
      <Button kind="quiet" size="sm" onClick={cancelSignIn}>
        {t('Cancel')}
      </Button>
    </div>
  ) : null;

  const notices = (
    <>
      {errorLine ? (
        <p className={`${settings.helper} ${settings.helperError}`} role="alert">
          {errorLine}
        </p>
      ) : null}
      {signOutUnconfirmed ? (
        <p className={settings.helper} role="status">
          {t(
            'Signed out on this device, but Sei could not confirm the sign-out with ChatGPT. To be sure, disconnect Sei in your ChatGPT settings.',
          )}
        </p>
      ) : null}
    </>
  );

  if (!active) {
    // The invite ("Use your ChatGPT plan"): one row, one button. Local mode
    // beside the other providers, and cloud accounts under Backend.
    const action = ready ? (
      <Button kind="primary" size="sm" onClick={() => void onUsePlan()}>
        {t('Use ChatGPT plan')}
      </Button>
    ) : (
      <ContinueWithChatGPTButton disabled={signingIn} busy={signingIn} onClick={() => void startSignIn()} />
    );
    if (compact) {
      return (
        <div className={styles.compact}>
          {action}
          {signingIn ? (
            <span className={styles.compactNote}>
              {t('Finish signing in with ChatGPT in your browser.')}{' '}
              <button type="button" className={settings.creditLink} onClick={cancelSignIn}>
                {t('Cancel')}
              </button>
            </span>
          ) : null}
          {notices}
        </div>
      );
    }
    return (
      <>
        <div className={settings.row} data-testid="chatgpt-plan-invite">
          <span className={settings.label}>
            {t('Use your ChatGPT plan')}
            <InfoTip label={t('About the ChatGPT plan')} text={chatgptPlanDisclosure(t)} />
          </span>
          {action}
        </div>
        {signingInRow}
        {notices}
      </>
    );
  }

  // ── active: the ChatGPT plan is the picked provider ──
  if (!activeAcc || !activeAcc.signedIn) {
    return (
      <>
        <p className={settings.helper}>
          {activeAcc
            ? t('Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.')
            : t('Sign in with your ChatGPT account to use your plan in Sei. No API key needed.')}
        </p>
        <div className={styles.buttonRow}>
          <ContinueWithChatGPTButton
            disabled={signingIn}
            busy={signingIn}
            onClick={() => void startSignIn(activeAcc ? { accountId: activeAcc.id } : undefined)}
          />
        </div>
        {signingInRow}
        {notices}
        {accounts.length > 1 ? <AccountList /> : null}
      </>
    );
  }

  return (
    <>
      {/* Connected (261023: one row instead of three): the account, Manage
          usage when the plan is on (OpenAI's "Using ChatGPT plan" + "Manage
          usage" pair), Sign out, and Add account for a second account. */}
      <div className={settings.row}>
        <span className={`${settings.label} ${styles.inUse}`}>
          {activeAcc.planEnabled ? <ChatgptLogo size={16} /> : null}
          {activeAcc.planEnabled ? t('Using ChatGPT plan') : t('ChatGPT account')}
          <InfoTip label={t('About the ChatGPT plan')} text={chatgptPlanDisclosure(t)} />
        </span>
        <span className={`${settings.monoValue} ${styles.account}`} title={activeAcc.label}>
          {activeAcc.label}
        </span>
        {activeAcc.planEnabled ? (
          <Button kind="ghost" size="sm" onClick={openUsage}>
            {t('Manage usage')}
          </Button>
        ) : null}
        <Button kind="ghost" size="sm" disabled={signingIn} onClick={() => void signOut(activeAcc.id)}>
          {t('Sign out')}
        </Button>
      </div>
      {accounts.length > 1 ? <AccountList /> : null}
      <div className={styles.addRow}>
        <Button kind="quiet" size="sm" disabled={signingIn} onClick={() => void startSignIn({ accountId: null })}>
          {t('Add account')}
        </Button>
      </div>
      {activeAcc.planEnabled ? null : (
        <>
          <p className={`${settings.helper} ${settings.helperError}`} role="alert">
            {t('ChatGPT plan use was not turned on when you signed in, so Sei cannot use your plan yet.')}
          </p>
          <div className={styles.buttonRow}>
            <Button
              kind="primary"
              size="sm"
              disabled={signingIn}
              onClick={() => void startSignIn({ accountId: activeAcc.id, enablePlan: true })}
            >
              {t('Turn on ChatGPT plan')}
            </Button>
          </div>
        </>
      )}
      {status?.usageLimited ? (
        <div className={settings.row}>
          <span className={`${settings.label} ${settings.statusWarn}`}>
            {t('Usage limit reached. Requests are paused.')}
          </span>
          <Button kind="ghost" size="sm" onClick={() => void clearLimit()}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {status?.blockedCode ? <BlockedNotice code={status.blockedCode} /> : null}
      {signingInRow}
      {notices}
    </>
  );

  /**
   * A latched plan answer, with the action that lifts it: the dialog that
   * first showed it may be long closed, so this row is how a player gets
   * unstuck. A rejected sign-in needs a new sign-in; everything else gets
   * Try again (one attempt, the latch returns if the answer does).
   */
  function BlockedNotice({ code }: { code: string }): React.ReactElement {
    if (code === 'CHATGPT_AUTH_REJECTED') {
      return (
        <>
          <p className={`${settings.helper} ${settings.helperError}`} role="alert">
            {t("ChatGPT didn't accept Sei's sign-in, even after renewing it. Sign in again to keep using your plan.")}
          </p>
          <div className={styles.buttonRow}>
            <ContinueWithChatGPTButton
              disabled={signingIn}
              busy={signingIn}
              onClick={() => void startSignIn(activeAcc ? { accountId: activeAcc.id } : undefined)}
            />
          </div>
        </>
      );
    }
    const text =
      code === 'CHATGPT_REQUEST_REJECTED'
        ? t("ChatGPT didn't accept Sei's last request, so ChatGPT requests are paused.")
        : code === 'CHATGPT_FORBIDDEN'
          ? t("ChatGPT plan use isn't available here right now. It may be limited in your region or by your plan.")
          : t("This ChatGPT account can't use its plan in Sei right now. Plan use needs ChatGPT Plus or Pro. Try another account, or pick another provider.");
    return (
      <div className={settings.row}>
        <span className={`${settings.label} ${settings.statusWarn}`} role="alert">
          {text}
        </span>
        <Button kind="ghost" size="sm" onClick={() => void clearLimit()}>
          {t('Try again')}
        </Button>
      </div>
    );
  }

  function AccountList(): React.ReactElement {
    return (
      <div className={styles.accounts} role="list" aria-label={t('ChatGPT accounts')}>
        {accounts.map((a) => (
          <div key={a.id} className={styles.accountRow} role="listitem">
            <span className={settings.monoValue}>{a.label}</span>
            {a.id === status?.activeId ? (
              <span className={styles.activeMark}>{t('active')}</span>
            ) : a.signedIn ? (
              <Button kind="quiet" size="sm" onClick={() => void switchAccount(a.id)}>
                {t('Switch')}
              </Button>
            ) : (
              <Button kind="quiet" size="sm" disabled={signingIn} onClick={() => void startSignIn({ accountId: a.id })}>
                {t('Sign in')}
              </Button>
            )}
          </div>
        ))}
      </div>
    );
  }
}
