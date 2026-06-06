/**
 * DeleteConfirmModal — sharp-cornered confirm dialog for character deletion.
 *
 * Lifted from LanModal styling (UI-SPEC §Character delete-gating). Title and
 * body copy are verbatim from the spec.
 *
 * The destructive button is rendered as a plain <button> with the --red
 * background override (D-49: Delete only when `id !== 'sui'`; that gate is
 * enforced by the caller — this component only renders the confirm UI).
 *
 * ESC and Cancel both invoke `onCancel`.
 *
 * Source: 04-UI-SPEC.md §Character delete-gating + Copywriting Contract.
 */

import React, { useEffect } from 'react';
import { Button } from './Button';
import styles from './DeleteConfirmModal.module.css';

export interface DeleteConfirmModalProps {
  characterName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmModal({
  characterName,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps): React.ReactElement {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div className={styles.modal}>
        <h2 id="delete-confirm-title" className={styles.title}>
          Delete {characterName}?
        </h2>
        <p className={styles.body}>
          This permanently removes their persona, description, and saved memory. You can&apos;t undo
          this.
        </p>
        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <button type="button" className={styles.deleteBtn} onClick={onConfirm}>
            Delete {characterName}
          </button>
        </div>
      </div>
    </div>
  );
}
