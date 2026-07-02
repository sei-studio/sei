/**
 * ResetMemoryConfirmModal — confirm dialog for the per-character "Reset memory"
 * action. Reset only clears what the character remembers (the app-side memory
 * dir); it CANNOT touch the bot's in-game inventory or position, which live in
 * the Minecraft world save on the LAN host (offline-mode playerdata, keyed by
 * the in-game username) — the app has no path to that save. The copy is
 * explicit about that so the user isn't surprised, and points at the only real
 * ways to reset game state (do it in-world, or start a fresh world).
 *
 * Structure + styling mirror DeleteConfirmModal (shared module). ESC / Cancel
 * dismiss; the confirm button runs the reset.
 */

import React, { useEffect } from 'react';
import { Button } from './Button';
import styles from './DeleteConfirmModal.module.css';

export interface ResetMemoryConfirmModalProps {
  characterName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ResetMemoryConfirmModal({
  characterName,
  onCancel,
  onConfirm,
}: ResetMemoryConfirmModalProps): React.ReactElement {
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
      aria-labelledby="reset-memory-confirm-title"
    >
      <div className={styles.modal}>
        <h2 id="reset-memory-confirm-title" className={styles.title}>
          Reset {characterName}&apos;s memory?
        </h2>
        <p className={styles.body}>
          This will reset everything this companion remembers about you. It will not reset their
          in-game inventory and location within a world. Please reset manually or create a new world
          to start fresh.
        </p>
        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button kind="danger" size="md" onClick={onConfirm}>
            Reset memory
          </Button>
        </div>
      </div>
    </div>
  );
}
