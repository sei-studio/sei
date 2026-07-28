/**
 * Hand-drawn line primitives for the Draw! surface.
 *
 * Every rule and border on this screen is one of these rather than a CSS
 * border, so the chrome looks drawn by the same hand as the pictures.
 *
 * They measure their parent with a ResizeObserver instead of stretching a
 * fixed viewBox, because a non-uniform scale would squash the wobble on one
 * axis and the "hand-drawn" read falls apart immediately when it does.
 * The parent must be position: relative.
 */

import React, { useEffect, useRef, useState } from 'react';
import { squiggleEllipse, squiggleLine, squiggleRect } from './squigglePath';
import styles from './draw.module.css';

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: r.width, h: r.height },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

interface FrameProps {
  /** Stable across renders, or the border re-wiggles and looks like it vibrates. */
  seed: string;
  shape?: 'rect' | 'ellipse';
  strokeWidth?: number;
  className?: string;
}

/** A wobbly outline filling the nearest positioned ancestor. */
export function SquiggleFrame({
  seed,
  shape = 'rect',
  strokeWidth = 2,
  className,
}: FrameProps): React.ReactElement {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const { w, h } = useSize(hostRef);
  const d =
    w > 2 && h > 2
      ? shape === 'ellipse'
        ? squiggleEllipse(w, h, seed)
        : squiggleRect(w, h, seed)
      : '';
  return (
    <span ref={hostRef} className={`${styles.frameHost} ${className ?? ''}`} aria-hidden="true">
      {d ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={styles.frameSvg}>
          <path d={d} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
        </svg>
      ) : null}
    </span>
  );
}

/** A wobbly horizontal rule spanning its parent. */
export function SquiggleRule({
  seed,
  strokeWidth = 2,
}: {
  seed: string;
  strokeWidth?: number;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { w } = useSize(hostRef);
  const h = 8;
  return (
    <div ref={hostRef} className={styles.rule} aria-hidden="true">
      {w > 2 ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <path
            d={squiggleLine(1, h / 2, w - 1, h / 2, seed)}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </div>
  );
}
