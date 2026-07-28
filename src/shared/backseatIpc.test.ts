/**
 * The image-grid geometry is the one thing in backseat that fails SILENTLY if
 * it drifts: an oversized grid is not rejected by the API, it is downscaled
 * server-side, so the only symptom is the companion quietly getting worse at
 * reading the screen. These assertions pin it to what Haiku 4.5 can actually
 * see, and to what IG-VLM (arXiv 2403.18406) found works.
 */
import { describe, it, expect } from 'vitest';
import {
  CELL_H,
  CELL_W,
  GRID_COLS,
  GRID_FRAMES,
  GRID_H,
  GRID_ROWS,
  GRID_SPAN_MS,
  GRID_VISUAL_TOKENS,
  GRID_W,
  CAPTURE_H,
  CAPTURE_W,
} from './backseatIpc';

/** Claude's documented cost: one visual token per 28x28 patch. */
const tokensFor = (w: number, h: number): number => Math.ceil(w / 28) * Math.ceil(h / 28);

/** Haiku 4.5 is a STANDARD-tier vision model. */
const STANDARD_MAX_LONG_EDGE = 1568;
const STANDARD_MAX_TOKENS = 1568;

describe('backseat image grid', () => {
  it('is the 6-frame 3x2 layout IG-VLM found best', () => {
    // N=6 beat 4/9/12/16/20 in the paper's ablation, and near-square grids beat
    // wide ones — which for 16:9 cells means 3 rows of 2, not 2 rows of 3.
    expect(GRID_FRAMES).toBe(6);
    expect(GRID_ROWS).toBe(3);
    expect(GRID_COLS).toBe(2);
    expect(GRID_ROWS * GRID_COLS).toBe(GRID_FRAMES);
  });

  it('stays inside what Haiku can see, so it is never downscaled server-side', () => {
    expect(Math.max(GRID_W, GRID_H)).toBeLessThanOrEqual(STANDARD_MAX_LONG_EDGE);
    expect(tokensFor(GRID_W, GRID_H)).toBeLessThanOrEqual(STANDARD_MAX_TOKENS);
    expect(GRID_VISUAL_TOKENS).toBe(tokensFor(GRID_W, GRID_H));
  });

  it('uses as much of the token budget as the aspect ratio allows', () => {
    // Guards the other direction: a grid well under the cap is throwing away
    // resolution the model was willing to look at for free. Anything smaller
    // than 95% of the budget means the sizing math has drifted.
    expect(GRID_VISUAL_TOKENS).toBeGreaterThan(STANDARD_MAX_TOKENS * 0.95);
  });

  it('lands on exact patch boundaries', () => {
    // A grid whose dimensions are not multiples of 28 pays for a partial patch
    // row/column that carries almost no image.
    expect(GRID_W % 28).toBe(0);
    expect(GRID_H % 28).toBe(0);
  });

  it('tiles the cells exactly, with no rounding gap', () => {
    expect(CELL_W * GRID_COLS).toBe(GRID_W);
    expect(CELL_H * GRID_ROWS).toBe(GRID_H);
  });

  it('keeps cells close to the capture aspect ratio', () => {
    // The compositor letterboxes rather than stretches, so a cell far from the
    // source ratio just wastes pixels on bars.
    const cell = CELL_W / CELL_H;
    const source = CAPTURE_W / CAPTURE_H;
    expect(Math.abs(cell - source) / source).toBeLessThan(0.02);
  });

  it('spans one second per frame', () => {
    expect(GRID_SPAN_MS).toBe(GRID_FRAMES * 1000);
  });
});
