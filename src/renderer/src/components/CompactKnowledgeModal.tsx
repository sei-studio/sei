/**
 * CompactKnowledgeModal — shown when the create flow detects a large amount
 * of imported knowledge (over the compact-suggest threshold). Offers to
 * LLM-compress the stored copies into one compact file; the user's original
 * files on disk are never touched (the app only ever stores copies made at
 * upload time).
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

export interface CompactKnowledgeModalProps {
  totalKb: number;
  onKeep: () => void;
  onCompact: () => void;
  onCancel: () => void;
}

export function CompactKnowledgeModal({
  totalKb,
  onKeep,
  onCompact,
  onCancel,
}: CompactKnowledgeModalProps): React.ReactElement {
  return (
    <ModalShell title="Compact memory?" onClose={onCancel} width={440}>
      <p className={styles.body}>
        We detected a large amount of files ({totalKb} KB), which can slow down the AI's
        responses on calls and in games. We can compress them for you if you'd like.
      </p>
      <p className={styles.body}>
        Only Sei's copy is compressed. The original files on your computer are not changed.
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onKeep}>
          Keep files as they are
        </Button>
        <Button kind="accent" size="md" onClick={onCompact}>
          Compress and create
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
