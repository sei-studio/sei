/**
 * Seg — segmented control (mockup .seg). A bordered row of small options,
 * active option gets accent-soft fill + accent text. Replaces aria-pressed
 * ghost-button groups (theme, backend, vision mode).
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §1.
 */

import React from 'react';
import styles from './Seg.module.css';

export interface SegOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SegProps<T extends string> {
  options: SegOption<T>[];
  value: T;
  onChange: (next: T) => void;
  'aria-label': string;
  disabled?: boolean;
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ...rest
}: SegProps<T>): React.ReactElement {
  return (
    <div className={styles.seg} role="radiogroup" aria-label={rest['aria-label']}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled || o.disabled}
          className={[styles.opt, o.value === value ? styles.on : ''].filter(Boolean).join(' ')}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
