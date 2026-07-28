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
function makeRng(seed: string): () => number {
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
  const rng = makeRng(seed);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.round(len / 18));
  const nx = -(y2 - y1) / (len || 1);
  const ny = (x2 - x1) / (len || 1);
  const phase = rng() * Math.PI * 2;

  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Taper to zero at both ends so the line meets its neighbours cleanly.
    const taper = Math.sin(Math.PI * t);
    const off = (Math.sin(t * 5.3 + phase) * 0.7 + Math.sin(t * 11.7 + phase * 2) * 0.3) * amp * taper;
    pts.push(`${(x1 + (x2 - x1) * t + nx * off).toFixed(2)},${(y1 + (y2 - y1) * t + ny * off).toFixed(2)}`);
  }
  return `M ${pts.join(' L ')}`;
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
  const rng = makeRng(seed);
  const jit = (): number => (rng() - 0.5) * 3;
  const x0 = inset + jit();
  const y0 = inset + jit();
  const x1 = w - inset + jit();
  const y1 = h - inset + jit();
  return [
    squiggleLine(x0, y0, x1, y0, `${seed}-t`, amp),
    squiggleLine(x1, y0, x1, y1, `${seed}-r`, amp),
    squiggleLine(x1, y1, x0, y1, `${seed}-b`, amp),
    squiggleLine(x0, y1, x0, y0, `${seed}-l`, amp),
  ].join(' ');
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
