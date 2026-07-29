/**
 * DrawGallery — the end-of-game sheet: a row per player, one cell per round,
 * word under each drawing, and a save button that writes the same layout to
 * the Desktop as a PNG (composed on canvas, not screenshotted, so the file is
 * identical everywhere).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { paintStrokes } from './drawRender';

/**
 * On-screen width of the pen inside a gallery cell, in CSS px. Matches
 * --hand-stroke in draw.module.css: one pen drew the pictures and the frames
 * around them, and that has to stay true at thumbnail size.
 */
const CELL_PEN_CSS = 3.5;
import { PLAYER_LABEL, composeCellPng, composeGalleryPng, galleryByRound } from './galleryExport';
import { SquiggleFrame, SquiggleHighlight, SquiggleUnderline } from './Squiggle';
import styles from './draw.module.css';

/** One drawing, painted at cell size. */
function GalleryCell({
  entry,
  onOpen,
}: {
  entry: DrawGalleryEntry | undefined;
  /** Opens the drawing as its own share tile. */
  onOpen: (entry: DrawGalleryEntry) => void;
}): React.ReactElement {
  const artRef = useRef<HTMLDivElement | null>(null);
  const ref = useRef<HTMLCanvasElement | null>(null);

  // Repainted on RESIZE as well as on entry, because the gallery sizes its
  // cells from the space left over rather than from a fixed grid: the cell
  // changes size with the window, and a canvas painted once at the wrong size
  // is a blurry, half-filled drawing.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = (): void => {
      // The cells are height-driven, and flexbox max-content OVERESTIMATES a
      // height-driven aspect-ratio box (it sizes it as if the caption were
      // not there), which left slack either side of every drawing. Pin the
      // art's width to its measured height so the row hugs the art.
      const art = artRef.current;
      if (art) {
        const ah = art.clientHeight;
        if (ah > 0) art.style.width = `${Math.round((ah * CANVAS_W) / CANVAS_H)}px`;
      }
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      c.width = Math.max(1, Math.round(rect.width * dpr));
      c.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      // A cell is a thumbnail, so painting at true scale would draw the pen at
      // well under a pixel: the art would come out as grey wisps beside a
      // full-weight frame. Hold the ON SCREEN width constant instead, the same
      // trick strokesToPng uses for the snapshot the character looks at.
      if (entry) {
        paintStrokes(ctx, entry.strokes, {
          scale: c.width / CANVAS_W,
          lineWidth: (CELL_PEN_CSS * CANVAS_W) / Math.max(1, rect.width),
        });
      }
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
  }, [entry]);

  // Each drawing opens as its own share tile (web build, 260729). The
  // affordance is the cursor alone: a hover tint would be a second ink.
  const clickable = Boolean(entry);
  return (
    <figure className={styles.cell}>
      <div
        ref={artRef}
        className={`${styles.cellArt}${clickable ? ` ${styles.cellArtClick}` : ''}`}
        style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={entry?.word}
        onClick={entry ? () => onOpen(entry) : undefined}
        onKeyDown={
          entry
            ? (e): void => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(entry);
                }
              }
            : undefined
        }
      >
        <SquiggleFrame seed={`cell-${entry?.round ?? 0}-${entry?.drawer ?? 'x'}`} />
        <canvas ref={ref} className={styles.cellCanvas} />
      </div>
      <figcaption className={styles.cellWord}>
        {/* A guessed word wears the highlighter; a missed one goes bare. The
            absence is the same information without a second ink. */}
        <span
          className={`${styles.cellWordText}${entry?.guessed ? ` ${styles.cellWordGuessed}` : ''}`}
        >
          {entry?.guessed ? (
            <SquiggleHighlight seed={`cell-${entry.round}-${entry.drawer}-hl`} />
          ) : null}
          <span className={styles.btnLabel}>{entry ? entry.word : '-'}</span>
        </span>
      </figcaption>
    </figure>
  );
}

export interface DrawGalleryProps {
  state: DrawGameState;
  savedTo: string;
  /** Resolves with the written file path, or null when the save failed. */
  onSave: (pngDataUrl: string) => Promise<string | null>;
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
  /**
   * The tile popup: the game tile lands here already saved ("Saved!"); a
   * clicked drawing lands here unsaved, with its own save button.
   */
  const [popup, setPopup] = useState<{ png: string; saved: boolean } | null>(null);
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
      if (!png) return;
      // The popup only opens on a WRITTEN file: "Saved!" over a failed save
      // would be a lie, and the store surfaces the error line instead.
      const file = await onSave(png);
      if (file) setPopup({ png, saved: true });
    } finally {
      setSaving(false);
    }
  };

  const openCell = async (entry: DrawGalleryEntry): Promise<void> => {
    if (saving) return;
    const png = await composeCellPng(entry, entry.drawer);
    if (png) setPopup({ png, saved: false });
  };

  const savePopupPng = async (): Promise<void> => {
    if (saving || !popup) return;
    setSaving(true);
    try {
      const file = await onSave(popup.png);
      if (file) setPopup({ png: popup.png, saved: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.gallery}>
      {/* No header (web build, 260729): the drawings get its space, and the
          score lives in the row names now, not on its own line. */}
      {(
        [
          [PLAYER_LABEL, state.scores.player, playerEntries] as const,
          [state.aiName, state.scores.ai, aiEntries] as const,
        ]
      ).map(([name, score, entries]) => (
        <section key={name} className={styles.galleryRow}>
          <h2 className={styles.rowName}>{`${name} - ${score} guessed`}</h2>
          <div className={styles.cells} style={{ ['--cols' as string]: String(columns) }}>
            {entries.map((e, i) => (
              <GalleryCell key={`${name}-${i}`} entry={e} onOpen={(en) => void openCell(en)} />
            ))}
          </div>
        </section>
      ))}

      <div className={styles.galleryActions}>
        <button type="button" className={styles.handBtn} onClick={() => void save()} disabled={saving}>
          <SquiggleHighlight seed="save-hl" />
          <SquiggleFrame seed="save-btn" />
          <span className={styles.btnLabel}>{saving ? 'Saving...' : 'Save to Desktop'}</span>
        </button>
        <button type="button" className={styles.handBtn} data-on="true" onClick={onPlayAgain}>
          <SquiggleHighlight seed="again-hl" />
          <SquiggleFrame seed="again-btn" />
          <span className={styles.btnLabel}>Play again</span>
        </button>
        <button type="button" className={styles.handBtnQuiet} onClick={onClose}>
          <SquiggleUnderline seed="gallery-close" />
          <span className={styles.btnLabel}>Close</span>
        </button>
      </div>
      {savedTo ? <p className={styles.savedNote}>Saved to {savedTo}</p> : null}

      {popup ? (
        <div className={styles.savePopupOverlay}>
          <div className={styles.savePopup}>
            <SquiggleFrame seed="save-popup" />
            {popup.saved ? <h2 className={styles.savePopupTitle}>Saved!</h2> : null}
            <div className={styles.savePopupArt}>
              <SquiggleFrame seed="save-popup-art" />
              <img className={styles.savePopupImg} src={popup.png} alt="The share tile" />
            </div>
            <div className={styles.savePopupActions}>
              {!popup.saved ? (
                <button
                  type="button"
                  className={styles.handBtn}
                  onClick={() => void savePopupPng()}
                  disabled={saving}
                >
                  <SquiggleHighlight seed="save-popup-save-hl" />
                  <SquiggleFrame seed="save-popup-save" />
                  <span className={styles.btnLabel}>
                    {saving ? 'Saving...' : 'Save to Desktop'}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className={styles.handBtn}
                onClick={() => setPopup(null)}
                aria-label="Close"
              >
                <SquiggleHighlight seed="save-popup-x-hl" shape="ellipse" />
                <SquiggleFrame seed="save-popup-x" shape="ellipse" />
                <span className={styles.btnLabel}>x</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
