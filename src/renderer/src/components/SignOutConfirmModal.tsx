/**
 * SignOutConfirmModal — single-confirmation modal for sign-out (D-09).
 *
 * Two title branches based on bot-running state. Body copy is identical in
 * both branches and emphasises what's preserved (AUTH-05 framing).
 *
 * Confirm button is `kind='primary'` (NOT 'accent', NOT red/destructive) —
 * D-09 says sign-out is reversible and preserves local data, so it does not
 * warrant the destructive red treatment.
 *
 * Dismissal label uses the verbatim UI-SPEC dismissal-label policy phrase.
 *
 * Plan 10-06 ships the COMPONENT ONLY. The Settings Account-panel wires the
 * mount + onConfirm → sei.signOut() in plan 10-07.
 *
 * Source: 10-UI-SPEC §Sign-out flow (D-09) + Copywriting Contract.
 */
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';

export interface SignOutConfirmModalProps {
  /** When true the title warns that confirming will stop the running bot. */
  botRunning: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function SignOutConfirmModal({
  botRunning,
  onCancel,
  onConfirm,
}: SignOutConfirmModalProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // ESC closes (when not mid-submit — don't drop a pending sign-out RPC).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  const title = botRunning ? 'Sign out will stop your bot. Continue?' : 'Sign out?';
  const ctaLabel = submitting ? 'Signing out…' : 'Sign out';
  const titleId = 'signout-confirm-title';

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        // Click-outside dismisses (matches LanModal / DeleteConfirmModal
        // convention) unless we're mid-RPC.
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p className={styles.body}>
          Your local characters, memory, and saved API key stay on this machine.
        </p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
            Stay signed in
          </Button>
          <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>
            {ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
