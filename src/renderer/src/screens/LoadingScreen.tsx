/**
 * LoadingScreen — boot screen.
 *
 * Source: 04-UI-SPEC.md §Screen Inventory → LoadingScreen + D-35.
 * Cover full window in --window. Recolored Sei mark (220px wide) via mask-image
 * of /img/sei-logo-small.svg tinted --accent. Three blinking dots staggered 160ms.
 *
 * Lifetime: at least 1.6s (LOADING_FLOOR_MS in App.tsx) — the actual boot
 * orchestration lives in App.tsx; this component just renders the visuals.
 */

import React from 'react';
import styles from './LoadingScreen.module.css';

export function LoadingScreen(): React.ReactElement {
  return (
    <div className={styles.root}>
      <div className={styles.mark} aria-label="Sei" role="img" />
      <div className={styles.dots} aria-hidden="true">
        <span style={{ animationDelay: '0ms' }} />
        <span style={{ animationDelay: '160ms' }} />
        <span style={{ animationDelay: '320ms' }} />
      </div>
    </div>
  );
}
