/**
 * Backseat clip card (260728) — the "it can also save a clip for you" half.
 *
 * When the companion calls save_clip while watching, the last fifteen seconds
 * are written to disk and the resulting file rides on the chat message it sent
 * about the moment. This renders that file inline in the normal chat thread,
 * because the point of the feature is that a good play lands where the rest of
 * the conversation is, not in a folder the player has to go looking for.
 *
 * The video plays from disk through the file:// URL. That works because the clip
 * is one Sei wrote itself, under <profileRoot>/clips, and the reveal action is
 * range-checked to that directory in main before it will open anything.
 */

import React from 'react';
import { sei } from '../../lib/ipcClient';
import styles from './ClipCard.module.css';

export interface ClipCardProps {
  clip: { path: string; reason: string };
}

export function ClipCard({ clip }: ClipCardProps): React.ReactElement {
  return (
    <div className={styles.card}>
      <video
        className={styles.video}
        src={`file://${clip.path}`}
        controls
        preload="metadata"
        // Muted so a clip cannot blast audio into a call the player is on.
        muted
      />
      <div className={styles.footer}>
        <span className={styles.reason}>{clip.reason}</span>
        <button
          type="button"
          className={styles.reveal}
          onClick={() => void sei.backseatRevealClip(clip.path).catch(() => {})}
        >
          Show file
        </button>
      </div>
    </div>
  );
}
