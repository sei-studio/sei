/**
 * strokeHumanize — the properties that make a stroke read as a hand.
 *
 * The bend assertions exist because of a real regression (260728): the wobble
 * tapered to exactly zero at both ends and its frequency was indexed by point
 * position rather than arc length, so short strokes — window mullions, stick
 * limbs, tick marks — came out ruler-straight next to wobbly outlines, and the
 * picture read as half hand-drawn, half plotter.
 */

import { describe, it, expect } from 'vitest';
import { humanizeStroke } from './strokeHumanize';
import { CANVAS_H, CANVAS_W, type DrawPoint } from '../../shared/drawIpc';

/**
 * Max distance from the best-fit line through the points. This isolates real
 * BEND from the per-stroke translate/rotate settle, which moves a stroke
 * without curving it and would otherwise pass as wobble.
 */
function bend(points: DrawPoint[]): number {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  let max = 0;
  for (const p of points) {
    const d = Math.abs((p.x - mx) * nx + (p.y - my) * ny);
    if (d > max) max = d;
  }
  return max;
}

function line(len: number): DrawPoint[] {
  return [
    { x: 100, y: 350 },
    { x: 100 + len, y: 350 },
  ];
}

describe('humanizeStroke', () => {
  it('bends every straight run, at every length and every seed', () => {
    // 12px is a knob or a tick; 800px is a ground line. Neither may come out
    // geometrically straight.
    for (const len of [12, 30, 60, 120, 300, 800]) {
      for (let seed = 0; seed < 8; seed++) {
        const h = humanizeStroke(`s${seed}-len${len}`, line(len), {
          smooth: false,
          closed: false,
        });
        expect(h).not.toBeNull();
        expect(bend(h!.stroke.points)).toBeGreaterThan(0.1);
      }
    }
  });

  it('keeps the bend proportionate: never a kink, never a ruler', () => {
    for (const len of [30, 120, 800]) {
      for (let seed = 0; seed < 8; seed++) {
        const h = humanizeStroke(`p${seed}-${len}`, line(len), { smooth: false, closed: false })!;
        // A hand wanders a few px, not a tenth of the stroke's length.
        expect(bend(h.stroke.points)).toBeLessThan(Math.max(4, len * 0.12));
      }
    }
  });

  it('is deterministic for a given id, so the gallery redraws what was watched', () => {
    const a = humanizeStroke('fixed', line(400), { smooth: false, closed: false });
    const b = humanizeStroke('fixed', line(400), { smooth: false, closed: false });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('varies between ids, so two identical shapes are not twins', () => {
    const a = humanizeStroke('one', line(400), { smooth: false, closed: false })!;
    const b = humanizeStroke('two', line(400), { smooth: false, closed: false })!;
    expect(JSON.stringify(a.stroke.points)).not.toBe(JSON.stringify(b.stroke.points));
  });

  it('returns null when there is no line to draw', () => {
    expect(humanizeStroke('x', [{ x: 5, y: 5 }], { smooth: false, closed: false })).toBeNull();
    expect(
      humanizeStroke('x', [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ], { smooth: false, closed: false }),
    ).toBeNull();
    expect(
      humanizeStroke('x', [
        { x: Number.NaN, y: 1 },
        { x: 2, y: Number.POSITIVE_INFINITY },
      ], { smooth: false, closed: false }),
    ).toBeNull();
  });

  it('never leaves the canvas, even wobbling a stroke drawn on the edge', () => {
    const h = humanizeStroke(
      'edge',
      [
        { x: 0, y: 0 },
        { x: CANVAS_W, y: 0 },
      ],
      { smooth: false, closed: false },
    )!;
    for (const p of h.stroke.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(CANVAS_W);
      expect(p.y).toBeLessThanOrEqual(CANVAS_H);
    }
  });

  it('times playback in the range a hand could actually draw', () => {
    const short = humanizeStroke('t1', line(40), { smooth: false, closed: false })!;
    const long = humanizeStroke('t2', line(900), { smooth: false, closed: false })!;
    expect(long.durationMs).toBeGreaterThan(short.durationMs);
    expect(short.durationMs).toBeGreaterThanOrEqual(160);
    expect(long.durationMs).toBeLessThanOrEqual(2800);
    expect(short.delayBeforeMs).toBeGreaterThan(0);
  });
});
