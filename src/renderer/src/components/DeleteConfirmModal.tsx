/**
 * DeleteConfirmModal — sharp-cornered confirm dialog for character deletion.
 *
 * Renders through ModalShell (Party redesign): the shell owns scrim, panel,
 * title, Esc and the mount animation; this file supplies body copy and the
 * footer. The destructive action uses Button kind="danger". Title and body copy
 * are verbatim from the spec.
 *
 * D-49 note: Delete is only offered when `id !== 'sui'`; that gate is enforced
 * by the caller — this component only renders the confirm UI.
 *
 * Esc and Cancel both invoke `onCancel`.
 */

import React from 'react';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

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
  return (
    <ModalShell title={`Unbind ${characterName}?`} onClose={onCancel}>
      <p className={styles.body}>
        This permanently removes their persona, description, and saved memory. You can&apos;t undo
        this.
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button kind="danger" size="md" onClick={onConfirm}>
          Unbind {characterName}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
