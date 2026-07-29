/**
 * Gallery PNG composer — the shareable tile.
 *
 * SQUARE on purpose (260728): the file exists to be posted, and every place it
 * gets posted crops or letterboxes a wide image. So the output is a fixed
 * square and the CONTENTS scale to fit it, rather than the canvas growing with
 * the number of rounds.
 *
 * Layout: a big centred "DRAW!" at the top, one row per player (yours first),
 * a cell per round with the word under it, and sei.gg/draw in the bottom right.
 * Cell size is whatever lets 2 x rounds cells fit the middle band, so a
 * one-round game gets two big drawings and a five-round game gets ten small
 * ones.
 *
 * The tile carries NO score and NO rule under the title (260728). A scoreline
 * is the least interesting thing about a finished game (the same reasoning that
 * keeps results out of the play row in playSummary.ts), and once the title is
 * the full width of the sheet a rule under it is separating a heading from
 * nothing.
 *
 * Drawn on a plain canvas rather than screenshotting the DOM, so the export
 * does not depend on layout, scroll position or device pixel ratio, and the
 * file is the same on every machine.
 */

import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { paintStrokes } from './drawRender';
import { squiggleRectPolylines, type SquigglePoint } from './squigglePath';

const HAND_FONT = "'Architects Daughter', 'Comic Sans MS', cursive";

/**
 * The player is "you" on the on-screen sheet. The EXPORTED tile uses their real
 * name instead (this is only its fallback), because the file is made to be
 * posted and "you" means the wrong person once it leaves this machine.
 */
export const PLAYER_LABEL = 'you';

/** Where the tile sends anyone who sees it. */
const CREDIT = 'sei.gg/draw';

/** Big enough to stay sharp when a platform re-encodes it. */
const SIZE = 1200;
const PAD = 56;
/** One pen for the whole tile: the strokes and the frames. */
const PEN = 4;

const TITLE_PX = 128;
const BODY_PX = 26;
const GAP = 18;
const ROW_LABEL_H = 40;
const WORD_H = 38;
const ROW_GAP = 26;

function stroke(ctx: CanvasRenderingContext2D, pts: SquigglePoint[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/** The same wobbly rectangle the on-screen cells use, on a 2D context. */
function squiggleFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = PEN;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const side of squiggleRectPolylines(w, h, seed)) stroke(ctx, side);
  ctx.restore();
}

/**
 * Cell geometry for `rounds` columns and two rows inside the middle band.
 * Height-fit and width-fit are both computed and the smaller wins, which is
 * what keeps one round from producing two enormous cells and five rounds from
 * producing a strip of slivers.
 */
function cellSize(rounds: number, bandW: number, bandH: number): { w: number; h: number } {
  const byWidth = (bandW - (rounds - 1) * GAP) / rounds;
  const rowExtra = ROW_LABEL_H + WORD_H;
  const byHeight = ((bandH - ROW_GAP - 2 * rowExtra) / 2) * (CANVAS_W / CANVAS_H);
  const w = Math.max(60, Math.min(byWidth, byHeight));
  return { w, h: (w * CANVAS_H) / CANVAS_W };
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  opts: {
    x: number;
    y: number;
    name: string;
    entries: DrawGalleryEntry[];
    columns: number;
    cell: { w: number; h: number };
  },
): number {
  const { x, y, name, entries, columns, cell } = opts;

  ctx.fillStyle = '#000000';
  ctx.font = `${BODY_PX}px ${HAND_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // A person's name keeps the casing they chose (260728: the handwritten face
  // is set in ordinary letter casing everywhere on this surface).
  ctx.fillText(name, x, y + BODY_PX);

  const top = y + ROW_LABEL_H;
  for (let i = 0; i < columns; i++) {
    const cx = x + i * (cell.w + GAP);
    const entry = entries[i];

    squiggleFrame(ctx, cx, top, cell.w, cell.h, `export-${name}-${i}`);

    if (entry) {
      ctx.save();
      // Clip to the cell so a stroke that ran off the edge of the live canvas
      // cannot bleed into its neighbour.
      ctx.beginPath();
      ctx.rect(cx, top, cell.w, cell.h);
      ctx.clip();
      const scale = cell.w / CANVAS_W;
      paintStrokes(ctx, entry.strokes, {
        translate: { x: cx, y: top },
        scale,
        // Hold the pen at PEN px whatever the cell size, so a five-round tile
        // is not drawn in visibly finer line than a one-round tile.
        lineWidth: PEN / scale,
      });
      ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#000000';
    ctx.font = `${BODY_PX}px ${HAND_FONT}`;
    ctx.fillText(
      entry ? entry.word.toLowerCase() : '-',
      cx + cell.w / 2,
      top + cell.h + BODY_PX + 4,
    );
  }
  ctx.textAlign = 'left';
  return top + cell.h + WORD_H;
}

/**
 * Compose the tile. Awaits font loading first: without it the first paint
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

  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ── title ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#000000';
  ctx.font = `${TITLE_PX}px ${HAND_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('DRAW!', SIZE / 2, PAD + TITLE_PX * 0.78);
  ctx.textAlign = 'left';

  // ── the two rows, vertically centred in what is left ───────────────────
  const headBottom = PAD + TITLE_PX;
  const footTop = SIZE - PAD - BODY_PX * 1.6;
  // Deliberate air under the title: at this size the word is the loudest thing
  // on the sheet and the drawings have to start clear of it, not tucked under.
  const bandTop = headBottom + 72;
  const bandH = footTop - bandTop;
  const cell = cellSize(columns, SIZE - PAD * 2, bandH);
  const blockW = columns * cell.w + (columns - 1) * GAP;
  const blockH = 2 * (ROW_LABEL_H + cell.h + WORD_H) + ROW_GAP;
  const x = Math.max(PAD, (SIZE - blockW) / 2);
  // Biased above centre: with 3+ rounds the cells are width-bound and leave a
  // lot of slack, and dead-centring it drops the block onto the credit line.
  let y = bandTop + Math.max(0, (bandH - blockH) * 0.4);

  const playerName = (state.playerName ?? '').trim() || PLAYER_LABEL;
  y = drawRow(ctx, { x, y, name: playerName, entries: playerEntries, columns, cell });
  y += ROW_GAP;
  drawRow(ctx, { x, y, name: state.aiName, entries: aiEntries, columns, cell });

  // ── footer ─────────────────────────────────────────────────────────────
  ctx.fillStyle = '#000000';
  ctx.font = `${BODY_PX}px ${HAND_FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(CREDIT, SIZE - PAD, SIZE - PAD);

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
