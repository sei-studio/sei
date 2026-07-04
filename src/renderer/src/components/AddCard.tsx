/**
 * AddCard — dashed "add" tile.
 *
 * 'grid' variant (default): the classic tall portrait-footprint tile that ends
 * a fixed-aspect grid.
 * 'slot' variant (260703 procgen): stretches to fill an empty Home companion
 * slot's full height and reads "Summon a companion".
 *
 * Source: 04-UI-SPEC.md §AddCard + 04-07 Task 1.
 */

import React from 'react';
import { PlusIcon } from './icons';
import styles from './AddCard.module.css';

export interface AddCardProps {
  onClick: () => void;
  /** Label under the plus icon. Defaults to "New companion". */
  label?: string;
  /** Layout variant — see module docblock. Default 'grid'. */
  variant?: 'grid' | 'slot';
}

export function AddCard({
  onClick,
  label = 'New companion',
  variant = 'grid',
}: AddCardProps): React.ReactElement {
  return (
    <button
      type="button"
      className={`${styles.card} ${variant === 'slot' ? styles.slot : ''}`}
      onClick={onClick}
      aria-label={label}
    >
      <div className={styles.iconTile}>
        <PlusIcon size={26} />
      </div>
      <div className={styles.label}>{label}</div>
    </button>
  );
}
