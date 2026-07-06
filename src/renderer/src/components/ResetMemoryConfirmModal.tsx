/**
 * ResetMemoryConfirmModal — confirm dialog for the per-character "Reset memory"
 * action. Reset only clears what the character remembers (the app-side memory
 * dir); it CANNOT touch the bot's in-game inventory or position, which live in
 * the Minecraft world save on the LAN host (offline-mode playerdata, keyed by
 * the in-game username) — the app has no path to that save. The copy is
 * explicit about that so the user isn't surprised, and points at the only real
 * ways to reset game state (do it in-world, or start a fresh world).
 *
 * Renders through ModalShell; Esc / Cancel dismiss, the danger button runs the
 * reset.
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

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
  return (
    <ModalShell title={`Reset ${characterName}'s memory?`} onClose={onCancel}>
      <p className={styles.body}>
        This will reset everything this companion remembers about you, including your chat
        history. It will not reset their in-game inventory and location within a world. Please
        reset manually or create a new world to start fresh.
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button kind="danger" size="md" onClick={onConfirm}>
          Reset memory
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
