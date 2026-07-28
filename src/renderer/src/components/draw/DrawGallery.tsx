/**
 * DrawGallery — the end-of-game sheet: a row per player, one cell per round,
 * word under each drawing, and a save button that writes the same layout to
 * the Desktop as a PNG (composed on canvas, not screenshotted, so the file is
 * identical everywhere).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { paintStrokes } from './drawRender';
import { composeGalleryPng, galleryByRound } from './galleryExport';
import { SquiggleFrame, SquiggleRule } from './Squiggle';
import styles from './draw.module.css';

/** One drawing, painted at cell size. */
function GalleryCell({ entry }: { entry: DrawGalleryEntry | undefined }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (entry) paintStrokes(ctx, entry.strokes, { scale: c.width / CANVAS_W });
  }, [entry]);

  return (
    <figure className={styles.cell}>
      <div className={styles.cellArt} style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}>
        <SquiggleFrame seed={`cell-${entry?.round ?? 0}-${entry?.drawer ?? 'x'}`} />
        <canvas ref={ref} className={styles.cellCanvas} />
      </div>
      <figcaption className={styles.cellWord}>
        {entry ? entry.word : '-'}
        {entry ? (
          <span className={entry.guessed ? styles.gotIt : styles.missed}>
            {entry.guessed ? 'got it' : 'missed'}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export interface DrawGalleryProps {
  state: DrawGameState;
  savedTo: string;
  onSave: (pngDataUrl: string) => void;
  onPlayAgain: () => void;
  onClose: () => void;
}

export function DrawGallery({
  state,
  savedTo,
  onSave,
  onPlayAgain,
  onClose,
}: DrawGalleryProps): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const columns = Math.max(1, state.rounds);
  const playerEntries = useMemo(
    () => galleryByRound(state.gallery, 'player', columns),
    [state.gallery, columns],
  );
  const aiEntries = useMemo(
    () => galleryByRound(state.gallery, 'ai', columns),
    [state.gallery, columns],
  );

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const png = await composeGalleryPng(state);
      if (png) onSave(png);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.gallery}>
      <h1 className={styles.galleryTitle}>Draw!</h1>
      <p className={styles.score}>
        {state.playerName} {state.scores.player} - {state.scores.ai} {state.aiName}
      </p>
      <SquiggleRule seed="gallery-top" />

      {(
        [
          [state.playerName, playerEntries] as const,
          [state.aiName, aiEntries] as const,
        ]
      ).map(([name, entries]) => (
        <section key={name} className={styles.galleryRow}>
          <h2 className={styles.rowName}>{name}</h2>
          <div className={styles.cells} style={{ ['--cols' as string]: String(columns) }}>
            {entries.map((e, i) => (
              <GalleryCell key={`${name}-${i}`} entry={e} />
            ))}
          </div>
        </section>
      ))}

      <div className={styles.galleryActions}>
        <button type="button" className={styles.handBtn} onClick={() => void save()} disabled={saving}>
          <SquiggleFrame seed="save-btn" />
          {saving ? 'Saving...' : 'Save to Desktop'}
        </button>
        <button type="button" className={styles.handBtn} onClick={onPlayAgain}>
          <SquiggleFrame seed="again-btn" />
          Play again
        </button>
        <button type="button" className={styles.handBtnQuiet} onClick={onClose}>
          Close
        </button>
      </div>
      {savedTo ? <p className={styles.savedNote}>Saved to {savedTo}</p> : null}
    </div>
  );
}
