/**
 * SummonConflictModal — multi-summon guard popup.
 *
 * Shown when the user tries to summon a character whose in-game Minecraft
 * username matches one that's already in the world. Two bots can't share a
 * username — the server kicks the second with `name_taken` — so we block the
 * summon and explain why. Dismiss-only (no destructive action); the user
 * resolves it by giving one persona a different in-game username on its page.
 *
 * Modeled on the IconRail "Switch to cloud?" prompt (scrim + centered panel).
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { useUiStore } from '../lib/stores/useUiStore';
import styles from './SummonConflictModal.module.css';

export interface SummonConflictModalProps {
  attemptedName: string;
  conflictName: string;
  username: string;
}

export function SummonConflictModal({
  attemptedName,
  conflictName,
  username,
}: SummonConflictModalProps): React.ReactElement {
  const closeModal = useUiStore((s) => s.closeModal);
  return (
    <ModalShell
      title="Name already in use"
      width={420}
      scrimClose
      onClose={closeModal}
      aria-label="Name already in use"
    >
      <p className={styles.body}>
        <strong>{attemptedName}</strong> wants to join as{' '}
        <span className={styles.username}>{username}</span>, but{' '}
        <strong>{conflictName}</strong> is already in the world under that name.
        Minecraft won&apos;t let two players share a username.
      </p>
      <p className={styles.hint}>
        Give one of them a different in-game username (on its companion page,
        under Skin) and try again.
      </p>
      <ModalFooter>
        <Button kind="accent" size="md" onClick={closeModal}>
          Got it
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
