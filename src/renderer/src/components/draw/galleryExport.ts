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
 *
 * Two tiles live here: `composeGalleryPng` (the whole game) and
 * `composeCellPng` (ONE drawing, opened by clicking a gallery cell). They share
 * the sheet, the pen and the credit line so the two files read as a set.
 */

import { CANVAS_H, CANVAS_W, type DrawGalleryEntry, type DrawGameState } from '@shared/drawIpc';
import { paintStrokes } from './drawRender';
import { squiggleBlob, squiggleRectPolylines, type SquigglePoint } from './squigglePath';

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
/* The title used to sit right at the top pad; a third of its own height of
   extra air above reads less like a cropped screenshot (260729, from the web
   version). */
const TITLE_DROP = 44;
/* 36 (260729, was 26): at feed size the names and words were squinting
   territory. The label bands scale with it so the text never crowds the art;
   the drawings give up a little size to pay for it. */
const BODY_PX = 36;
const GAP = 18;
const ROW_LABEL_H = 52;
const WORD_H = 50;
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
  amp?: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = PEN;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The default 1.8px wobble reads hand-drawn at cell size but disappears on a
  // big frame, so callers drawing large pass a proportionally larger amp.
  for (const side of squiggleRectPolylines(w, h, seed, amp ?? 1.8)) stroke(ctx, side);
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

  // ── title: big, centred, alone ──────────────────────────────────────────
  // "draw!", in the surface's own lowercase, with the highlighter behind it
  // (260729, matching the web tile — which says "draw! with sui" because it
  // fronts one character; the app tile stays just "draw!").
  const title = 'draw!';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${TITLE_PX}px ${HAND_FONT}`;
  const titleBase = PAD + TITLE_DROP + TITLE_PX * 0.78;
  // The highlighter goes down first: a rough yellow blob (the same shape the
  // on-screen swipes use) sitting BEHIND the black text, never under it as a
  // clean rectangle.
  const tw = ctx.measureText(title).width;
  const hlW = tw + 72;
  const hlH = TITLE_PX * 1.02;
  ctx.save();
  ctx.translate((SIZE - hlW) / 2, titleBase - TITLE_PX * 0.74);
  ctx.fillStyle = '#ffe500';
  ctx.fill(new Path2D(squiggleBlob(hlW, hlH, 'tile-title-hl')));
  ctx.restore();
  ctx.fillStyle = '#000000';
  ctx.fillText(title, SIZE / 2, titleBase);
  ctx.textAlign = 'left';

  // ── the two rows, vertically centred in what is left ───────────────────
  const headBottom = PAD + TITLE_DROP + TITLE_PX;
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

/**
 * ONE drawing as its own share tile (260801, ported from the web version),
 * opened by clicking a gallery cell. Same square sheet, same pen, same credit
 * as the whole-game tile, because a single round is the thing people actually
 * want to post and cropping it out of the game tile loses half its resolution.
 *
 * The caption is passed in already localized and already carrying the drawer's
 * name, with `{word}` left in it: the composer needs to know where the word
 * sits to put the highlighter behind it (and only it), and i18n lives up in the
 * React layer where `t` does.
 */
export async function composeCellPng(
  entry: DrawGalleryEntry,
  captionTemplate: string,
): Promise<string> {
  try {
    await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  } catch {
    /* font loading API unavailable — fall through with the fallback face */
  }

  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ── caption: two centred lines, broken after the comma ───────────────────
  const word = entry.word.toLowerCase();
  const broken = /^(.*?[,，、])\s*(.*)$/.exec(captionTemplate);
  const line1 = broken ? broken[1] : '';
  const line2t = broken ? broken[2] : captionTemplate;
  const [pre = '', post = ''] = line2t.split('{word}');

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // Shrink to fit the WIDER line: the sentence is fixed but the word is the
  // player's and the name is the user's, so neither length is under control.
  let capPx = 76;
  const widest = (): number => {
    ctx.font = `${capPx}px ${HAND_FONT}`;
    const l2 =
      ctx.measureText(pre).width + ctx.measureText(word).width + ctx.measureText(post).width;
    return Math.max(ctx.measureText(line1).width, l2);
  };
  while (capPx > 40 && widest() > SIZE - PAD * 2) capPx -= 2;
  const preW = ctx.measureText(pre).width;
  const wordW = ctx.measureText(word).width;
  const line2W = preW + wordW + ctx.measureText(post).width;
  const x2 = (SIZE - line2W) / 2;

  // ── the drawing box, placed before the caption is ────────────────────────
  // The caption used to hang from the top pad with the box hung off it, which
  // left visibly more air below the text than above. The box is placed off a
  // NOMINAL caption bottom instead, and the caption is then centred in the air
  // actually left above the box, so its distance to the sheet top equals its
  // distance to the frame.
  const nomBase2 = PAD + 30 + capPx * 0.78 + capPx * 1.35;
  const bandTop = nomBase2 + capPx * 0.5 + 40;
  const footTop = SIZE - PAD - BODY_PX * 1.6;
  const bandH = footTop - bandTop;
  // Deliberately narrower than the sheet: a frame running pad to pad reads as a
  // border on the tile rather than as a framed drawing.
  const w = Math.min((SIZE - PAD * 2) * 0.78, (bandH * CANVAS_W) / CANVAS_H);
  const h = (w * CANVAS_H) / CANVAS_W;
  const x = (SIZE - w) / 2;
  const y = bandTop + Math.max(0, (bandH - h) * 0.45);

  // Caption block height: line1's cap top through line2's descender.
  const blockH = capPx * (0.78 + 1.35 + 0.22);
  const base1 = (y - blockH) / 2 + capPx * 0.78;
  const base2 = base1 + capPx * 1.35;

  // The highlighter goes down first, behind the WORD only (the full stop stays
  // on plain paper). Bleed is modest: wider and the swipe swallows the tail of
  // the word before it.
  ctx.save();
  ctx.translate(x2 + preW - 12, base2 - capPx * 0.74);
  ctx.fillStyle = '#ffe500';
  ctx.fill(
    new Path2D(squiggleBlob(wordW + 24, capPx * 1.05, `cell-cap-hl-${entry.drawer}-${entry.round}`)),
  );
  ctx.restore();

  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.fillText(line1, SIZE / 2, base1);
  ctx.textAlign = 'left';
  ctx.fillText(pre, x2, base2);
  ctx.fillText(word, x2 + preW, base2);
  ctx.fillText(post, x2 + preW + wordW, base2);

  // ── the drawing ──────────────────────────────────────────────────────────
  // amp 7: the wobble has to scale with the frame to still read as a pen.
  squiggleFrame(ctx, x, y, w, h, `cell-pop-${entry.drawer}-${entry.round}`, 7);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const scale = w / CANVAS_W;
  paintStrokes(ctx, entry.strokes, {
    translate: { x, y },
    scale,
    // The same 4 device px the game tile holds its pen at.
    lineWidth: PEN / scale,
  });
  ctx.restore();

  // ── footer ───────────────────────────────────────────────────────────────
  ctx.fillStyle = '#000000';
  ctx.font = `${BODY_PX}px ${HAND_FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(CREDIT, SIZE - PAD, SIZE - PAD);
  ctx.textAlign = 'left';

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
