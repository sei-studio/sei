/**
 * SignOutConfirmModal — single-confirmation modal for sign-out (D-09).
 *
 * Two title branches based on bot-running state. Body copy is identical in
 * both branches and emphasises what's preserved (AUTH-05 framing).
 *
 * Confirm button is `kind='primary'` (NOT destructive) — D-09 says sign-out is
 * reversible and preserves local data, so it does not warrant the red
 * treatment. The dismiss action ("Stay signed in") is a real alternative, so it
 * uses the bordered ghost kind.
 *
 * Renders through ModalShell; Esc and scrim-click dismiss are suppressed while
 * the sign-out RPC is in flight.
 */
import React, { useState } from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

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

  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      escClose={!submitting}
      scrimClose={!submitting}
    >
      <p className={styles.body}>
        Your local characters, memory, and saved API key stay on this machine.
      </p>
      <ModalFooter>
        <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
          Stay signed in
        </Button>
        <Button kind="primary" size="md" onClick={handleConfirm} disabled={submitting}>
          {ctaLabel}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
