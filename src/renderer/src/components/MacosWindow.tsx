/**
 * MacosWindow / AppWindow — outer chrome.
 *
 * 1180×760 with sharp corners + --shadow-window. Top bar 38px, title centered
 * "Sei · {subtitle}". macOS draws REAL traffic-light buttons in the inset
 * position (we do NOT render the mockup's decorative-traffic-light JSX — D-32
 * + UI-SPEC line 336). Title bar is drag-region; inner buttons explicitly opt
 * out via -webkit-app-region: no-drag in their CSS.
 *
 * macOS reserves ~80px on the left of the title bar (CSS padding) so the
 * centered title doesn't collide with OS-drawn traffic lights.
 *
 * Source: 04-UI-SPEC.md §Component Inventory → MacosWindow/AppWindow + D-32.
 */

import React from 'react';
import styles from './MacosWindow.module.css';

interface MacosWindowProps {
  subtitle?: string | null;
  children?: React.ReactNode;
}

export function MacosWindow({ subtitle, children }: MacosWindowProps): React.ReactElement {
  return (
    <div className={styles.window}>
      <div className={styles.titleBar}>
        <div className={styles.titleCenter}>
          <span>Sei</span>
          {subtitle ? (
            <>
              <span className={styles.dot}>·</span>
              <span className={styles.subtitle}>{subtitle}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
