/**
 * InfoTip — a small circular "(i)" affordance that reveals a short description
 * on hover / keyboard focus. Used to tuck helper copy out of the way (e.g. in
 * Settings) so rows stay compact, while the explanation is one hover away.
 *
 * The tooltip is a CSS-only popover (no portal); it anchors to the dot's left
 * edge and grows rightward so it never overflows the left gutter. Pair it with
 * a label via `aria-label` (defaults to "More info").
 */

import React from 'react';
import styles from './InfoTip.module.css';

export interface InfoTipProps {
  /** The description shown in the popover. */
  text: string;
  /** Accessible name for the button (e.g. "About Looking (vision)"). */
  label?: string;
}

export function InfoTip({ text, label = 'More info' }: InfoTipProps): React.ReactElement {
  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.dot} aria-label={label}>
        i
      </button>
      <span className={styles.tip} role="tooltip">
        {text}
      </span>
    </span>
  );
}
