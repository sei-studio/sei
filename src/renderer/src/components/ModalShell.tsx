/**
 * ModalShell — the single modal primitive (Party redesign).
 *
 * Every modal in the app renders through this shell so scrim color, panel
 * surface, padding, title type, mount animation, Esc and click-outside rules
 * live in exactly one place. Modals supply body content and a footer of
 * Buttons; the shell owns everything around them.
 *
 * z-index tiers (keep to these three):
 *   1000 base (default) · 1100 stacked-above · 1200 recovery.
 *
 * Source: docs/design/UI-REDESIGN-PARTY.md §1 (ModalShell).
 */

import React, { useEffect } from 'react';
import styles from './ModalShell.module.css';

interface ModalShellProps {
  /** Accessible + visible title (Oswald, the title step). Pass null to omit the header. */
  title: string | null;
  /** Panel width in px (default 440; never narrower than 440 since 261110). */
  width?: number;
  /** Esc closes (default true). Set false while submitting / for blocking gates. */
  escClose?: boolean;
  /** Clicking the scrim closes (default false — opt in for casual dialogs). */
  scrimClose?: boolean;
  /** z-index tier: 'base' 1000 · 'stacked' 1100 · 'recovery' 1200. */
  tier?: 'base' | 'stacked' | 'recovery';
  onClose?: () => void;
  children: React.ReactNode;
  /** Optional extra class for the panel (layout overrides, e.g. two-column). */
  panelClassName?: string;
  'aria-label'?: string;
}

const MIN_WIDTH = 440;

const TIER_Z: Record<'base' | 'stacked' | 'recovery', number> = {
  base: 1000,
  stacked: 1100,
  recovery: 1200,
};

export function ModalShell({
  title,
  width = MIN_WIDTH,
  escClose = true,
  scrimClose = false,
  tier = 'base',
  onClose,
  children,
  panelClassName,
  ...rest
}: ModalShellProps): React.ReactElement {
  useEffect(() => {
    if (!escClose || !onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escClose, onClose]);

  const titleId = title ? 'modal-shell-title' : undefined;

  return (
    <div
      className={styles.scrim}
      // 261105 (T336): --sei-modal-lift lifts every modal over a fullscreen surface
      // that sets it (the room editor, z 2000), so a usage wall or the call
      // inactivity check is never hidden behind it.
      style={{ zIndex: `calc(${TIER_Z[tier]} + var(--sei-modal-lift, 0))` as unknown as number }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-label={rest['aria-label']}
      onMouseDown={(e) => {
        if (scrimClose && onClose && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={[styles.panel, panelClassName ?? ''].filter(Boolean).join(' ')}
        // Quiet register (261110): 440 is the narrowest panel; the body step
        // (18px) wraps too often in the old 380-420 widths.
        style={{ width: Math.max(width, MIN_WIDTH) }}
      >
        {title ? (
          <h3 id={titleId} className={styles.title}>
            {title}
          </h3>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** Standard right-aligned footer row for ModalShell dialogs. */
export function ModalFooter({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className={styles.footer}>{children}</div>;
}
