/**
 * CreationLimitModal — informational notice shown when a user has hit the
 * daily character-creation cap (the proxy's persona_daily limit).
 *
 * Surfaced BEFORE the new-character flow (CharactersScreen → "New" / AddCard)
 * so a maxed-out user never enters the steps only to fail mid-expansion. Also
 * reused as the graceful landing if the cap is hit mid-flow (a rare race).
 *
 * Dismissible (ESC / scrim click / button) — this is informational, NOT a
 * blocking hard-stop like HardStopModal. Visual idiom mirrors
 * HardStopModal/AcceptToSModal (same frame, tokens only — no literal values).
 */
import React, { useEffect, useId } from 'react';
import { Button } from './Button';
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
  const titleId = useId();

  // ESC closes — dismissible (unlike the blocking HardStopModal, which
  // suppresses ESC). Listener mounts/unmounts with the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} className={styles.title}>
          Daily limit reached
        </h2>
        <p className={styles.body}>
          You&rsquo;ve reached your limit for character creation today. Come back
          tomorrow.
        </p>
        {resetHint ? <p className={styles.hint}>Resets {resetHint}</p> : null}
        <div className={styles.footer}>
          <Button kind="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
