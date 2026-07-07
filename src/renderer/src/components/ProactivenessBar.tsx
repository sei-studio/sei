/**
 * ProactivenessBar — segmented meter for a character's proactiveness dial
 * (0–3, least → most proactive). Read-only display variant used on the
 * character detail page; EditCharacterModal renders its own interactive
 * picker. Segments up to and including the level are filled in --accent; the
 * rest read as empty track.
 *
 * Each segment is its own hover/focus target carrying a per-level tooltip (one
 * sentence on what to expect in game). The bubble is rendered through a PORTAL
 * to <body> as a position:fixed element, anchored ABOVE the hovered segment
 * from its getBoundingClientRect(). This is deliberate and load-bearing: the
 * bar lives inside the detail panel's `overflow-y:auto / overflow-x:hidden`
 * scroll box, which clips (and re-stacks) anything a normal absolutely-
 * positioned child tries to draw outside it — that's what tucked the old
 * ::after bubble below the bar and behind the Play button. A fixed, body-level
 * bubble escapes that clip and every stacking context, so the copy always
 * floats above the bar and sizes to its text. `block` stretches the bar to
 * fill its container (used in the detail-page stat cell).
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
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

interface TipState {
  text: string;
  /** Viewport coordinates: horizontal center + top edge of the segment. */
  cx: number;
  top: number;
}

/** Half the bubble's max-width, plus a margin — keeps it inside the viewport. */
const TIP_HALF = 140;

export function ProactivenessBar({
  level,
  size = 'sm',
  showLabel = false,
  block = false,
}: ProactivenessBarProps): React.ReactElement {
  const info = proactivenessLevel(level);
  const [tip, setTip] = useState<TipState | null>(null);

  const open = (el: HTMLElement, text: string): void => {
    const r = el.getBoundingClientRect();
    // Clamp the horizontal anchor so a segment near a screen edge can't push
    // the (viewport-fixed) bubble off-screen.
    const cx = Math.min(Math.max(r.left + r.width / 2, TIP_HALF), window.innerWidth - TIP_HALF);
    setTip({ text, cx, top: r.top });
  };
  const close = (): void => setTip(null);

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
        {PROACTIVENESS_LEVELS.map((lvl) => {
          const text = `${lvl.label}: ${lvl.blurb}`;
          return (
            <span
              key={lvl.value}
              className={`${styles.seg} ${lvl.value <= level ? styles.on : ''}`}
              tabIndex={0}
              aria-label={text}
              onMouseEnter={(e) => open(e.currentTarget, text)}
              onMouseLeave={close}
              onFocus={(e) => open(e.currentTarget, text)}
              onBlur={close}
            />
          );
        })}
      </div>
      {showLabel ? (
        <span
          className={`${styles.label} ${info.value === PROACTIVENESS_COUNT - 1 ? styles.labelAccent : ''}`}
        >
          {info.label}
        </span>
      ) : null}
      {tip
        ? createPortal(
            <div
              className={styles.tip}
              role="tooltip"
              style={{ left: `${tip.cx}px`, top: `${tip.top}px` }}
            >
              {tip.text}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
