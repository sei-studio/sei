/**
 * PercentBar — accessible progress-bar primitive (Phase 13 Plan 18).
 *
 * Reusable across CreditsScreen (lg), analytics surfaces (md), and any future
 * inline micro-bar (sm). The progressbar ARIA role + `aria-valuenow` makes
 * the value screen-reader accessible; the visible numeric label is rendered
 * for sighted users on md/lg sizes only.
 *
 * Value is clamped to [0, 100] defensively so an upstream rounding glitch in
 * the proxy (`X-Sei-Remaining-Pct` should be 0..100 per D-41) can't paint a
 * fill rect that overflows the track or goes negative.
 *
 * Source: 13-18-PLAN.md (Task 1) + 13-PATTERNS.md §components/PercentBar.
 */

import React from 'react';
import styles from './PercentBar.module.css';

export interface PercentBarProps {
  /** 0..100. Clamped defensively. */
  value: number;
  /**
   * Optional accessible label. Defaults to "{value} percent" if not provided
   * — sufficient for the icon-rail micro-bar but consumers like CreditsScreen
   * pass richer phrasing.
   */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function PercentBar({ value, label, size = 'lg' }: PercentBarProps): React.ReactElement {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      className={`${styles.root} ${styles[size]}`}
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `${v} percent`}
    >
      <div className={styles.fill} style={{ width: `${v}%` }} />
      <span className={styles.label}>{v}%</span>
    </div>
  );
}
