/**
 * DeleteAccountModal — type-email-to-confirm destructive modal (D-12).
 *
 * Renders through ModalShell at 460px. Esc closes but is SUPPRESSED while
 * submitting or during the success transition (a stray keypress must not abort
 * an irreversible operation already in motion). Click-outside never closes
 * (scrimClose omitted). The destructive confirm stays disabled until the typed
 * string matches accountEmail (case-insensitive trim).
 *
 * Props contract preserved: { accountEmail, onCancel, onConfirmed }.
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { TextField } from './TextField';
import styles from './DeleteAccountModal.module.css';

export interface DeleteAccountModalProps {
  accountEmail: string;
  onCancel: () => void;
  onConfirmed: () => void;
}

export function DeleteAccountModal({
  accountEmail,
  onCancel,
  onConfirmed,
}: DeleteAccountModalProps): React.ReactElement {
  const [typed, setTyped] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'success'>('idle');

  const matches = typed.trim().toLowerCase() === accountEmail.trim().toLowerCase();
  const canConfirm = matches && !submitting && phase === 'idle';

  const onConfirmClick = async (): Promise<void> => {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await sei.deleteAccount();
      if (res.ok) {
        setPhase('success');
        // D-12: brief "scheduled for deletion" state then unmount; parent's
        // SIGNED_OUT event drops the app to AuthChoice.
        setTimeout(() => onConfirmed(), 1200);
      } else {
        setError(
          res.code === 'network'
            ? "Couldn't reach the account-deletion service. Try again."
            : res.message || "Couldn't delete the account. Try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const para3Id = 'delete-account-confirm-instruction';

  return (
    <ModalShell
      title="Delete your Sei account?"
      width={460}
      onClose={onCancel}
      escClose={!submitting && phase === 'idle'}
    >
      {phase === 'idle' ? (
        <>
          <p className={styles.body}>
            Cloud-side, this removes your companions, shared listings, credit ledger, and uploaded
            skin &amp; portrait files within 30 days.
          </p>
          <p className={styles.body}>
            Local-side, your companions on this machine, your bot&apos;s memory, and any cloud
            companions you&apos;ve opened locally are untouched.
          </p>
          <p id={para3Id} className={styles.body}>
            To confirm, type <strong className={styles.bodyEmphasis}>{accountEmail}</strong> below.
          </p>

          <div className={styles.confirmInputRow}>
            <TextField
              value={typed}
              onChange={setTyped}
              placeholder={accountEmail}
              aria-label={`Type ${accountEmail} to confirm account deletion`}
              aria-invalid={typed.length > 0 && !matches}
            />
          </div>

          {error ? (
            <p className={styles.errorText} role="alert">
              {error}
            </p>
          ) : null}

          <ModalFooter>
            <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
              Keep my account
            </Button>
            <Button
              kind="danger"
              size="md"
              onClick={onConfirmClick}
              disabled={!canConfirm}
              aria-label="Delete account"
            >
              {submitting ? 'Deleting…' : 'Delete account'}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <p className={styles.success}>Account scheduled for deletion. Signing you out…</p>
      )}
    </ModalShell>
  );
}
