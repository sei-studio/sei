/**
 * UnbindConfirmModal — confirm dialog for the CharacterPage "Unbind"/"Release"
 * action (260704). Unbinding drops a companion out of the user's library (a
 * default returns to the World tab unless re-invited; an added-from-World
 * companion is uncached locally; a custom/unique companion is deleted) — it's
 * destructive to the library slot but NOT to the companion's memory, which is
 * why the copy reassures the user their saved memories aren't wiped.
 *
 * Renders through ModalShell; Esc / Cancel dismiss, the danger button runs the
 * unbind.
 */

import React from 'react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './confirmModal.module.css';

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
  const t = useT();
  return (
    <ModalShell title={t('Unbind {name}?', { name: characterName })} onClose={onCancel}>
      <p className={styles.body}>
        {t('{name} will be released from your party. Their memories stay with them.', {
          name: characterName,
        })}
      </p>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button kind="danger" size="md" onClick={onConfirm}>
          {t('Unbind {name}', { name: characterName })}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
