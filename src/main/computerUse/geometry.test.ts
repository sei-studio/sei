import { describe, expect, it } from 'vitest';
import {
  budgetForModel,
  displayForRect,
  fitToBudget,
  FRAME_MAX_EDGE,
  globalToImage,
  imageToGlobal,
  planCapture,
  visualTokens,
} from './geometry';
import { frameScale, type DisplayInfo } from './types';

// Shawn's setup: 3024x1964@2x built-in (1512x982 points, main) and a
// 3440x1440@1x external to its right.
const builtIn: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, w: 1512, h: 982 }, scale: 2, main: true };
const external: DisplayInfo = { id: 2, bounds: { x: 1512, y: -200, w: 3440, h: 1440 }, scale: 1, main: false };
const displays = [builtIn, external];

describe('budget', () => {
  it('caps the long edge at 1280 for every model', () => {
    expect(budgetForModel('claude-sonnet-5').maxLongEdge).toBe(FRAME_MAX_EDGE);
    expect(budgetForModel('claude-haiku-4-5').maxLongEdge).toBe(FRAME_MAX_EDGE);
    expect(budgetForModel('claude-haiku-4-5').maxTokens).toBe(1568);
    expect(budgetForModel('claude-sonnet-5').maxTokens).toBe(4784);
  });

  it('never upscales and stays inside the token cap', () => {
    const b = budgetForModel('claude-haiku-4-5');
    const f = fitToBudget(3440, 1440, b);
    expect(f.width).toBeLessThanOrEqual(1280);
    expect(visualTokens(f.width, f.height)).toBeLessThanOrEqual(1568);
    expect(fitToBudget(400, 300, b)).toMatchObject({ width: 400, height: 300 });
  });
});

describe('mixed-DPI capture planning', () => {
  it('captures a window on the 2x built-in at native px, fit to 1280', () => {
    const plan = planCapture({ x: 100, y: 50, w: 1000, h: 700 }, displays, budgetForModel('claude-sonnet-5'))!;
    expect(plan.displayId).toBe(1);
    // native 2000x1400 -> long edge 1280
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(896);
  });

  it('captures a window on the 1x external from its own display, clipped to it', () => {
    const plan = planCapture({ x: 1400, y: 0, w: 1200, h: 800 }, displays, budgetForModel('claude-sonnet-5'))!;
    expect(plan.displayId).toBe(2);
    expect(plan.rect).toEqual({ x: 1512, y: 0, w: 1088, h: 800 });
    expect(plan.width).toBe(1088);
  });

  it('picks the display holding most of a straddling rect', () => {
    expect(displayForRect(displays, { x: 1300, y: 0, w: 400, h: 400 })!.id).toBe(1);
    expect(displayForRect(displays, { x: 1400, y: 0, w: 400, h: 400 })!.id).toBe(2);
  });
});

describe('image <-> global mapping', () => {
  const frames = [
    // built-in, 2x, downscaled
    { rect: { x: 100, y: 50, w: 1000, h: 700 }, width: 1280, height: 896 },
    // external, 1x, negative y
    { rect: { x: 1512, y: -200, w: 3440, h: 1440 }, width: 1280, height: 536 },
  ];
  for (const f of frames) {
    it(`round trips inside ${JSON.stringify(f.rect)}`, () => {
      for (const p of [
        { x: 0, y: 0 },
        { x: 640, y: 300 },
        { x: f.width - 1, y: f.height - 1 },
      ]) {
        const g = imageToGlobal(p, f);
        expect(g.x).toBeGreaterThanOrEqual(f.rect.x);
        expect(g.x).toBeLessThanOrEqual(f.rect.x + f.rect.w);
        expect(g.y).toBeGreaterThanOrEqual(f.rect.y);
        expect(g.y).toBeLessThanOrEqual(f.rect.y + f.rect.h);
        expect(globalToImage(g, f)).toEqual(p);
      }
    });
  }

  it('clamps coordinates outside the image into the shared bounds', () => {
    const f = frames[1]!;
    const g = imageToGlobal({ x: -500, y: 99999 }, f);
    expect(g.x).toBeGreaterThanOrEqual(f.rect.x);
    expect(g.y).toBeLessThanOrEqual(f.rect.y + f.rect.h);
  });

  it('reports the scale factor', () => {
    expect(frameScale(frames[0]!)).toBeCloseTo(1.28);
  });
});
