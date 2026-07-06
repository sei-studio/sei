/**
 * GatherPixels — the 5×5 "gathering pixels" mark (mockup .gpx5). Abstract,
 * symmetric patterns whose body cells scatter in, two pale cells land last,
 * everything disperses, and the next pattern in the cycle rebuilds. Used by
 * dormant party slots and the Awaken "Be matched" hero.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §1; mockup GPX_PATTERNS.
 */

import React, { useEffect, useState } from 'react';
import styles from './GatherPixels.module.css';

type Cell = [number, number];
interface Pattern {
  body: Cell[];
  eyes: Cell[];
}

const PATTERNS: Record<string, Pattern> = {
  a: {
    body: [[1, 2], [1, 4], [2, 3], [3, 1], [3, 3], [3, 5], [4, 2], [4, 3], [4, 4], [5, 2], [5, 4]],
    eyes: [[2, 2], [2, 4]],
  },
  b: {
    body: [[1, 1], [1, 5], [2, 2], [2, 4], [3, 3], [4, 1], [4, 3], [4, 5], [5, 2], [5, 4]],
    eyes: [[3, 2], [3, 4]],
  },
  c: {
    body: [[1, 2], [1, 3], [1, 4], [3, 3], [4, 2], [4, 4], [5, 1], [5, 3], [5, 5]],
    eyes: [[2, 2], [2, 4]],
  },
  d: {
    body: [[1, 3], [2, 1], [2, 5], [3, 2], [3, 3], [3, 4], [4, 1], [4, 5], [5, 3]],
    eyes: [[4, 2], [4, 4]],
  },
  e: {
    body: [[1, 2], [1, 4], [2, 1], [2, 5], [3, 3], [4, 2], [4, 4], [5, 3]],
    eyes: [[3, 2], [3, 4]],
  },
  f: {
    body: [[1, 3], [2, 2], [2, 4], [3, 1], [3, 5], [4, 3], [5, 2], [5, 4]],
    eyes: [[4, 2], [4, 4]],
  },
  g: {
    body: [[1, 1], [1, 3], [1, 5], [2, 2], [2, 4], [3, 3], [5, 2], [5, 3], [5, 4]],
    eyes: [[4, 2], [4, 4]],
  },
  h: {
    body: [[1, 2], [1, 4], [2, 3], [3, 2], [3, 4], [4, 3], [5, 1], [5, 5]],
    eyes: [[3, 1], [3, 5]],
  },
  i: {
    body: [[1, 3], [2, 2], [2, 3], [2, 4], [3, 1], [3, 5], [4, 2], [4, 4], [5, 3]],
    eyes: [[3, 2], [3, 4]],
  },
  j: {
    body: [[1, 1], [1, 5], [2, 3], [3, 2], [3, 4], [4, 1], [4, 5], [5, 3]],
    eyes: [[2, 2], [2, 4]],
  },
  k: {
    body: [[1, 2], [1, 3], [1, 4], [2, 1], [2, 5], [4, 2], [4, 3], [4, 4], [5, 1], [5, 5]],
    eyes: [[3, 2], [3, 4]],
  },
  l: {
    body: [[1, 3], [2, 1], [2, 3], [2, 5], [3, 2], [3, 4], [5, 2], [5, 3], [5, 4]],
    eyes: [[4, 2], [4, 4]],
  },
};

/** Three patterns per cycle; each gathering forms the next in its cycle
 * (mockup GPX_CYCLES — one cycle per wall slot so no two slots match). */
export type GatherCycle = 'a' | 'b' | 'c' | 'd';
const CYCLES: Record<GatherCycle, string[]> = {
  a: ['a', 'e', 'f'],
  b: ['b', 'g', 'h'],
  c: ['c', 'i', 'j'],
  d: ['d', 'k', 'l'],
};

interface GatherPixelsProps {
  /** Which pattern cycle to play (matches the mockup's data-fig). */
  cycle?: GatherCycle;
  /** Delay (ms) before the first gathering starts, so adjacent slots don't
   * pulse in lockstep (mockup: slotIdx * 700). */
  stagger?: number;
  /** Large variant (13px cells vs 11px). */
  large?: boolean;
  className?: string;
}

export function GatherPixels({
  cycle = 'd',
  stagger = 0,
  large,
  className,
}: GatherPixelsProps): React.ReactElement {
  const [step, setStep] = useState(0);
  useEffect(() => {
    // The swap interval starts after the stagger so cycle N swaps at
    // stagger + 8s·N — first-cycle cell delays below carry the same offset,
    // keeping the whole timeline shifted as one piece.
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      interval = window.setInterval(() => setStep((s) => s + 1), 8000);
    }, stagger);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [stagger]);

  const names = CYCLES[cycle];
  const p = PATTERNS[names[step % names.length]];
  // Cells use `animation-fill-mode: both`, so shifting the first cycle's
  // delays holds them invisible (0% frame) until the stagger elapses — no
  // layout jump, and adjacent slots gather out of phase.
  const offset = step === 0 ? stagger / 1000 : 0;

  return (
    <span
      className={[styles.gpx, large ? styles.lg : '', className ?? ''].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      {p.body.map(([r, c], i) => (
        <b
          key={`b${step}-${r}-${c}`}
          style={{
            gridArea: `${r} / ${c}`,
            animationDelay: `${(offset + (((i * 37) % 17) / 17) * 2.2).toFixed(2)}s`,
          }}
        />
      ))}
      {p.eyes.map(([r, c], i) => (
        <b
          key={`e${step}-${r}-${c}`}
          className={styles.skin}
          style={{ gridArea: `${r} / ${c}`, animationDelay: `${(offset + 2.5 + i * 0.3).toFixed(2)}s` }}
        />
      ))}
    </span>
  );
}
