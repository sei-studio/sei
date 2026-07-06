/**
 * PixelPortrait — 12×12 deterministic procedural sprite.
 *
 * D-14: deterministic from `id + name` seed. FNV-1a → mulberry32-style PRNG →
 * 12×12 mirrored grid + fixed eye pixels at (row=3, col=4) and (row=3, col=7=12-1-4).
 *
 * Source: 04-UI-SPEC.md §Component Inventory → PixelPortrait + §Interaction
 * Contracts → PixelPortrait determinism (lines ~588–592 — algorithm constants
 * 2246822507 and 3266489909 are NOT arbitrary; they reproduce the prototype's
 * sprite for the same seed).
 *
 * The pure function `generatePixelGrid(seed, palette)` returns a 12×12 array of
 * `#RRGGBB` strings; the React component paints it to <canvas> at the requested
 * `size` with `image-rendering: pixelated` for crisp scaling. Extracting the
 * pure function makes the determinism contract testable without a jsdom
 * canvas mock.
 *
 * Image override: if `portraitImage` is non-null and the <img> loads, we render
 * that instead of the canvas. Missing file → silent fallback to procedural (D-14).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { portraitSrc } from '../lib/portraitSrc';
import { pickPalette } from '../lib/portraitPalettes';
import styles from './PixelPortrait.module.css';

export const GRID_SIZE = 12;
export const EYE_COLOR = '#0E0E0E';

/**
 * Bust silhouette mask (260616). The procedural sprite is carved into a
 * head-and-shoulders shape: cut cells are LEFT UNPAINTED on the <canvas>, so
 * they stay transparent and the live theme background shows through — no baked
 * colour, so it adapts to light/dark on the fly. Cut = the top row, plus the 3
 * outer columns on each side of the top 7 rows (the head) — leaving a 6-wide
 * head (cols 3..8) over rows 1..6 on full-width shoulders (rows 7..11).
 *
 * Applied at paint time only; `generatePixelGrid` still returns the full 12×12
 * colour grid (its determinism contract + acceptance pixels are unchanged).
 */
export function isBustCut(y: number, x: number): boolean {
  return y === 0 || (y <= 6 && (x <= 2 || x >= GRID_SIZE - 3));
}

/** FNV-1a 32-bit hash (matches lib/portraitPalettes.ts).  */
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Mulberry32-style PRNG step.
 * Constants 2246822507 and 3266489909 are part of the determinism contract —
 * UI-SPEC §PixelPortrait determinism line 351–352 — port VERBATIM.
 */
function rngStep(state: { s: number }): number {
  state.s =
    (Math.imul(state.s ^ (state.s >>> 15), 2246822507) ^
      Math.imul(state.s ^ (state.s >>> 13), 3266489909)) >>>
    0;
  return (state.s >>> 0) / 4294967296;
}

/** Lighten 6-digit hex by `amount` (0..1) toward white. Used for head fade-up. */
function _unused_lighten(_hex: string, _a: number): string {
  return _hex; // reserved
}

/**
 * Pure deterministic generator. Returns a 12×12 array of `#RRGGBB` strings.
 *
 * Layout contract (must satisfy the acceptance pixel checks below):
 *   - rows 0..6 (head): 82% non-background, palette index 1 + floor(rng × (palLen-2))
 *   - rows 7..10 (body): 75% non-background, palette index 2 + floor(rng × (palLen-3))
 *   - row 11 (last row): palette[1] (forced bg)
 *   - background cells (col 0, row 11, rng-zeroed in head/body): palette[1] (sky lower)
 *   - left half cols 0..5 generated; right half cols 6..11 mirrored as grid[y][11-x]
 *   - eyes at (row=3, col=4) and (row=3, col=7=12-1-4) forced to EYE_COLOR
 *
 * Quick task 260508-nkk follow-up: rows 0..1 used to be a forced uniform
 * palette[0] "sky band" but it read on the cards as a flat-color stripe
 * masking the top of the sprite. Removed — head logic now runs from row 0.
 *
 * Acceptance pixel checks for seed='sui Sui', theme='light', palette =
 * pickPalette('sui Sui', 'light'):
 *   - grid[3][4] === EYE_COLOR
 *   - grid[3][7] === EYE_COLOR (mirror of col 4)
 *   - grid[5][0] === palette[1] (col 0 is forced bg, lower sky band)
 */
export function generatePixelGrid(
  seed: string,
  palette: string[],
): string[][] {
  const W = GRID_SIZE;
  const H = GRID_SIZE;
  const half = Math.ceil(W / 2);
  // skyTop was 2 (rows 0..1 forced palette[0]) — disabled for quick task
  // 260508-nkk so the sprite's head content fills the whole top of the card.
  const skyTop = 0;
  const bodyStart = 7;
  const palLen = palette.length;

  const ref = { s: hashSeed(seed) || 1 };
  const grid: string[][] = [];

  for (let y = 0; y < H; y++) {
    const row: string[] = new Array(W).fill('');
    // Top sky rows (0..skyTop-1) = palette[0]
    if (y < skyTop) {
      for (let x = 0; x < W; x++) row[x] = palette[0]!;
      grid.push(row);
      continue;
    }
    // Last row = palette[1] (lower sky band)
    if (y === H - 1) {
      for (let x = 0; x < W; x++) row[x] = palette[1]!;
      grid.push(row);
      continue;
    }
    // Mid rows: generate left half deterministically.
    for (let x = 0; x < half; x++) {
      // Force col 0 to background (sky lower band) per algorithm step 5.
      if (x === 0) {
        row[x] = palette[1]!;
        continue;
      }
      let color: string;
      if (y >= bodyStart) {
        // Body: 75% non-bg, palette index 2 + floor(r2 × (palLen-3))
        const r1 = rngStep(ref);
        const r2 = rngStep(ref);
        if (r1 > 0.25) {
          const idx = Math.min(palLen - 1, 2 + Math.floor(r2 * Math.max(1, palLen - 3)));
          color = palette[idx]!;
        } else {
          color = palette[1]!;
        }
      } else {
        // Head (rows 2..6): 82% non-bg, palette index 1 + floor(r2 × (palLen-2))
        const r1 = rngStep(ref);
        const r2 = rngStep(ref);
        if (r1 > 0.18) {
          const idx = Math.min(palLen - 1, 1 + Math.floor(r2 * Math.max(1, palLen - 2)));
          color = palette[idx]!;
        } else {
          color = palette[1]!;
        }
      }
      row[x] = color;
    }
    // Mirror left half to right (col x mirrors to col W-1-x).
    for (let x = 0; x < half; x++) {
      row[W - 1 - x] = row[x]!;
    }
    grid.push(row);
  }

  // Eye pixels: row=3, col=4 (left) and col=7 (mirror of col=4).
  if (grid[3]) {
    grid[3]![4] = EYE_COLOR;
    grid[3]![W - 1 - 4] = EYE_COLOR; // = col 7
  }

  return grid;
}

interface PixelPortraitProps {
  seed: string;
  /**
   * Caller-derived (theme-resolved) palette. Retained for the per-card accent
   * tint the callers compute from it — intentionally NOT used to paint the
   * sprite: the light/dark palettes are luminance-reversed per index, which
   * photo-negatives the sprite between themes. The sprite locks to a single
   * theme-independent palette below so a character reads the same in both modes.
   */
  palette: string[];
  size?: number;
  /** Optional image override path; falls back to procedural on load error. */
  portraitImage?: string | null;
  /**
   * Fires once the portrait override has SETTLED — loaded, failed (procedural
   * fallback shown), or absent. Lets callers hold a wireframe until real
   * pixels are on screen (260705 World-card skeletons). Idempotent callers only.
   */
  onImageSettled?: () => void;
  style?: React.CSSProperties;
  className?: string;
  'aria-label'?: string;
}

export function PixelPortrait({
  seed,
  size = 220,
  portraitImage,
  onImageSettled,
  style,
  className,
  ...rest
}: PixelPortraitProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Lock the sprite to a theme-INDEPENDENT palette so it doesn't photo-negative
  // between light/dark (the two palette sets are luminance-reversed per index).
  // Same seed → same character in both themes; the transparent cuts + themed
  // .root background carry the light/dark difference instead.
  const grid = useMemo(() => generatePixelGrid(seed, pickPalette(seed, 'dark')), [seed]);

  // Paint canvas whenever grid changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = GRID_SIZE;
    canvas.height = GRID_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Clear first so bust-cut cells stay transparent across repaints (theme
    // toggle / seed change) rather than retaining an earlier paint.
    ctx.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (isBustCut(y, x)) continue; // unpainted → transparent → theme bg shows through
        ctx.fillStyle = grid[y]![x]!;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [grid]);

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    ...style,
  };

  // Resolve the bare '<uuid>.png' reference (or pass a cloud URL through) into a
  // loadable src. Without this the override <img> 404s and silently falls back.
  const resolvedSrc = portraitSrc(portraitImage);
  const useImage = !!resolvedSrc && !imgFailed;

  // Settle immediately when there's no image to wait for (no override, or an
  // unresolvable ref) so a wireframe-holding caller is never stranded. The
  // loaded/failed cases fire from the <img> handlers below.
  useEffect(() => {
    if (!useImage) onImageSettled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useImage]);

  // Clear a prior load failure when the source changes (e.g. a re-upload or
  // switching characters) so a stale error doesn't pin us to the sprite.
  useEffect(() => {
    setImgFailed(false);
  }, [resolvedSrc]);

  return (
    <div
      className={[styles.root, className ?? ''].filter(Boolean).join(' ')}
      style={containerStyle}
      role="img"
      aria-label={rest['aria-label'] ?? seed}
    >
      {useImage ? (
        <img
          className={styles.imgOverride}
          src={resolvedSrc!}
          alt=""
          onLoad={() => onImageSettled?.()}
          onError={() => {
            setImgFailed(true);
            onImageSettled?.();
          }}
        />
      ) : (
        <canvas ref={canvasRef} className={styles.canvas} />
      )}
    </div>
  );
}
