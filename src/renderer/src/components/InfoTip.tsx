/**
 * InfoTip — a small circular "(i)" affordance that reveals a short description
 * on hover / keyboard focus. Used to tuck helper copy out of the way (e.g. in
 * Settings) so rows stay compact, while the explanation is one hover away.
 *
 * The tooltip is a CSS-only popover (no portal); it anchors to the dot's left
 * edge and grows rightward so it never overflows the left gutter. Pair it with
 * a label via `aria-label` (defaults to "More info").
 *
 * Inline mode (quiet register, product call 261110): inside an
 * `InfoTipInline` provider (Settings) the same text renders as a visible help
 * line under the label instead of behind an "i", so nothing is easy to miss.
 * Call sites stay the same; the screen decides.
 */

import React, { createContext, useContext } from 'react';
import { useT } from '../lib/i18n';
import styles from './InfoTip.module.css';

export interface InfoTipProps {
  /** The description shown in the popover. */
  text: string;
  /** Accessible name for the button (e.g. "About Looking (vision)"). */
  label?: string;
}

const InlineContext = createContext(false);

/** Render every InfoTip below as an always-visible help line. */
export function InfoTipInline({ children }: { children: React.ReactNode }): React.ReactElement {
  return <InlineContext.Provider value={true}>{children}</InlineContext.Provider>;
}

export function InfoTip({ text, label = 'More info' }: InfoTipProps): React.ReactElement {
  const t = useT();
  const inline = useContext(InlineContext);
  if (inline) {
    return (
      <span className={styles.inlineHelp} data-infotip-inline="">
        {text}
      </span>
    );
  }
  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.dot} aria-label={t(label)}>
        i
      </button>
      <span className={styles.tip} role="tooltip">
        {text}
      </span>
    </span>
  );
}
