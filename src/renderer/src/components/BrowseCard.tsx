/**
 * BrowseCard — World scouting card (Party redesign §4.4, mockup .wcard).
 *
 * 3:4 art block (portrait cover via PixelPortrait's image override, procedural
 * sprite fallback) with a hover overlay carrying the single Invite action,
 * then a meta row below: name (Oswald 16px) + "by {creator}" line. The card
 * body opens the character profile; Invite adds directly to the library
 * (parent-provided — same IPC path as CharacterPage's "Add to library").
 *
 * Lean-component contract (CONTEXT D-31c): does NOT subscribe to auth/sync/
 * cloud stores — `inviteState` is precomputed by the parent (library presence
 * + open party slots).
 *
 * Pitfall 7 (12-RESEARCH.md): the inner Invite button stopPropagations.
 */

import React, { useState } from 'react';
import type { BrowseEntry } from '@shared/ipc';
import { PixelPortrait } from './PixelPortrait';
import { pickPalette } from '../lib/portraitPalettes';
import { Button } from './Button';
import { IdTag } from './IdTag';
import styles from './BrowseCard.module.css';

/** Hover-overlay action state, precomputed by the parent grid. */
export type InviteState = 'open' | 'in-party' | 'full';

export interface BrowseCardProps {
  entry: BrowseEntry;
  theme: 'light' | 'dark';
  /** open → primary Invite; in-party / full → disabled ghost label. */
  inviteState: InviteState;
  /** Direct add-to-library (parent runs the CharacterPage IPC path). */
  onInvite: () => void;
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
  inviteState,
  onInvite,
  onOpen,
  onPrefetch,
}: BrowseCardProps): React.ReactElement {
  const palette = pickPalette(entry.id + entry.name, theme);

  // Hold the wireframe until the portrait has actually SETTLED (loaded or
  // fallen back to the sprite) — otherwise the grid pops in with empty art
  // blocks while Storage images stream (260705). PixelPortrait stays mounted
  // underneath (visibility-hidden) so the image keeps loading; the static
  // skeleton overlay mirrors the card layout so nothing jumps on reveal.
  const [artSettled, setArtSettled] = useState(false);
  const ready = !entry.portraitUrl || artSettled;

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
        <div className={styles.over}>
          {inviteState === 'open' ? (
            <Button
              kind="primary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onInvite();
              }}
            >
              Invite
            </Button>
          ) : (
            <Button kind="ghost" size="sm" disabled>
              {inviteState === 'in-party' ? 'In your party' : 'Party full'}
            </Button>
          )}
        </div>
      </div>
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
