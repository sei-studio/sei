/**
 * BrowseCard — public-character grid card (World tab).
 *
 * Composes CharacterCard.module.css primitives (.card / .bg / .portraitWrap /
 * .scrim / .meta / .name / .metaLine / .hoverOverlay / .bar) so the World grid
 * reads identically to Home — just with a public surface and a creator
 * attribution line instead of a summon status. When the entry is already in
 * the user's library, a hover pill says so.
 *
 * Lean-component contract (CONTEXT D-31c): does NOT subscribe to auth/sync/cloud
 * stores — `inMyLibrary` is precomputed by main against local-file presence.
 *
 * Pitfall 7 (12-RESEARCH.md): any inner action button MUST stopPropagation.
 *
 * Source: .planning/UI-DESIGN-SYSTEM.md §Cards; 12-11-PLAN.md.
 */

import React from 'react';
import type { BrowseEntry } from '@shared/ipc';
import { PixelPortrait } from './PixelPortrait';
import { pickPalette } from '../lib/portraitPalettes';
import characterStyles from './CharacterCard.module.css';
import styles from './BrowseCard.module.css';

export interface BrowseCardProps {
  entry: BrowseEntry;
  theme: 'light' | 'dark';
  onOpen: () => void;
  /**
   * Fired on hover / focus to warm the cache-on-demand path (character row +
   * skin + portrait) so the subsequent open is instant. Fire-and-forget and
   * idempotent — the parent dedupes; main's in-flight guard + existsSync make
   * a no-op cheap. Optional so other callers can omit it.
   */
  onPrefetch?: () => void;
}

export function BrowseCard({
  entry,
  theme,
  onOpen,
  onPrefetch,
}: BrowseCardProps): React.ReactElement {
  const palette = pickPalette(entry.id + entry.name, theme);
  const tint = palette[2] ?? palette[1] ?? 'var(--accent)';

  return (
    <div
      className={`${characterStyles.card} ${styles.cardExtras}`}
      onClick={onOpen}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open ${entry.name}`}
    >
      <div
        className={characterStyles.bg}
        style={{
          background: `radial-gradient(120% 80% at 50% 22%, ${tint}6b, transparent 62%),
                       linear-gradient(180deg, var(--card-top), var(--card-bottom))`,
        }}
      />
      <div className={characterStyles.portraitWrap}>
        <PixelPortrait
          seed={entry.id + entry.name}
          palette={palette}
          size={300}
          portraitImage={entry.portraitUrl}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className={characterStyles.scrim} />

      <div className={characterStyles.meta}>
        <div className={characterStyles.name}>{entry.name}</div>
        <div className={characterStyles.metaLine}>{entry.creatorLabel}</div>
      </div>

      {entry.inMyLibrary ? (
        <div className={characterStyles.hoverOverlay}>
          <span className={styles.alreadyPill}>Already in My Library</span>
        </div>
      ) : null}

      <span className={characterStyles.bar} aria-hidden="true" />
      <span className="u-brk tl" aria-hidden="true" />
      <span className="u-brk tr" aria-hidden="true" />
      <span className="u-brk bl" aria-hidden="true" />
      <span className="u-brk br" aria-hidden="true" />
    </div>
  );
}
