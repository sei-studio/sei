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
import {
  squiggleBlob,
  squiggleBlobEllipse,
  squiggleEllipse,
  squiggleLine,
  squiggleRect,
} from './squigglePath';
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
  className?: string;
}

/**
 * A wobbly outline filling the nearest positioned ancestor.
 *
 * There is deliberately NO strokeWidth prop (260728). Width and colour come
 * from CSS alone — `--hand-stroke` and `currentColor` — because every line on
 * this surface has to read as the same pen, and a per-call-site number is how
 * that drifted in the first place (the canvas frame was 2.5, everything else
 * 2, the pen about 3.9).
 */
export function SquiggleFrame({
  seed,
  shape = 'rect',
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
          <path d={d} className={styles.handPath} fill="none" stroke="currentColor" strokeLinecap="round" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * The marker swipe behind a selected or hovered control.
 *
 * Rendered ALWAYS and revealed with opacity from CSS, because a hover state
 * cannot mount a component: the shape has to already exist for `:hover` to show
 * it, and re-seeding it on every pointer entry would make it crawl.
 *
 * It paints behind its siblings, so anything that must stay legible on top of
 * it needs `.btnLabel` (position + z-index); a bare text node has no box to
 * raise.
 */
export function SquiggleHighlight({
  seed,
  shape = 'rect',
}: {
  seed: string;
  shape?: 'rect' | 'ellipse';
}): React.ReactElement {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const { w, h } = useSize(hostRef);
  return (
    <span ref={hostRef} className={styles.highlightHost} aria-hidden="true">
      {w > 2 && h > 2 ? (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className={styles.frameSvg}
          style={{ overflow: 'visible' }}
        >
          <path
            d={
              shape === 'ellipse'
                ? squiggleBlobEllipse(w, h, seed)
                : squiggleBlob(w, h, seed)
            }
            fill="currentColor"
            stroke="none"
          />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * A wobbly underline pinned to the bottom of the nearest positioned ancestor,
 * for the quiet text buttons. It exists so nothing on this page has to use
 * `text-decoration: underline`, which is the one perfectly straight line CSS
 * draws for you and the last machine-made line left on the surface.
 */
export function SquiggleUnderline({ seed }: { seed: string }): React.ReactElement {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const { w } = useSize(hostRef);
  const h = 8;
  return (
    <span ref={hostRef} className={styles.underline} aria-hidden="true">
      {w > 2 ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={styles.frameSvg}>
          <path
            d={squiggleLine(1, h / 2, w - 1, h / 2, seed)}
            className={styles.handPath}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

/** A wobbly horizontal rule spanning its parent. Width/colour from CSS, as above. */
export function SquiggleRule({ seed }: { seed: string }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { w } = useSize(hostRef);
  const h = 8;
  return (
    <div ref={hostRef} className={styles.rule} aria-hidden="true">
      {w > 2 ? (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <path
            d={squiggleLine(1, h / 2, w - 1, h / 2, seed)}
            className={styles.handPath}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </div>
  );
}
