import { describe, expect, it } from 'vitest';
import { edgeMatte, keyAlpha, unmixKey, vignetteAlpha } from './portraitCutout';

/** An RGBA image filled by fn(x, y) -> [r, g, b, a]. */
function img(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4);
  return d;
}

const W = 80;
const H = 100;
const CARD: [number, number, number, number] = [248, 250, 255, 255];
const INK: [number, number, number, number] = [30, 30, 40, 255];
const DRESS: [number, number, number, number] = [240, 244, 240, 255];

/** A bust on a flat card: a dark-outlined disc head over a body that runs off the bottom, with a near-white dress inside the outline. */
function bust(x: number, y: number): [number, number, number, number] {
  const head = Math.hypot(x - 40, y - 35);
  const inBody = y > 60 && Math.abs(x - 40) < 26;
  if (head < 18) return head > 15 ? INK : [250, 220, 200, 255];
  if (inBody) return Math.abs(x - 40) > 22 || y < 64 ? INK : DRESS;
  return CARD;
}

describe('keyAlpha', () => {
  it('keys a flat card from the edges and keeps a light dress inside the outline', () => {
    const d = img(W, H, bust);
    const r = keyAlpha(d, W, H);
    expect(r).not.toBeNull();
    const a = (x: number, y: number): number => r!.alpha[y * W + x];
    expect(a(2, 2)).toBe(0); // card corner
    expect(a(40, 35)).toBe(255); // face
    expect(a(40, 85)).toBe(255); // dress, the same light tone as the card
    expect(a(5, 90)).toBe(0); // card beside the body
    expect(r!.fg).toBeGreaterThan(0.15);
    expect(r!.fg).toBeLessThan(0.6);
  });

  it('refuses a busy painted background', () => {
    let seed = 1;
    const noise = (): number => ((seed = (seed * 16807) % 2147483647) % 256);
    const d = img(W, H, (x, y) => (Math.hypot(x - 40, y - 40) < 20 ? INK : [noise(), noise(), noise(), 255]));
    expect(keyAlpha(d, W, H)).toBeNull();
  });

  it('refuses a picture that is all card', () => {
    const d = img(W, H, () => CARD);
    expect(keyAlpha(d, W, H)).toBeNull();
  });

  it('treats an already transparent background as background', () => {
    const d = img(W, H, (x, y) => (Math.hypot(x - 40, y - 50) < 25 ? INK : [0, 0, 0, 0]));
    const r = keyAlpha(d, W, H);
    expect(r).not.toBeNull();
    expect(r!.alpha[0]).toBe(0);
    expect(r!.alpha[50 * W + 40]).toBe(255);
  });

  it('gives edge pixels partial alpha and unmixes the card colour from them', () => {
    // Head edge antialiased half-way into the card.
    const d = img(W, H, (x, y) => {
      const r = Math.hypot(x - 40, y - 45);
      if (r < 20) return INK;
      if (r < 21) return [139, 140, 147, 255]; // 50% ink over card
      return CARD;
    });
    const r = keyAlpha(d, W, H)!;
    expect(r).not.toBeNull();
    const edge = 45 * W + 40 + 20; // x = 60, the ring
    expect(r.alpha[edge]).toBeGreaterThan(0);
    expect(r.alpha[edge]).toBeLessThan(255);
    unmixKey(d, r.alpha, r.key);
    // After unmixing the rim is darker than the mixed pixel was (closer to ink).
    expect(d[edge * 4]).toBeLessThan(139);
    expect(d[3]).toBe(0);
  });
});

describe('vignetteAlpha', () => {
  it('keeps the head and shoulders and drops the top corners', () => {
    expect(vignetteAlpha(50, 42, 100, 100)).toBeGreaterThan(0.99);
    expect(vignetteAlpha(50, 95, 100, 100)).toBeGreaterThan(0.99);
    expect(vignetteAlpha(2, 2, 100, 100)).toBeLessThan(0.01);
    expect(vignetteAlpha(98, 5, 100, 100)).toBeLessThan(0.01);
    const mid = vignetteAlpha(84, 40, 100, 100);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(1);
  });
});

describe('edgeMatte (261105)', () => {
  const WALL: [number, number, number, number] = [70, 54, 44, 255];
  const HAIR: [number, number, number, number] = [170, 110, 80, 255];
  const EW = 200;
  const EH = 250;
  /** A bust under a dark wall: a dome of hair (top 18% down) over hair and shoulders to the bottom. */
  const bustOn = (hair: [number, number, number, number]) => (x: number, y: number): [number, number, number, number] =>
    Math.hypot((x - 100) / 85, (y - 125) / 80) < 1 || (y >= 125 && x >= 15 && x <= 185) ? hair : WALL;

  it('cuts the wall above her hair and keeps the hair', () => {
    const d = img(EW, EH, bustOn(HAIR));
    const m = edgeMatte(d, EW, EH);
    expect(m).not.toBeNull();
    expect(m![20 * EW + 100]).toBe(0); // wall over her head
    expect(m![60 * EW + 100]).toBe(1); // her hair
    expect(m![200 * EW + 100]).toBe(1);
  });

  it('stands down when her hair is the wall colour (the scan runs into her)', () => {
    const d = img(EW, EH, bustOn([76, 58, 46, 255]));
    expect(edgeMatte(d, EW, EH)).toBeNull();
  });

  it('removes nothing when she runs off the top', () => {
    const d = img(EW, EH, (x) => (Math.abs(x - 100) < 80 ? HAIR : WALL));
    expect(edgeMatte(d, EW, EH)).toBeNull();
  });
});
