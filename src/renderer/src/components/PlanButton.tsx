/**
 * PlanButton — the big buy / upgrade button on every place a Sei plan or a
 * credit pack is picked (261023): the plan cards on the Credits screen, the
 * extra-credit packages (TopUpModal) and the usage-limit popup's Upgrade.
 *
 * Shawn, 261023: the old buttons were small (Button size sm, ~26px) and hard
 * to aim at, which adds friction right where someone is trying to pay. So the
 * primary is full width, 44-48px tall, a flat fill of its own brighter
 * --plan-cta tone (261027: no top highlight, no dark gradient band, no
 * shadow) with the old Summon button's travelling glint looping across it
 * every 1.8s (261027), and answers the pointer: a
 * step toward --accent-strong and a lift on hover, a press-down on click, an
 * arrow that nudges forward. Reduced motion keeps the colour change and drops
 * the movement and the glint. Sharp corners like every Button (D-28).
 *
 * `secondary` is the quiet sibling at the SAME height (Downgrade, Current
 * plan, Top up beside Upgrade), so the cards' buttons line up and only one
 * button per card is loud.
 *
 * Only the look lives here: callers keep their own click handlers, so no
 * checkout logic moves.
 */

import React, { useLayoutEffect, useRef } from 'react';
import { ArrowIcon } from './icons';
import styles from './PlanButton.module.css';

export interface PlanButtonProps {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  kind?: 'primary' | 'secondary';
  /** md = 44px (modals), lg = 48px (plan cards). */
  size?: 'md' | 'lg';
  /** Trailing arrow, for actions that move the user on (checkout, plans). */
  arrow?: boolean;
  /** Leading icon (e.g. the check on "Current plan"). */
  icon?: React.ReactNode;
  disabled?: boolean;
  'aria-label'?: string;
  title?: string;
}

export function PlanButton({
  children,
  onClick,
  kind = 'primary',
  size = 'lg',
  arrow = false,
  icon,
  disabled,
  title,
  ...rest
}: PlanButtonProps): React.ReactElement {
  const cls = [styles.button, styles[kind], styles[size]].join(' ');
  const ref = useRef<HTMLButtonElement>(null);
  // Every glint on screen sweeps at the same moment (Shawn, 261027). A CSS
  // animation starts when its element mounts or is re-enabled, so a button
  // that appears later (the usage-limit popup over the plan cards, a card
  // that turns primary when the plan loads) would run out of step. Pinning
  // the glint's start to the document timeline's zero puts them all on one
  // shared phase; the duration (and --flux) still come from the CSS.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.getAnimations !== 'function') return;
    for (const a of el.getAnimations({ subtree: true })) {
      if (a instanceof CSSAnimation && a.animationName.includes('plan-glint')) a.startTime = 0;
    }
  }, [kind, disabled]);
  return (
    <button
      ref={ref}
      type="button"
      className={cls}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={rest['aria-label']}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {arrow ? (
        <span className={styles.arrow} aria-hidden="true">
          <ArrowIcon size={16} />
        </span>
      ) : null}
    </button>
  );
}

/** Small check mark for the "Current plan" state. */
export function PlanCheckIcon(): React.ReactElement {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
