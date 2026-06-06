/**
 * AddCard — dashed "New character" tile that ends the home grid.
 *
 * Source: 04-UI-SPEC.md §AddCard + 04-07 Task 1.
 */

import React from 'react';
import { PlusIcon } from './icons';
import styles from './AddCard.module.css';

export interface AddCardProps {
  onClick: () => void;
}

export function AddCard({ onClick }: AddCardProps): React.ReactElement {
  return (
    <button
      type="button"
      className={styles.card}
      onClick={onClick}
      aria-label="Add new character"
    >
      <div className={styles.iconTile}>
        <PlusIcon size={26} />
      </div>
      <div className={styles.label}>New character</div>
    </button>
  );
}
