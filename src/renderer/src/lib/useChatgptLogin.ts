/**
 * useChatgptLogin: shared state machine for "Continue with ChatGPT" as a Sei
 * ACCOUNT sign-in (261023).
 *
 * Three surfaces show it (AuthChoiceScreen, SignInModal, the onboarding
 * AuthPanel). Like useEmailCode, the hook owns the flow and its copy and the
 * callers own layout, so the email-code step reads the same everywhere.
 *
 * Phases:
 *   idle       nothing running
 *   browser    the ChatGPT sign-in tab is open; waiting for its callback
 *   code       the proxy asked for a one-time email code (existing account,
 *              new device, or an email ChatGPT did not vouch for)
 *   verifying  a code is being checked
 *
 * On success main has already set the Supabase session, so App.tsx's
 * auth-state subscriber routes onward exactly as it does after Google. The
 * optional onSignedIn callback is for a host that has to close itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatgptLoginCodeReason, ChatgptLoginFailure, ChatgptLoginResult } from '@shared/ipc';
import { sei } from './ipcClient';
import { useT } from './i18n';

export type ChatgptLoginPhase = 'idle' | 'browser' | 'code' | 'verifying';

export interface ChatgptLoginState {
  phase: ChatgptLoginPhase;
  /** Masked address the code went to ("s***@gmail.com"). */
  emailHint: string;
  reason: ChatgptLoginCodeReason | null;
  code: string;
  setCode: (v: string) => void;
  error: string | null;
  /** Why the last attempt failed (null after a success or a fresh start). */
  failure: ChatgptLoginFailure | null;
  note: string | null;
  resending: boolean;
  start: () => Promise<void>;
  submit: (candidate?: string) => Promise<void>;
  resend: () => Promise<void>;
  /** Cancel the browser wait or leave the code step. */
  cancel: () => void;
}

type Translate = (en: string, params?: Record<string, string | number>) => string;

/** User-facing copy for a failure. Main's messages are English-only logs. */
/**
 * `surface` is 'link' for Settings > Link ChatGPT, where the user is already
 * signed in and "use Google instead" would make no sense.
 */
export function chatgptLoginErrorCopy(
  reason: ChatgptLoginFailure,
  t: Translate,
  surface: 'sign_in' | 'link' = 'sign_in',
): string | null {
  switch (reason) {
    case 'cancelled':
      return null;
    case 'region_blocked':
      return t("ChatGPT sign-in isn't available in your region.");
    case 'provider_region':
      // 261103 (T303): OpenAI's own refusal. No VPN advice (policy).
      return t('OpenAI does not support your region. You can use local mode with your own API key instead.');
    case 'denied':
      return t('ChatGPT sign-in was declined. Try again, or use another way to sign in.');
    case 'timeout':
      return t('The ChatGPT sign-in took too long. Try again.');
    case 'browser_failed':
      return t("Sei couldn't open your browser. Try again.");
    case 'network':
      return t("Couldn't reach Sei. Check your internet and try again.");
    case 'unavailable':
      return t('ChatGPT sign-in is having trouble right now. Try again in a moment.');
    case 'no_email':
      return t("Your ChatGPT account didn't share an email address, so Sei can't make an account from it.");
    case 'account_conflict':
      return t('That Sei account is already linked to a different ChatGPT account. Sign in with your email or Google instead.');
    case 'linked_elsewhere':
      return t('This ChatGPT account is already linked to a different Sei account.');
    case 'rate_limited':
      // Any 429: the per-IP gates, the per-address and project-wide email
      // caps (sei-proxy quota.ts), or GoTrue's own email limit.
      return surface === 'link'
        ? t('Too many tries. Wait a bit and try again.')
        : t('Too many tries. Wait a bit, or continue with Google.');
    case 'token_rejected':
      return t("Sei couldn't confirm your ChatGPT sign-in. Try again.");
    case 'invalid_code':
      return t("That code isn't right. Check it and try again.");
    case 'code_expired':
      return t('That code expired or had too many tries. Start again.');
    case 'not_signed_in':
      return t('Sign in to Sei first.');
    case 'sign_in_failed':
    default:
      return t('ChatGPT sign-in hit a snag. Try again.');
  }
}

/** One line under the code step's heading, keyed on why the code was asked. */
export function chatgptCodeReasonCopy(reason: ChatgptLoginCodeReason | null, t: Translate): string {
  switch (reason) {
    case 'existing_account':
      return t('This email already has a Sei account. Enter the code to sign in to it with ChatGPT.');
    case 'unverified_email':
      return t('ChatGPT did not confirm this email, so Sei checks it once.');
    case 'new_device':
    default:
      return t('First time on this computer. Enter the code to confirm it is you.');
  }
}

export function useChatgptLogin(onSignedIn?: () => void): ChatgptLoginState {
  const t = useT();
  const [phase, setPhase] = useState<ChatgptLoginPhase>('idle');
  const [emailHint, setEmailHint] = useState('');
  const [reason, setReason] = useState<ChatgptLoginCodeReason | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ChatgptLoginFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // CodeInput fires onComplete on a full code; never run two redemptions.
  const inFlight = useRef(false);
  // A host that closes mid-flow (Esc on the modal, Back in onboarding) must
  // not leave the browser listener or a pending code alive in main.
  const phaseRef = useRef<ChatgptLoginPhase>('idle');
  phaseRef.current = phase;
  useEffect(
    () => () => {
      if (phaseRef.current !== 'idle') void sei.cancelChatgptLogin().catch(() => undefined);
    },
    [],
  );

  const apply = useCallback(
    (res: ChatgptLoginResult): void => {
      if (res.ok && res.kind === 'signed_in') {
        setPhase('idle');
        setCode('');
        setError(null);
        setNote(null);
        onSignedIn?.();
        return;
      }
      if (res.ok && res.kind === 'email_code') {
        setPhase('code');
        setEmailHint(res.emailHint);
        setReason(res.reason);
        setCode('');
        setError(null);
        setNote(null);
        return;
      }
      if (!res.ok) {
        const copy = chatgptLoginErrorCopy(res.reason, t);
        setFailure(res.reason === 'cancelled' ? null : res.reason);
        if (res.reason === 'invalid_code') {
          // Wrong code: stay on the step with an empty field.
          setPhase('code');
          setCode('');
        } else if (res.reason === 'network' || res.reason === 'rate_limited' || res.reason === 'unavailable') {
          // Retryable: keep whatever step we were on.
          setPhase((p) => (p === 'verifying' ? 'code' : p === 'browser' ? 'idle' : p));
        } else {
          setPhase('idle');
        }
        setError(copy);
      }
    },
    [onSignedIn, t],
  );

  const start = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setFailure(null);
    setNote(null);
    setPhase('browser');
    try {
      apply(await sei.signInChatgpt());
    } catch {
      setPhase('idle');
      setError(chatgptLoginErrorCopy('sign_in_failed', t));
    } finally {
      inFlight.current = false;
    }
  }, [apply, t]);

  const submit = useCallback(
    async (candidate?: string): Promise<void> => {
      const value = (candidate ?? code).replace(/\D/g, '');
      if (value.length === 0 || inFlight.current) return;
      inFlight.current = true;
      setError(null);
      setNote(null);
      setPhase('verifying');
      try {
        apply(await sei.chatgptLoginVerifyCode(value));
      } catch {
        setPhase('code');
        setError(t("Couldn't check that code. Try again."));
      } finally {
        inFlight.current = false;
      }
    },
    [apply, code, t],
  );

  const resend = useCallback(async (): Promise<void> => {
    if (resending) return;
    setResending(true);
    setNote(null);
    setError(null);
    try {
      const res = await sei.chatgptLoginResendCode();
      if (res.ok) {
        setNote(t('Sent. Give it a minute, and check spam too.'));
      } else {
        if (res.reason === 'code_expired') setPhase('idle');
        setError(chatgptLoginErrorCopy(res.reason, t));
      }
    } catch {
      setNote(t("Couldn't send a new code. Try again in a moment."));
    } finally {
      setResending(false);
    }
  }, [resending, t]);

  const cancel = useCallback((): void => {
    void sei.cancelChatgptLogin().catch(() => undefined);
    setPhase('idle');
    setCode('');
    setError(null);
    setFailure(null);
    setNote(null);
  }, []);

  return { phase, emailHint, reason, code, setCode, error, failure, note, resending, start, submit, resend, cancel };
}
