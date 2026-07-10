/**
 * BrowseCard — World scouting card (v0.3 overlay style, 260709).
 *
 * Full-bleed 3:4 portrait (cover via PixelPortrait's image override,
 * procedural sprite fallback) with the name (Oswald 16px) + "by {creator}"
 * line overlaid on a bottom dark gradient — no solid meta section. The whole
 * card body opens the character profile, where the "Add to library" CTA
 * lives — there is no in-card invite action anymore.
 *
 * Lean-component contract (CONTEXT D-31c): does NOT subscribe to auth/sync/
 * cloud stores.
 */

import React, { useState } from 'react';
import type { BrowseEntry } from '@shared/ipc';
import { PixelPortrait } from './PixelPortrait';
import { pickPalette } from '../lib/portraitPalettes';
import { IdTag } from './IdTag';
import styles from './BrowseCard.module.css';

export interface BrowseCardProps {
  entry: BrowseEntry;
  theme: 'light' | 'dark';
  onOpen: () => void;
  /**
   * External reveal gate for the above-the-fold rows. The parent holds the
   * first two visible rows as one group and flips this true once every
   * portrait in those rows has loaded (or failed / timed out), so they reveal
   * together instead of popping in one by one. Omit for below-the-fold cards —
   * they fall back to the per-card lazy reveal (settle on their own portrait).
   */
  ready?: boolean;
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
  ready: readyOverride,
  onPrefetch,
}: BrowseCardProps): React.ReactElement {
  const palette = pickPalette(entry.id + entry.name, theme);

  // Hold the wireframe until the portrait has actually SETTLED (loaded or
  // fallen back to the sprite) — otherwise the grid pops in with empty art
  // blocks while Storage images stream (260705). PixelPortrait stays mounted
  // underneath (visibility-hidden) so the image keeps loading; the static
  // skeleton overlay mirrors the card layout so nothing jumps on reveal.
  //
  // `readyOverride` (when supplied) hands the gate to the parent so the first
  // two rows reveal as a coordinated group; below-the-fold cards leave it
  // undefined and fall back to their own per-card settle.
  const [artSettled, setArtSettled] = useState(false);
  const ready = readyOverride ?? (!entry.portraitUrl || artSettled);

  return (
    <div
      className={`${styles.card} ${ready ? '' : styles.loading}`}
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
      <div className={styles.art}>
        <PixelPortrait
          seed={entry.id + entry.name}
          palette={palette}
          size={300}
          portraitImage={entry.portraitUrl}
          onImageSettled={() => setArtSettled(true)}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className={styles.gradient} aria-hidden="true" />
      <div className={styles.meta}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{entry.name}</span>
          {entry.publicId ? <IdTag id={entry.publicId} size="sm" /> : null}
        </div>
        <span className={styles.by}>{entry.creatorLabel}</span>
      </div>
      {!ready ? (
        <div className={styles.skel} aria-hidden="true">
          <div className={styles.skelArt} />
          <div className={styles.skelName} />
          <div className={styles.skelBy} />
        </div>
      ) : null}
    </div>
  );
}
