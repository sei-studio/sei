/**
 * Gallery PNG composer.
 *
 * Lays the finished game out as one image: a row per player, their name on the
 * left, then a cell per round with the word underneath the drawing. Saved to
 * the Desktop by main (drawSaveGallery).
 *
 * Drawn on a plain canvas rather than screenshotting the DOM, so the export
 * does not depend on layout, scroll position or device pixel ratio, and the
 * file is the same on every machine.
 */

import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { paintStrokes } from './drawRender';

const HAND_FONT = "'Architects Daughter', 'Comic Sans MS', cursive";

const PAD = 48;
const CELL_W = 300;
const CELL_H = Math.round((CELL_W * CANVAS_H) / CANVAS_W);
const CELL_GAP = 20;
const LABEL_H = 44;
const ROW_LABEL_H = 52;
const ROW_GAP = 40;
const TITLE_H = 96;

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  y: number,
  name: string,
  entries: DrawGalleryEntry[],
  columns: number,
): number {
  ctx.fillStyle = '#111111';
  ctx.font = `28px ${HAND_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(name, PAD, y + 30);

  const top = y + ROW_LABEL_H;
  for (let i = 0; i < columns; i++) {
    const x = PAD + i * (CELL_W + CELL_GAP);
    const entry = entries[i];

    ctx.save();
    roundedRect(ctx, x, top, CELL_W, CELL_H, 10);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#dcdcdc';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (entry) {
      // Clip to the cell, then paint the picture scaled into it.
      ctx.clip();
      ctx.translate(x, top);
      paintStrokes(ctx, entry.strokes, { scale: CELL_W / CANVAS_W });
    }
    ctx.restore();

    ctx.textAlign = 'center';
    if (entry) {
      ctx.fillStyle = '#111111';
      ctx.font = `22px ${HAND_FONT}`;
      ctx.fillText(entry.word, x + CELL_W / 2, top + CELL_H + 30);
      // A small mark for whether it was guessed, so the sheet records the game
      // and not just the pictures.
      ctx.fillStyle = entry.guessed ? '#1a8a3f' : '#b8b8b8';
      ctx.font = `18px ${HAND_FONT}`;
      ctx.fillText(entry.guessed ? 'got it' : 'missed', x + CELL_W / 2, top + CELL_H + 52);
    } else {
      ctx.fillStyle = '#cccccc';
      ctx.font = `22px ${HAND_FONT}`;
      ctx.fillText('-', x + CELL_W / 2, top + CELL_H + 30);
    }
  }
  return top + CELL_H + LABEL_H + 24;
}

/**
 * Compose the gallery. Awaits font loading first: without it the first paint
 * falls back to a default face and the saved PNG does not match the screen.
 */
export async function composeGalleryPng(state: DrawGameState): Promise<string> {
  try {
    await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  } catch {
    /* font loading API unavailable — fall through with the fallback face */
  }

  const columns = Math.max(1, state.rounds);
  const playerEntries = byRound(state.gallery, 'player', columns);
  const aiEntries = byRound(state.gallery, 'ai', columns);

  const width = PAD * 2 + columns * CELL_W + (columns - 1) * CELL_GAP;
  const rowH = ROW_LABEL_H + CELL_H + LABEL_H + 24;
  const height = TITLE_H + rowH * 2 + ROW_GAP + PAD;

  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#111111';
  ctx.font = `44px ${HAND_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('DRAW!', PAD, 58);
  ctx.font = `22px ${HAND_FONT}`;
  ctx.fillStyle = '#666666';
  ctx.fillText(
    `${state.playerName} ${state.scores.player} - ${state.scores.ai} ${state.aiName}`,
    PAD,
    86,
  );

  let y = TITLE_H;
  y = drawRow(ctx, y, state.playerName, playerEntries, columns);
  y += ROW_GAP - 24;
  drawRow(ctx, y, state.aiName, aiEntries, columns);

  return c.toDataURL('image/png');
}

/** Entries for one drawer, indexed by round so a missing turn leaves a gap. */
function byRound(
  gallery: DrawGalleryEntry[],
  drawer: 'player' | 'ai',
  columns: number,
): DrawGalleryEntry[] {
  const out: DrawGalleryEntry[] = new Array(columns);
  for (const e of gallery) {
    if (e.drawer !== drawer) continue;
    if (e.round >= 1 && e.round <= columns) out[e.round - 1] = e;
  }
  return out;
}

export { byRound as galleryByRound };
