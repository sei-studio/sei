/**
 * DrawGallery — the end-of-game sheet: a row per player, one cell per round,
 * word under each drawing, and a save button that writes the same layout to
 * the Downloads folder as a PNG (composed on canvas, not screenshotted, so the
 * file is identical everywhere).
 *
 * A CELL is clickable too (260801, ported from the web version): one drawing
 * opens as its own share tile, enlarged, with the same save. The whole-game
 * tile is a set of thumbnails, so the single round somebody actually wants to
 * post came out of it at a fraction of the resolution. The affordance is the
 * cursor alone: a hover tint would be a second ink on a one-ink surface.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { useT } from '../../lib/i18n';
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
  /** Open this drawing as its own tile. Omitted for an empty (unplayed) cell. */
  onOpen: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const artRef = useRef<HTMLDivElement | null>(null);

  // Repainted on RESIZE as well as on entry, because the gallery sizes its
  // cells from the space left over rather than from a fixed grid: the cell
  // changes size with the window, and a canvas painted once at the wrong size
  // is a blurry, half-filled drawing.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = (): void => {
      // The cells are height-driven, and flexbox max-content OVERESTIMATES a
      // height-driven aspect-ratio box (it sizes it as if the caption were not
      // there), which left a moat of slack either side of every drawing
      // (260729, from the web version). Pin the art's width to its measured
      // height so the row hugs the art.
      const art = artRef.current;
      if (art) {
        const h = art.clientHeight;
        if (h > 0) art.style.width = `${Math.round((h * CANVAS_W) / CANVAS_H)}px`;
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

  const seed = `cell-${entry?.round ?? 0}-${entry?.drawer ?? 'x'}`;
  return (
    <figure className={styles.cell}>
      <div
        ref={artRef}
        className={`${styles.cellArt} ${entry ? styles.cellArtClick : ''}`}
        style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
        // An empty round has nothing to open, so it stays inert rather than
        // being a button that does nothing.
        role={entry ? 'button' : undefined}
        tabIndex={entry ? 0 : undefined}
        aria-label={entry ? entry.word : undefined}
        onClick={entry ? onOpen : undefined}
        onKeyDown={
          entry
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
      >
        <SquiggleFrame seed={seed} />
        <canvas ref={ref} className={styles.cellCanvas} />
      </div>
      <figcaption className={styles.cellWord}>
        {/* A guessed word wears the highlighter; a missed one goes bare. The
            absence is the same information without a second ink (260729, from
            the web version; it used to be a typed "missed" marker). */}
        <span
          className={styles.cellWordText}
          data-guessed={entry?.guessed ? 'true' : 'false'}
        >
          {entry?.guessed ? <SquiggleHighlight seed={`${seed}-hl`} /> : null}
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
  const t = useT();
  /**
   * What is in flight, if anything. One flag for all three actions so they
   * can't overlap, but it names WHICH one: composing a cell's tile must not
   * flip the save button's label to "Saving..." when nothing is being written.
   */
  const [busy, setBusy] = useState<null | 'save' | 'open'>(null);
  /**
   * The tile in the popup, and whether it is already on disk. The whole-game
   * tile saves first and opens the popup as a confirmation ("Saved!"); a
   * clicked cell opens the popup as a PREVIEW with the save still to offer,
   * because the click was to look at the drawing, not to write a file.
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
    if (busy) return;
    setBusy('save');
    try {
      const png = await composeGalleryPng(state);
      if (!png) return;
      // The popup only opens on a WRITTEN file: "Saved!" over a failed save
      // would be a lie, and the store surfaces the error line instead.
      const file = await onSave(png);
      if (file) setPopup({ png, saved: true });
    } finally {
      setBusy(null);
    }
  };

  /** Compose one drawing's tile and show it. The save is the popup's job. */
  const openCell = async (entry: DrawGalleryEntry, name: string): Promise<void> => {
    if (busy) return;
    setBusy('open');
    try {
      // `{word}` is deliberately NOT substituted here: composeCellPng needs to
      // know where the word sits so the highlighter goes behind it alone.
      // {a} is the English article only; a translation that has no use for one
      // simply leaves the placeholder out of its string.
      const caption = t('according to {name}, this is {a} {word}.', {
        name,
        a: /^[aeiou]/i.test(entry.word) ? 'an' : 'a',
      });
      const png = await composeCellPng(entry, caption);
      if (png) setPopup({ png, saved: false });
    } finally {
      setBusy(null);
    }
  };

  /** Write the previewed tile out. Only reachable from an unsaved popup. */
  const savePopupPng = async (): Promise<void> => {
    if (!popup || popup.saved || busy) return;
    setBusy('save');
    try {
      const file = await onSave(popup.png);
      if (file) setPopup({ png: popup.png, saved: true });
    } finally {
      setBusy(null);
    }
  };

  // The big "DRAW!" header and the separate score line are gone (260729, from
  // the web version): the drawings get the space, and the score lives in the
  // row names, which is where the eye already goes to compare the two rows.
  // The second field is the drawer's real name for the exported tile: the sheet
  // on screen says "you", but a file made to be posted has to name the person
  // (same reasoning as composeGalleryPng's row labels).
  const rows = [
    [
      `${t(PLAYER_LABEL)} ${state.scores.player}`,
      (state.playerName ?? '').trim() || t(PLAYER_LABEL),
      playerEntries,
    ] as const,
    [`${state.aiName} ${state.scores.ai}`, state.aiName, aiEntries] as const,
  ];

  return (
    <div className={styles.gallery}>
      {rows.map(([label, name, entries]) => (
        <section key={label} className={styles.galleryRow}>
          <h2 className={styles.rowName}>{label}</h2>
          <div className={styles.cells} style={{ ['--cols' as string]: String(columns) }}>
            {Array.from({ length: columns }, (_, i) => (
              <GalleryCell
                key={`${label}-${i}`}
                entry={entries[i]}
                onOpen={() => {
                  const entry = entries[i];
                  if (entry) void openCell(entry, name);
                }}
              />
            ))}
          </div>
        </section>
      ))}

      <div className={styles.galleryActions}>
        <button type="button" className={styles.handBtn} onClick={() => void save()} disabled={busy !== null}>
          <SquiggleHighlight seed="save-hl" />
          <SquiggleFrame seed="save-btn" />
          <span className={styles.btnLabel}>{busy === 'save' ? t('Saving...') : t('Save to Downloads')}</span>
        </button>
        <button type="button" className={styles.handBtn} data-on="true" onClick={onPlayAgain}>
          <SquiggleHighlight seed="again-hl" />
          <SquiggleFrame seed="again-btn" />
          <span className={styles.btnLabel}>{t('Play again')}</span>
        </button>
        <button type="button" className={styles.handBtnQuiet} onClick={onClose}>
          <SquiggleUnderline seed="gallery-close" />
          <span className={styles.btnLabel}>{t('Close')}</span>
        </button>
      </div>
      {savedTo ? <p className={styles.savedNote}>{t('Saved to {path}', { path: savedTo })}</p> : null}

      {popup ? (
        <div className={styles.savePopupOverlay}>
          <div className={styles.savePopup}>
            <SquiggleFrame seed="save-popup" />
            {popup.saved ? <h2 className={styles.savePopupTitle}>{t('Saved!')}</h2> : null}
            <div className={styles.savePopupArt}>
              <SquiggleFrame seed="save-popup-art" />
              <img className={styles.savePopupImg} src={popup.png} alt={t('The saved picture')} />
            </div>
            <div className={styles.savePopupActions}>
              {popup.saved ? null : (
                <button
                  type="button"
                  className={styles.handBtn}
                  onClick={() => void savePopupPng()}
                  disabled={busy !== null}
                >
                  <SquiggleHighlight seed="save-popup-save-hl" />
                  <SquiggleFrame seed="save-popup-save" />
                  <span className={styles.btnLabel}>
                    {busy === 'save' ? t('Saving...') : t('Save to Downloads')}
                  </span>
                </button>
              )}
              <button
                type="button"
                className={styles.handBtn}
                onClick={() => setPopup(null)}
                aria-label={t('Close')}
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
