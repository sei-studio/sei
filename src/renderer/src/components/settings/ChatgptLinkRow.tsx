/**
 * ChatgptLinkRow: Settings > Account "ChatGPT" row (261023).
 *
 * Lets a signed-in Sei user attach their ChatGPT identity so "Continue with
 * ChatGPT" signs them straight into THIS account on this computer. The live
 * Sei session is the proof of account ownership (the proxy's /link route), so
 * no email code is needed here. A ChatGPT identity already linked to another
 * Sei account is refused, never merged.
 *
 * Linking also connects the ChatGPT plan on this device when the account is
 * eligible; ChatgptPlanHost then offers the backend switch (the one-shot offer
 * main sets), through the same confirm as everywhere else.
 *
 * Linked state is what this device knows (main's saved registration for the
 * current user). Another computer's link does not show here, which only
 * means the button is offered again; linking twice is a no-op on the proxy.
 *
 * Unlink (261023) removes the link on the proxy and this device's
 * registration, so the next "Continue with ChatGPT" is treated as a new
 * identity (and a different Sei account can link it). The ChatGPT plan, if
 * connected, stays connected. Borderless quiet button, like the row's
 * Cancel (no framed buttons in Settings, 261023).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { ChatgptLoginFailure, ChatgptLoginStatus } from '@shared/ipc';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { chatgptLoginErrorCopy } from '../../lib/useChatgptLogin';
import { Button } from '../Button';

export interface ChatgptLinkRowProps {
  rowClassName: string;
  labelClassName: string;
  valueClassName: string;
  errorClassName: string;
}

type Translate = (en: string, params?: Record<string, string | number>) => string;

/** Copy for a failed unlink. 'unavailable' covers an older proxy without the route (404). */
export function chatgptUnlinkErrorCopy(reason: ChatgptLoginFailure, t: Translate): string | null {
  if (reason === 'unavailable' || reason === 'sign_in_failed') return t("Couldn't unlink right now. Try again later.");
  return chatgptLoginErrorCopy(reason, t, 'link');
}

export function ChatgptLinkRow(props: ChatgptLinkRowProps): React.ReactElement {
  const t = useT();
  const [status, setStatus] = useState<ChatgptLoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only a link THIS row started is cancelled on unmount: the cancel also
  // aborts any plan sign-in, which ChatgptPlanSettings may own.
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    let cancelled = false;
    sei.chatgptLoginStatus().then(
      (s) => {
        if (!cancelled) setStatus(s);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      // Leaving Settings mid-link closes the browser listener in main.
      if (busyRef.current) void sei.cancelChatgptLogin().catch(() => undefined);
    };
  }, []);

  const link = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sei.linkChatgptAccount();
      if (res.ok) {
        setStatus({ linked: true, email: res.email, awaitingCode: false });
      } else {
        setError(chatgptLoginErrorCopy(res.reason, t, 'link'));
      }
    } catch {
      setError(chatgptLoginErrorCopy('sign_in_failed', t, 'link'));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (): Promise<void> => {
    if (unlinking || busy) return;
    setUnlinking(true);
    setError(null);
    try {
      const res = await sei.unlinkChatgptAccount();
      if (res.ok) {
        setStatus({ linked: false, email: null, awaitingCode: false });
      } else {
        setError(chatgptUnlinkErrorCopy(res.reason, t));
      }
    } catch {
      // An older main without the channel lands here too.
      setError(chatgptUnlinkErrorCopy('unavailable', t));
    } finally {
      setUnlinking(false);
    }
  };

  const cancel = (): void => {
    void sei.cancelChatgptLogin().catch(() => undefined);
  };

  return (
    <>
      <div className={props.rowClassName}>
        <span className={props.labelClassName}>{t('ChatGPT sign-in')}</span>
        {status?.linked ? (
          <>
            <span className={props.valueClassName}>{status.email ?? t('Linked')}</span>
            <Button kind="quiet" size="sm" disabled={unlinking} onClick={() => void unlink()}>
              {t('Unlink')}
            </Button>
          </>
        ) : busy ? (
          <>
            <span className={props.valueClassName}>{t('Finish in your browser')}</span>
            <Button kind="quiet" size="sm" onClick={cancel}>
              {t('Cancel')}
            </Button>
          </>
        ) : (
          <Button kind="ghost" size="sm" onClick={() => void link()}>
            {t('Link ChatGPT')}
          </Button>
        )}
      </div>
      {error ? (
        <div className={props.errorClassName} role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}
