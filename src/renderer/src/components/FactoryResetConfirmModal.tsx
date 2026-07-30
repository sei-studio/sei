/**
 * FactoryResetConfirmModal — confirm wiping the whole device back to a fresh
 * install (260728). The most destructive action in the app, so the danger CTA
 * carries an explicit re-statement of scope. On confirm the app relaunches
 * itself (main's app:factory-reset handler); the awaiting promise never
 * resolves in the success case, so the spinner label simply holds until the
 * window goes away.
 *
 * Esc / scrim-click cancel are SUPPRESSED while the reset is in flight.
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

export interface FactoryResetConfirmModalProps {
  onCancel: () => void;
}

export function FactoryResetConfirmModal({
  onCancel,
}: FactoryResetConfirmModalProps): React.ReactElement {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await sei.factoryReset();
      // Success never returns (the app restarts). Reaching here means the
      // handler threw before the relaunch.
    } catch (err) {
      setError((err as Error).message || t('Factory reset failed.'));
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title={t('Factory reset Sei?')}
      onClose={onCancel}
      escClose={!submitting}
      scrimClose={!submitting}
    >
      <p className={styles.body}>
        {t(
          "This deletes everything Sei keeps on this device: every companion, their memories and chat history, your settings, your sign-in, and any saved API keys. Data stored in your cloud account is not touched. Sei will restart like a fresh install. This can't be undone.",
        )}
      </p>
      {error ? (
        <p className={styles.body} role="alert">
          {error}
        </p>
      ) : null}
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
          {t('Cancel')}
        </Button>
        <Button kind="danger" size="md" onClick={() => void handleConfirm()} disabled={submitting}>
          {submitting ? t('Erasing…') : t('Erase everything')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
