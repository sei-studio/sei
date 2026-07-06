/**
 * Presence — dot + status line (mockup .presence). One component renders the
 * five presence categories with their canonical colors so every surface
 * (party wall, chat panel, profile, widgets) stays identical.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §2.
 */

import React from 'react';
import styles from './Presence.module.css';
import type { PresenceCategory } from '../lib/presence';

interface PresenceProps {
  category: PresenceCategory;
  /** Status copy; defaults come from lib/presence PRESENCE labels. */
  label: string;
  className?: string;
}

const CATEGORY_CLASS: Record<PresenceCategory, string> = {
  'in-game': styles.inGame,
  connecting: styles.connecting,
  new: styles.isNew,
  online: styles.online,
  idle: styles.idle,
};

export function Presence({ category, label, className }: PresenceProps): React.ReactElement {
  return (
    <span
      className={[styles.presence, CATEGORY_CLASS[category], className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
