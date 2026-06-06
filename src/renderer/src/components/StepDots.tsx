/**
 * StepDots — onboarding / add-character progress indicator.
 *
 * Source: 04-UI-SPEC.md §Component Inventory → StepDots + D-36.
 * Active dot 22×6 in --accent; past dot 6×6 in --text-2; future dot 6×6 in --border-strong.
 */

import React from 'react';
import styles from './StepDots.module.css';

interface StepDotsProps {
  count: number;
  current: number;
}

export function StepDots({ count, current }: StepDotsProps): React.ReactElement {
  return (
    <div className={styles.row} role="progressbar" aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={current}>
      {Array.from({ length: count }).map((_, i) => {
        const cls =
          i === current ? styles.active : i < current ? styles.past : styles.future;
        return <div key={i} className={`${styles.dot} ${cls}`} />;
      })}
    </div>
  );
}
