/**
 * Squiggly UI linework for the Draw! surface.
 *
 * Every rule, border and underline on this screen is a hand-drawn wobble
 * rather than a CSS border, which is what makes the page read as part of the
 * same drawing as the canvas. These build SVG path strings; the components
 * render them as inline <svg> behind or under their content.
 *
 * Deterministic by `seed`, so a path does not re-wiggle on every React render
 * (which would look like the UI is vibrating).
 */

/** mulberry32, same generator as the main-process stroke humanizer. */
export function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point on a squiggle, in the caller's coordinate space. */
export type SquigglePoint = { x: number; y: number };

/**
 * A wobbly straight line from (x1,y1) to (x2,y2), as points.
 *
 * The point form is the primitive rather than the path string, because the
 * saved gallery PNG has to draw the same chrome on a 2D canvas, where there is
 * no path parser (260728). Both the SVG components and the exporter build on
 * this so the frames on screen and the frames in the file are one function.
 */
export function squiggleLinePoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: string,
  amp = 1.6,
): SquigglePoint[] {
  const rng = makeRng(seed);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.round(len / 18));
  const nx = -(y2 - y1) / (len || 1);
  const ny = (x2 - x1) / (len || 1);
  const phase = rng() * Math.PI * 2;

  // The wobble has to scale with LENGTH (260729): at a fixed t*5.3 the whole
  // side carries under one wave whatever its size, so the big canvas box came
  // out with a ~1.8px bend over 900px and read as a machine-straight rule
  // while every small button around it wobbled. One slow wave per ~130px
  // (min: the old constant, so short sides render pixel-identical), and the
  // amplitude grows a little with length, capped well below anything that
  // would read as a different pen.
  const waves = Math.max(5.3, len / 55);
  const lenAmp = amp * Math.min(1.5, Math.max(1, len / 420));

  const pts: SquigglePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Taper to zero at both ends so the line meets its neighbours cleanly.
    const taper = Math.sin(Math.PI * t);
    const off = (Math.sin(t * waves + phase) * 0.7 + Math.sin(t * waves * 2.2 + phase * 2) * 0.3) * lenAmp * taper;
    pts.push({ x: x1 + (x2 - x1) * t + nx * off, y: y1 + (y2 - y1) * t + ny * off });
  }
  return pts;
}

function toPath(pts: SquigglePoint[]): string {
  return `M ${pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ')}`;
}

/**
 * A wobbly straight line from (x1,y1) to (x2,y2), as a smooth path.
 * `amp` is the peak deviation in px.
 */
export function squiggleLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  seed: string,
  amp = 1.6,
): string {
  return toPath(squiggleLinePoints(x1, y1, x2, y2, seed, amp));
}

/**
 * The four sides of a wobbly rectangle, as separate polylines. Same geometry
 * squiggleRect renders; separate so a canvas can stroke each side.
 */
export function squiggleRectPolylines(
  w: number,
  h: number,
  seed: string,
  amp = 1.8,
  inset = 2,
): SquigglePoint[][] {
  const rng = makeRng(seed);
  const jit = (): number => (rng() - 0.5) * 3;
  const x0 = inset + jit();
  const y0 = inset + jit();
  const x1 = w - inset + jit();
  const y1 = h - inset + jit();
  return [
    squiggleLinePoints(x0, y0, x1, y0, `${seed}-t`, amp),
    squiggleLinePoints(x1, y0, x1, y1, `${seed}-r`, amp),
    squiggleLinePoints(x1, y1, x0, y1, `${seed}-b`, amp),
    squiggleLinePoints(x0, y1, x0, y0, `${seed}-l`, amp),
  ];
}

/**
 * A wobbly rectangle outline, drawn as four tapered sides with slightly
 * overshooting corners so it looks drawn rather than constructed.
 */
export function squiggleRect(
  w: number,
  h: number,
  seed: string,
  amp = 1.8,
  inset = 2,
): string {
  return squiggleRectPolylines(w, h, seed, amp, inset).map(toPath).join(' ');
}

/**
 * A closed, rough blob filling w x h — the marker swipe behind a selected or
 * hovered button (260728).
 *
 * A CSS background is a perfect rectangle, which is the one shape nothing else
 * on this page is allowed to be. This overshoots the box on all four sides by a
 * few px and wobbles as it goes, so a selected button reads as something
 * scribbled over rather than a filled cell.
 */
export function squiggleBlob(w: number, h: number, seed: string, amp = 3.5): string {
  const rng = makeRng(seed);
  const jit = (): number => (rng() - 0.5) * amp * 2;
  // Bleed past the box: a highlighter never stops exactly on the letters.
  const bleed = amp;
  const x0 = -bleed + jit();
  const y0 = -bleed + jit();
  const x1 = w + bleed + jit();
  const y1 = h + bleed + jit();
  const pts = [
    ...squiggleLinePoints(x0, y0, x1, y0, `${seed}-t`, amp),
    ...squiggleLinePoints(x1, y0, x1, y1, `${seed}-r`, amp),
    ...squiggleLinePoints(x1, y1, x0, y1, `${seed}-b`, amp),
    ...squiggleLinePoints(x0, y1, x0, y0, `${seed}-l`, amp),
  ];
  return `${toPath(pts)} Z`;
}

/**
 * The round sibling of squiggleBlob, for controls whose outline is an ellipse.
 * A rectangular swipe behind a circular ring reads as two unrelated shapes.
 */
export function squiggleBlobEllipse(w: number, h: number, seed: string, amp = 3): string {
  const rng = makeRng(seed);
  const phase = rng() * Math.PI * 2;
  const cx = w / 2;
  const cy = h / 2;
  // Overshoot the box, like the rectangular swipe.
  const rx = w / 2 + amp * 0.6;
  const ry = h / 2 + amp * 0.6;
  const steps = 40;
  const pts: SquigglePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wob = (Math.sin(a * 3 + phase) * 0.6 + Math.sin(a * 7 + phase * 2) * 0.4) * amp;
    pts.push({ x: cx + Math.cos(a) * (rx + wob), y: cy + Math.sin(a) * (ry + wob) });
  }
  return `${toPath(pts)} Z`;
}

/** A wobbly ellipse, for the round buttons and the selected-tool ring. */
export function squiggleEllipse(w: number, h: number, seed: string, amp = 1.6): string {
  const rng = makeRng(seed);
  const phase = rng() * Math.PI * 2;
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - amp - 1;
  const ry = h / 2 - amp - 1;
  const steps = 44;
  const pts: string[] = [];
  // Start at a random angle and overshoot slightly past a full turn, so the
  // join is a visible overlap rather than a seam.
  const start = rng() * Math.PI * 2;
  for (let i = 0; i <= steps + 2; i++) {
    const a = start + (i / steps) * Math.PI * 2;
    const wob = (Math.sin(a * 3 + phase) * 0.6 + Math.sin(a * 7 + phase * 2) * 0.4) * amp;
    pts.push(`${(cx + Math.cos(a) * (rx + wob)).toFixed(2)},${(cy + Math.sin(a) * (ry + wob)).toFixed(2)}`);
  }
  return `M ${pts.join(' L ')}`;
}
