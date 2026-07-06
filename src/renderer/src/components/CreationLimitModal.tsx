/**
 * CreationLimitModal — informational notice shown when a user has hit the
 * daily character-creation cap (the proxy's persona_daily limit).
 *
 * Surfaced BEFORE the new-character flow (CharactersScreen → "New" / AddCard)
 * so a maxed-out user never enters the steps only to fail mid-expansion. Also
 * reused as the graceful landing if the cap is hit mid-flow (a rare race).
 *
 * Dismissible (Esc / scrim click / button) — this is informational, NOT a
 * blocking hard-stop like HardStopModal. Renders through ModalShell.
 */
import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './CreationLimitModal.module.css';

export interface CreationLimitModalProps {
  /** ISO timestamp the daily window resets, if known — shown as a hint. */
  resetsAt?: string | null;
  onClose: () => void;
}

export function CreationLimitModal({
  resetsAt,
  onClose,
}: CreationLimitModalProps): React.ReactElement {
  const resetHint = ((): string | null => {
    if (!resetsAt) return null;
    const t = new Date(resetsAt);
    if (Number.isNaN(t.getTime())) return null;
    return t.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  })();

  return (
    <ModalShell title="Daily limit reached" onClose={onClose} scrimClose>
      <p className={styles.body}>
        You&rsquo;ve reached your limit for companion creation today. Come back tomorrow.
      </p>
      {resetHint ? <p className={styles.hint}>Resets {resetHint}</p> : null}
      <ModalFooter>
        <Button kind="primary" onClick={onClose}>
          Got it
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
