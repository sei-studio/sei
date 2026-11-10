/**
 * AddCount — the quiet "added by N players" number on World cards and on a
 * character profile opened from World (product call 261110). A person glyph
 * plus a compact count ("1.2K"); the full number is in the tooltip and the
 * accessible label. Renders nothing for 0 or an unknown count.
 *
 * Not a button and no border (house rule): it is a label.
 *
 * Hidden everywhere while SHOW_ADD_COUNTS (shared/addCounts.ts) is false
 * (product call 261110): flip that one constant to bring it back.
 */

import React from 'react';
import { useLangStore, useT } from '../lib/i18n';
import { uiLocaleTag } from '@shared/uiLanguage';
import { formatAddCount } from '../lib/worldList';
import { SHOW_ADD_COUNTS } from '@shared/addCounts';
import { UserIcon } from './icons';
import styles from './AddCount.module.css';

export interface AddCountProps {
  count: number | null | undefined;
  /** 'card' = light text over the card scrim; 'page' = muted text on the profile. */
  variant: 'card' | 'page';
}

export function AddCount({ count, variant }: AddCountProps): React.ReactElement | null {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const shown = formatAddCount(count, uiLocaleTag(lang));
  if (!SHOW_ADD_COUNTS || shown === null || count == null) return null;
  const n = Math.floor(count);
  const label = n === 1 ? t('Added by 1 player') : t('Added by {n} players', { n });
  return (
    <span
      className={`${styles.count} ${variant === 'card' ? styles.card : styles.page}`}
      title={label}
      aria-label={label}
      role="img"
    >
      <UserIcon size={variant === 'card' ? 12 : 13} />
      <span className={styles.num} aria-hidden="true">
        {shown}
      </span>
    </span>
  );
}
