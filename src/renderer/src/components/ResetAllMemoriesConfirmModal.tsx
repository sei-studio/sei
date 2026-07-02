/**
 * ResetAllMemoriesConfirmModal — confirm wiping EVERY companion's memory.
 *
 * "Reset all companion memories" wipes saved chat history + playtime for every
 * character on the device at once. It's destructive and irreversible, so it gets
 * an explicit popup confirm (replacing the old inline click-again-to-confirm)
 * with a red CTA — matching the other DANGER-zone actions.
 *
 * Scaffold cloned from SwitchBackendConfirmModal; reuses the shared confirm-modal
 * CSS. Click-outside / ESC cancel, but are SUPPRESSED while the reset is in
 * flight so a stray click can't abort a partial wipe.
 */
import React, { useEffect, useState } from 'react';
import { Button } from './Button';
import styles from './SignOutConfirmModal.module.css';

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
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
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

  const companions = characterCount === 1 ? '1 companion' : `all ${characterCount} companions`;
  const titleId = 'reset-all-memories-confirm-title';

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div className={styles.modal}>
        <h2 id={titleId} className={styles.title}>Reset all companion memories?</h2>
        <p className={styles.body}>
          This permanently wipes saved chat history and playtime for {companions} on
          this device. Persona, portrait, and skin are kept. This can’t be undone.
        </p>
        <div className={styles.footer}>
          <Button kind="ghost" size="md" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button kind="danger" size="md" onClick={handleConfirm} disabled={submitting}>
            {submitting ? 'Resetting…' : 'Reset all memories'}
          </Button>
        </div>
      </div>
    </div>
  );
}
