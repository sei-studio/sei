/**
 * ResetAllMemoriesConfirmModal — confirm wiping EVERY companion's memory.
 *
 * "Reset all companion memories" wipes saved chat history + playtime for every
 * character on the device at once. It's destructive and irreversible, so it gets
 * an explicit popup confirm with a danger CTA — matching the other DANGER-zone
 * actions.
 *
 * Renders through ModalShell; Esc / scrim-click cancel are SUPPRESSED while the
 * reset is in flight so a stray input can't abort a partial wipe.
 */
import React, { useState } from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

export interface ResetAllMemoriesConfirmModalProps {
  /** How many companions will be reset — surfaced in the body copy. */
  characterCount: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function ResetAllMemoriesConfirmModal({
  characterCount,
  onCancel,
  onConfirm,
}: ResetAllMemoriesConfirmModalProps): React.ReactElement {
  const t = useT();
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

  return (
    <ModalShell
      title={t('Reset all companion memories?')}
      onClose={onCancel}
      escClose={!submitting}
      scrimClose={!submitting}
    >
      <p className={styles.body}>
        {characterCount === 1
          ? t(
              'This permanently wipes saved chat history and playtime for 1 companion on this device. Persona, portrait, and skin are kept. This can’t be undone.',
            )
          : t(
              'This permanently wipes saved chat history and playtime for all {count} companions on this device. Persona, portrait, and skin are kept. This can’t be undone.',
              { count: characterCount },
            )}
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel} disabled={submitting}>
          {t('Cancel')}
        </Button>
        <Button kind="danger" size="md" onClick={handleConfirm} disabled={submitting}>
          {submitting ? t('Resetting…') : t('Reset all memories')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
