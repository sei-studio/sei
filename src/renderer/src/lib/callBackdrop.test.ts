/**
 * Vertical pan maths for the character-art call backdrop.
 *
 * The two cases that matter are the two pane shapes the feature actually
 * produces: a wide window holding a portrait (pan available, the point of the
 * feature) and a narrow split-screen column (art fills it, nothing to pan).
 */

import { describe, it, expect } from 'vitest';
import { clampPosition, coverOverflowPx, dragToPositionDelta } from './callBackdrop';

/** A 600x900 portrait, the shape PortraitCropModal's card crop produces. */
const PORTRAIT = { w: 600, h: 900 };

describe('coverOverflowPx', () => {
  it('overflows vertically when a portrait covers a wide window', () => {
    // Width-driven: scale 1600/600 = 2.667, so the art stands 2400 tall in a
    // 900-tall window. This is the "fit to width, drag up and down" case.
    expect(coverOverflowPx(PORTRAIT, { w: 1600, h: 900 })).toBeCloseTo(1500, 6);
  });

  it('has nothing to pan when the art is proportionally taller than the pane', () => {
    // A narrow split column: cover goes height-driven instead, so the art
    // fills it exactly and gets cropped left/right, not top/bottom.
    expect(coverOverflowPx(PORTRAIT, { w: 400, h: 900 })).toBe(0);
  });

  it('is zero rather than NaN before the image has decoded', () => {
    expect(coverOverflowPx({ w: 0, h: 0 }, { w: 800, h: 600 })).toBe(0);
    expect(coverOverflowPx(PORTRAIT, { w: 0, h: 0 })).toBe(0);
  });
});

describe('dragToPositionDelta', () => {
  it('tracks the cursor: a drag of the whole overflow spans the whole range', () => {
    expect(dragToPositionDelta(-1500, 1500)).toBeCloseTo(100, 6);
  });

  it('reveals what is above when dragged down', () => {
    expect(dragToPositionDelta(50, 1000)).toBeLessThan(0);
  });

  it('does nothing when there is no overflow', () => {
    expect(dragToPositionDelta(200, 0)).toBe(0);
  });
});

describe('clampPosition', () => {
  it('keeps the art inside the pane', () => {
    expect(clampPosition(-20)).toBe(0);
    expect(clampPosition(140)).toBe(100);
    expect(clampPosition(50)).toBe(50);
  });
});
