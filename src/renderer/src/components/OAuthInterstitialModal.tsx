/**
 * OAuthInterstitialModal — centered modal shown while Google OAuth runs in
 * the system browser (D-05).
 *
 * Owns the OAuth IPC invocation lifecycle (via sei from ipcClient):
 *   - On mount: invoke once; show countdown body ("This will close on its
 *     own in Ns.") while waiting for the loopback callback.
 *   - On result.ok: brief 'Signed in. One moment…' (~200ms) then onResult.
 *   - On result.ok=false: swap to one of 6 UI-SPEC error variants with
 *     'Try again' (ghost) + 'Cancel sign-in' (quiet) buttons.
 *   - On 'Cancel sign-in' click: cancel IPC then onCancel().
 *
 * Dismissal label is exactly 'Cancel sign-in' (UI-SPEC dismissal-label policy).
 * ESC is SUPPRESSED while the loopback exchange is in flight (UI-SPEC
 * §Layout rule 4b) — implemented by simply not registering a keydown listener.
 * Click-outside is SUPPRESSED (UI-SPEC §Layout rule 5) — no outside-click
 * handler on the scrim.
 *
 * Failure-mode → variant mapping (UI-SPEC §OAuth error copy — verbatim):
 *   browser_closed → "Sign-in didn't finish"
 *   network        → "Couldn't reach Google"
 *   timeout        → "That took a little too long"
 *   google_rejected→ "Google declined the sign-in"
 *   port_collision → "Couldn't open the sign-in helper"
 *   exchange_failed→ "Sign-in hit a snag"
 *   user_cancelled → handled via onCancel; not surfaced as an error variant
 *
 * Source: 10-UI-SPEC §Google OAuth interstitial modal + §OAuth error copy.
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import type { OAuthResult } from '@shared/ipc';
import styles from './OAuthInterstitialModal.module.css';

export interface OAuthInterstitialModalProps {
  onResult: (r: OAuthResult) => void;
  onCancel: () => void;
}

type ErrorReason = Extract<OAuthResult, { ok: false }>['reason'];

type Phase =
  | { kind: 'waiting'; secondsLeft: number }
  | { kind: 'success' } // 'Signed in. One moment…' — ~200ms before onResult fires
  | { kind: 'error'; reason: ErrorReason; message: string };

const ERROR_COPY: Record<ErrorReason, { heading: string; body: string }> = {
  browser_closed: {
    heading: "Sign-in didn't finish",
    body: 'Looks like the browser tab was closed. Try again, and finish the Google flow in the tab that opens.',
  },
  network: {
    heading: "Couldn't reach Google",
    body: "Sei couldn't connect to Google's sign-in. Check your internet and try again.",
  },
  timeout: {
    heading: 'That took a little too long',
    body: 'The sign-in link expired. Try again; it stays valid for about a minute.',
  },
  google_rejected: {
    heading: 'Google declined the sign-in',
    body: "Google didn't approve the sign-in. You can try again or use email and password instead.",
  },
  port_collision: {
    heading: "Couldn't open the sign-in helper",
    body: 'Something else on your machine is using the port Sei needs. Close it and try again, or use email and password.',
  },
  exchange_failed: {
    heading: 'Sign-in hit a snag',
    body: "Sei finished the Google step but couldn't set up your session. Try again; this usually works on the second attempt.",
  },
  user_cancelled: {
    // Cancel button routes through onCancel; if this surfaces it's because
    // the IPC returned reason:'user_cancelled' without our explicit cancel.
    // Treat as a soft cancel (back to parent SignInModal).
    heading: 'Cancelled',
    body: 'Sign-in cancelled.',
  },
};

export function OAuthInterstitialModal({
  onResult,
  onCancel,
}: OAuthInterstitialModalProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting', secondsLeft: 60 });
  const inFlightRef = useRef(false);

  const start = (): void => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase({ kind: 'waiting', secondsLeft: 60 });
    sei.signInGoogle().then((res) => {
      inFlightRef.current = false;
      if (res.ok) {
        setPhase({ kind: 'success' });
        setTimeout(() => onResult(res), 200);
      } else if (res.reason === 'user_cancelled') {
        // Either we cancelled explicitly (cancel button → cancelGoogle()
        // → loopbackPkce aborts → result is user_cancelled) or it bubbled up
        // for some other reason; either way return to parent SignInModal.
        onCancel();
      } else {
        setPhase({ kind: 'error', reason: res.reason, message: res.message });
      }
    });
  };

  // Kick off the OAuth flow once on mount; re-runnable via Try again.
  // ESC suppression: no keydown listener — UI-SPEC §Layout rule 4b.
  // Click-outside suppression: no listener on the scrim — UI-SPEC §Layout rule 5.
  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown tick — only ticks while waiting.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    if (phase.secondsLeft <= 0) return;
    const t = setTimeout(() => {
      setPhase((p) =>
        p.kind === 'waiting' ? { kind: 'waiting', secondsLeft: p.secondsLeft - 1 } : p,
      );
    }, 1000);
    return () => clearTimeout(t);
  }, [phase]);

  const onCancelClick = async (): Promise<void> => {
    // Main-side cancel: aborts the in-flight startGoogleOAuth so its
    // server closes; the signInGoogle() promise will resolve with
    // user_cancelled but by then we've already dismissed the modal.
    await sei.cancelGoogle();
    onCancel();
  };

  const onTryAgain = (): void => {
    start();
  };

  // Single title across all phases — waiting + success show the "in-browser"
  // heading; error phases swap to the failure-mode heading.
  const titleText =
    phase.kind === 'error' ? ERROR_COPY[phase.reason].heading : 'Continue in your browser';

  // Tier 'stacked' (z 1100) sits above SignInModal. ESC + click-outside are
  // SUPPRESSED (escClose false, scrimClose default false, no onClose) while the
  // loopback exchange runs — dismissal is only via the buttons.
  return (
    <ModalShell title={titleText} width={460} tier="stacked" escClose={false}>
      {phase.kind === 'waiting' ? (
        <>
          <p className={styles.body}>
            We&apos;ve opened a browser tab to finish signing in with Google. Come back when
            you&apos;re done; this window updates automatically.
          </p>
          <p className={styles.countdown} aria-live="polite">
            This will close on its own in {phase.secondsLeft}s.
          </p>
          <ModalFooter>
            <Button kind="ghost" size="md" onClick={onCancelClick}>
              Cancel sign-in
            </Button>
          </ModalFooter>
        </>
      ) : null}

      {phase.kind === 'success' ? (
        <p className={styles.success}>Signed in. One moment…</p>
      ) : null}

      {phase.kind === 'error' ? (
        <>
          <p className={styles.body}>{ERROR_COPY[phase.reason].body}</p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={onCancelClick}>
              Cancel sign-in
            </Button>
            <Button kind="ghost" size="md" onClick={onTryAgain}>
              Try again
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </ModalShell>
  );
}
