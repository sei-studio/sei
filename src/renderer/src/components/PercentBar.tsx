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
import { useT } from '../lib/i18n';
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
  /**
   * Fill tone. 'accent' is the default primary bar; 'muted' is the quieter
   * secondary bar used for the extra-credits row so it never competes with the
   * weekly-allowance hero above it.
   */
  tone?: 'accent' | 'muted';
  /**
   * 260724: the weekly allowance is spent. The fill turns red so a full bar
   * reads as a limit, not as an achievement. Overrides `tone`.
   */
  overLimit?: boolean;
  /** Hide the centred numeric label (the row already spells the value out). */
  hideLabel?: boolean;
}

export function PercentBar({
  value,
  label,
  size = 'lg',
  tone = 'accent',
  overLimit = false,
  hideLabel = false,
}: PercentBarProps): React.ReactElement {
  const t = useT();
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const fillTone = overLimit ? styles.fillOver : tone === 'muted' ? styles.fillMuted : '';
  return (
    <div
      className={`${styles.root} ${styles[size]}`}
      role="progressbar"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? t('{value} percent', { value: v })}
    >
      <div className={`${styles.fill} ${fillTone}`} style={{ width: `${v}%` }} />
      {hideLabel ? null : <span className={styles.label}>{v}%</span>}
    </div>
  );
}
