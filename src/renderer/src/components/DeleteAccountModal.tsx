/**
 * DeleteAccountModal — type-email-to-confirm destructive modal (D-12).
 *
 * Source: 10-UI-SPEC §Delete-account modal + Copywriting Contract.
 *
 * Layout invariants per UI-SPEC §Layout rules:
 *   - 460px width, 32px padding, scrim 0.45 alpha (rule 2, 3).
 *   - ESC closes; SUPPRESSED while submitting (rule 4a).
 *   - Click-outside does NOT close — explicit dismissal action required (rule 5).
 *   - Destructive confirm disabled until typed string matches accountEmail
 *     (case-insensitive trim).
 *
 * Plan 10-08 replaces the plan 10-07 stub. Props contract preserved:
 *   { accountEmail, onCancel, onConfirmed } — SettingsScreen already mounts.
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { Button } from './Button';
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

  // ESC closes the modal UNLESS we are in-flight or in the success transition.
  // UI-SPEC §Layout rule 4a — destructive flows suppress ESC during work so a
  // stray keypress can't abort an irreversible operation already in motion.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting && phase === 'idle') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting, phase]);

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

  const titleId = 'delete-account-title';
  const para3Id = 'delete-account-confirm-instruction';

  return (
    // Click-outside SUPPRESSED — UI-SPEC §Layout rule 5. No onClick handler on scrim.
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>
          Delete your Sei account?
        </h2>

        {phase === 'idle' ? (
          <>
            <p className={styles.body}>
              Cloud-side, this removes your characters, shared listings, credit ledger, and uploaded
              skin &amp; portrait files within 30 days.
            </p>
            <p className={styles.body}>
              Local-side, your characters on this machine, your bot&apos;s memory, and any cloud
              characters you&apos;ve opened locally are untouched.
            </p>
            <p id={para3Id} className={styles.body}>
              To confirm, type <strong className={styles.bodyEmphasis}>{accountEmail}</strong>{' '}
              below.
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

            <div className={styles.footer}>
              <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
                Keep my account
              </Button>
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={onConfirmClick}
                disabled={!canConfirm}
                aria-label="Delete account"
              >
                {submitting ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </>
        ) : (
          <p className={styles.success}>Account scheduled for deletion. Signing you out…</p>
        )}
      </div>
    </div>
  );
}
