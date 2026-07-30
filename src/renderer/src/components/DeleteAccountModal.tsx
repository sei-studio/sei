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
import { useT } from '../lib/i18n';
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
  const t = useT();
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
            ? t("Couldn't reach the account-deletion service. Try again.")
            : res.message || t("Couldn't delete the account. Try again."),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const para3Id = 'delete-account-confirm-instruction';

  // Keep the <strong> around the email: translate with the {email} placeholder
  // intact, then split on it and re-insert the styled node.
  const [confirmBefore, confirmAfter] = t('To confirm, type {email} below.').split('{email}');

  return (
    <ModalShell
      title={t('Delete your Sei account?')}
      width={460}
      onClose={onCancel}
      escClose={!submitting && phase === 'idle'}
    >
      {phase === 'idle' ? (
        <>
          <p className={styles.body}>
            {t(
              'Cloud-side, this removes your companions, shared listings, credit ledger, and uploaded skin & portrait files within 30 days.',
            )}
          </p>
          <p className={styles.body}>
            {t(
              "Local-side, your companions on this machine, your bot's memory, and any cloud companions you've opened locally are untouched.",
            )}
          </p>
          <p id={para3Id} className={styles.body}>
            {confirmBefore}
            <strong className={styles.bodyEmphasis}>{accountEmail}</strong>
            {confirmAfter}
          </p>

          <div className={styles.confirmInputRow}>
            <TextField
              value={typed}
              onChange={setTyped}
              placeholder={accountEmail}
              aria-label={t('Type {email} to confirm account deletion', { email: accountEmail })}
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
              {t('Keep my account')}
            </Button>
            <Button
              kind="danger"
              size="md"
              onClick={onConfirmClick}
              disabled={!canConfirm}
              aria-label={t('Delete account')}
            >
              {submitting ? t('Deleting…') : t('Delete account')}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <p className={styles.success}>{t('Account scheduled for deletion. Signing you out…')}</p>
      )}
    </ModalShell>
  );
}
