/**
 * UnbindConfirmModal — confirm dialog for the CharacterPage gear menu's
 * "Unbind" action (260704). Unbinding drops a companion out of the user's
 * library (a default returns to the World tab unless re-invited; an
 * added-from-World companion is uncached locally; a custom/unique companion
 * is deleted) — it's destructive to the library slot but NOT to the
 * companion's memory, which is why the copy reassures the user their
 * saved memories aren't wiped.
 *
 * Structure + styling mirror DeleteConfirmModal / ResetMemoryConfirmModal
 * (shared module). ESC / Cancel dismiss; the confirm button runs the unbind.
 */

import React, { useEffect } from 'react';
import { Button } from './Button';
import styles from './DeleteConfirmModal.module.css';

export interface UnbindConfirmModalProps {
  characterName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function UnbindConfirmModal({
  characterName,
  onCancel,
  onConfirm,
}: UnbindConfirmModalProps): React.ReactElement {
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
      aria-labelledby="unbind-confirm-title"
    >
      <div className={styles.modal}>
        <h2 id="unbind-confirm-title" className={styles.title}>
          Unbind {characterName}?
        </h2>
        <p className={styles.body}>
          {characterName} will be released from your library. Their memories stay with them.
        </p>
        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button kind="danger" size="md" onClick={onConfirm}>
            Unbind {characterName}
          </Button>
        </div>
      </div>
    </div>
  );
}
