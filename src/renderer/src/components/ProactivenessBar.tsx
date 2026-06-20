/**
 * ProactivenessBar — segmented meter for a character's proactiveness dial
 * (0–3, least → most proactive). Read-only display variant used on the
 * character detail page; EditCharacterModal renders its own interactive
 * picker. Segments up to and including the level are filled in --accent; the
 * rest read as empty track.
 *
 * Each segment is its own hover target carrying a per-level tooltip (one
 * sentence on what to expect in game), so a user can hover any rung to learn
 * what that level means — not just the selected one. `block` stretches the bar
 * to fill its container (used in the detail-page stat cell).
 */
import React from 'react';
import {
  PROACTIVENESS_COUNT,
  PROACTIVENESS_LEVELS,
  proactivenessLevel,
} from '../lib/proactiveness';
import styles from './ProactivenessBar.module.css';

export interface ProactivenessBarProps {
  level: number;
  size?: 'sm' | 'md';
  /** Show the level name to the right of the bar. */
  showLabel?: boolean;
  /** Stretch the bar to fill the width of its container. */
  block?: boolean;
}

export function ProactivenessBar({
  level,
  size = 'sm',
  showLabel = false,
  block = false,
}: ProactivenessBarProps): React.ReactElement {
  const info = proactivenessLevel(level);
  return (
    <div
      className={`${styles.root} ${styles[size]} ${block ? styles.block : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={PROACTIVENESS_COUNT - 1}
      aria-valuenow={level}
      aria-label={`Proactiveness: ${info.label}`}
    >
      <div className={styles.track}>
        {PROACTIVENESS_LEVELS.map((lvl) => (
          <span
            key={lvl.value}
            className={`${styles.seg} ${lvl.value <= level ? styles.on : ''}`}
            data-tip={`${lvl.label} — ${lvl.blurb}`}
            tabIndex={0}
            aria-label={`${lvl.label}: ${lvl.blurb}`}
          />
        ))}
      </div>
      {showLabel ? (
        <span
          className={`${styles.label} ${info.value === PROACTIVENESS_COUNT - 1 ? styles.labelAccent : ''}`}
        >
          {info.label}
        </span>
      ) : null}
    </div>
  );
}
