/**
 * IdTag — the small mono "public ID" chip shown to the RIGHT of a companion's
 * name (chat header + CharacterPage). 260703 procgen (spec item 7): every cloud
 * companion is assigned a 4-char public_id (A-Z / 0-9) that replaces the raw
 * UUID in user-facing surfaces. Rendered as a dim, bordered mono chip (e.g.
 * `K7Q2`). Purely presentational — callers gate on `character.public_id != null`.
 */

import React from 'react';
import styles from './IdTag.module.css';

export interface IdTagProps {
  /** The 4-char public id (already validated as [A-Z0-9]{4} at the boundary). */
  id: string;
  /** sm (chat header) / md (page title). Default 'sm'. */
  size?: 'sm' | 'md';
}

export function IdTag({ id, size = 'sm' }: IdTagProps): React.ReactElement {
  return (
    <span
      className={`${styles.tag} ${size === 'md' ? styles.md : styles.sm}`}
      aria-label={`Public ID ${id}`}
      title={`Public ID · ${id}`}
    >
      {id}
    </span>
  );
}
