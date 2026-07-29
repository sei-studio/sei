/**
 * DrawCanvas — the white page. The only component that owns a rendering
 * context, which is why it also handles the two pixel-side pushes:
 * draw:snapshot-request (rasterize what is on screen right now) and
 * draw:ai-stroke (queue the character's strokes and play them at hand speed).
 *
 * Three modes:
 *   player-draw  the player's pen and stroke eraser are live; `strokes` from
 *                main is authoritative and the in-progress stroke is local.
 *   ai-draw      input is dead. `strokes` from main is deliberately IGNORED in
 *                favour of a local revealed list fed by draw:ai-stroke, because
 *                main knows the whole picture well before the player should see
 *                it (see the note in src/shared/drawIpc.ts).
 *   view         static: turn reveal and gallery previews.
 *
 * Rendering is a rAF loop gated on a dirty flag, and the in-progress stroke
 * lives in a ref rather than state, so dragging the pen does not re-render
 * React on every pointermove.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { CANVAS_H, CANVAS_W, type DrawAiStroke, type DrawPoint, type DrawStroke } from '@shared/drawIpc';
import { drawApi } from '../../lib/stores/useDrawStore';
import {
  ERASER_RADIUS,
  MIN_POINT_SPACING,
  hitTestStroke,
  paintStrokes,
  pencilCssWidth,
  strokesToPng,
} from './drawRender';
import styles from './draw.module.css';

/** Width of the PNG sent to the character. Small on purpose: a doodle stays
 *  legible far below canvas resolution, and vision tokens scale with area. */
const SNAPSHOT_WIDTH = 640;

export type DrawCanvasMode = 'player-draw' | 'ai-draw' | 'view';

export interface DrawCanvasProps {
  characterId: string;
  /** Committed strokes from main. Ignored in ai-draw mode (see above). */
  strokes: DrawStroke[];
  mode: DrawCanvasMode;
  tool: 'pen' | 'eraser';
  /** Identifies the current turn; a change resets local playback state. */
  turnToken: string;
  /**
   * DrawGameState.clearSeq: bumped when the character wipes its own page with
   * the `clear` tool. The revealed list is local and deliberately survives a
   * state push, so this is the only thing that can throw it away mid-turn.
   */
  clearToken: number;
  onStroke: (stroke: DrawStroke) => void;
  onErase: (strokeId: string) => void;
}

interface Playing {
  stroke: DrawStroke;
  /** Wall-clock ms when the stroke itself should begin (after its pause). */
  startAt: number;
  durationMs: number;
}

export function DrawCanvas({
  characterId,
  strokes,
  mode,
  tool,
  turnToken,
  clearToken,
  onStroke,
  onErase,
}: DrawCanvasProps): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const dirty = useRef(true);
  const live = useRef<DrawPoint[] | null>(null);
  const drawing = useRef(false);

  // Character playback state.
  const queue = useRef<DrawAiStroke[]>([]);
  const playing = useRef<Playing | null>(null);
  const revealed = useRef<DrawStroke[]>([]);

  // Latest props for the rAF loop and the push handlers, which are registered
  // once and must not close over stale values.
  const propsRef = useRef({ strokes, mode, turnToken });
  propsRef.current = { strokes, mode, turnToken };

  /** What is actually on screen right now, live stroke excluded. */
  const displayed = useCallback((): DrawStroke[] => {
    return propsRef.current.mode === 'ai-draw' ? revealed.current : propsRef.current.strokes;
  }, []);

  // Reset playback whenever the turn changes: strokes queued for a turn that
  // has ended must never bleed into the next one. Also on a mid-turn wipe,
  // which is the same reset without the turn ending.
  useEffect(() => {
    queue.current = [];
    playing.current = null;
    revealed.current = [];
    live.current = null;
    drawing.current = false;
    dirty.current = true;
  }, [turnToken, clearToken]);

  useEffect(() => {
    dirty.current = true;
  }, [strokes, mode]);

  // ── the character's strokes ────────────────────────────────────────────────
  useEffect(() => {
    const off = drawApi().onDrawAiStroke?.((s: DrawAiStroke) => {
      if (s.characterId !== characterId) return;
      // Late stroke from a turn that has already ended.
      if (s.turnKey !== propsRef.current.turnToken) return;
      queue.current.push(s);
    });
    return () => off?.();
  }, [characterId]);

  // ── snapshots for the character to look at ────────────────────────────────
  useEffect(() => {
    const off = drawApi().onDrawSnapshotRequest?.((r) => {
      if (r.characterId !== characterId) return;
      // Include the in-progress stroke. This is what keeps the character
      // talking while the player is 30 seconds into one long unbroken
      // outline, where no stroke has been committed yet.
      const withLive = live.current
        ? [...displayed(), { id: 'live', points: live.current }]
        : displayed();
      let dataUrl = '';
      try {
        dataUrl = strokesToPng(withLive, SNAPSHOT_WIDTH);
      } catch {
        dataUrl = '';
      }
      void drawApi().drawSnapshot?.(r.requestId, dataUrl)?.catch(() => {});
    });
    return () => off?.();
  }, [characterId, displayed]);

  // ── sizing ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const host = wrap?.parentElement;
    if (!wrap || !canvas || !host) return;
    const resize = (): void => {
      // Fit 10:7 inside whatever the box leaves, in px, rather than leaning on
      // `aspect-ratio` + `max-width`: that pair clamps the width and keeps the
      // definite height, so on a box wider than 10:7 the paper came out
      // stretched, and a stretched paper means the pointer and the painted
      // stroke no longer agree (paintStrokes scales by width alone).
      const avail = host.getBoundingClientRect();
      const cssW = Math.max(1, Math.min(avail.width, (avail.height * CANVAS_W) / CANVAS_H));
      wrap.style.width = `${cssW}px`;
      wrap.style.height = `${(cssW * CANVAS_H) / CANVAS_W}px`;

      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        dirty.current = true;
      }
      // Tell the chrome how thick the pen currently looks, so every squiggle
      // on the page is drawn at the width of the strokes on this canvas.
      //
      // Published on the SURFACE ROOT rather than on our own parent (260728):
      // scoping it to the canvas frame meant the frame matched the pen while
      // the rules, the chat box and the buttons stayed on the static fallback,
      // which is the drift the single-pen rule exists to prevent.
      wrap
        .closest<HTMLElement>(`.${styles.root}`)
        ?.style.setProperty('--hand-stroke', `${pencilCssWidth(rect.width).toFixed(2)}px`);
    };
    resize();
    // The HOST is observed, not the wrap: the wrap's size is now an output of
    // this function, so watching it would be watching our own writes.
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // ── render loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const frame = (): void => {
      const canvas = canvasRef.current;
      if (canvas) {
        const now = performance.now();

        // Advance playback.
        if (propsRef.current.mode === 'ai-draw') {
          if (!playing.current && queue.current.length > 0) {
            const next = queue.current.shift() as DrawAiStroke;
            playing.current = {
              stroke: next.stroke,
              startAt: now + next.delayBeforeMs,
              durationMs: Math.max(1, next.durationMs),
            };
          }
          const p = playing.current;
          if (p && now >= p.startAt) {
            dirty.current = true;
            if (now >= p.startAt + p.durationMs) {
              revealed.current = [...revealed.current, p.stroke];
              playing.current = null;
            }
          }
        }

        if (dirty.current) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const scale = canvas.width / CANVAS_W;
            const p = playing.current;
            const partial =
              propsRef.current.mode === 'ai-draw' && p && now >= p.startAt
                ? {
                    points: p.stroke.points,
                    upto:
                      ((now - p.startAt) / p.durationMs) * Math.max(1, p.stroke.points.length - 1),
                  }
                : live.current
                  ? { points: live.current, upto: Math.max(1, live.current.length - 1) }
                  : null;
            paintStrokes(ctx, displayed(), { background: '#ffffff', scale, partial });
          }
          dirty.current = false;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [displayed]);

  // ── pointer input ─────────────────────────────────────────────────────────
  const toLogical = (e: React.PointerEvent): DrawPoint => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // ONE scale for input and paint. paintStrokes scales by width alone, so
    // mapping y by rect.height put the ink above the cursor whenever the box
    // was not exactly 10:7. The resize fit keeps it 10:7; this keeps the pen
    // under the cursor even if it ever is not.
    const sc = Math.max(1e-6, rect.width / CANVAS_W);
    const clamp = (v: number, hi: number): number => Math.min(hi, Math.max(0, v));
    return {
      x: clamp((e.clientX - rect.left) / sc, CANVAS_W),
      y: clamp((e.clientY - rect.top) / sc, CANVAS_H),
    };
  };

  const eraseAt = (p: DrawPoint): void => {
    const hit = hitTestStroke(propsRef.current.strokes, p, ERASER_RADIUS);
    if (hit) onErase(hit.id);
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (mode !== 'player-draw') return;
    // Pen/touch/mouse all fine; ignore secondary buttons.
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toLogical(e);
    if (tool === 'eraser') {
      drawing.current = true;
      eraseAt(p);
      return;
    }
    drawing.current = true;
    live.current = [p];
    dirty.current = true;
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drawing.current || mode !== 'player-draw') return;
    const p = toLogical(e);
    if (tool === 'eraser') {
      eraseAt(p);
      return;
    }
    const pts = live.current;
    if (!pts) return;
    const last = pts[pts.length - 1];
    // Decimate: a raw pointer stream is far denser than the line needs, and
    // every point is sent across the IPC bridge.
    if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_SPACING) return;
    pts.push(p);
    dirty.current = true;
  };

  const finishStroke = (e: React.PointerEvent): void => {
    if (!drawing.current) return;
    drawing.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    const pts = live.current;
    live.current = null;
    dirty.current = true;
    if (tool === 'eraser' || !pts) return;
    // A tap with no travel still counts: duplicate the point so the stroke has
    // a segment and renders as a dot.
    const points = pts.length === 1 ? [pts[0], { x: pts[0].x + 0.5, y: pts[0].y }] : pts;
    if (points.length < 2) return;
    onStroke({ id: `p-${Date.now()}-${Math.round(Math.random() * 1e6)}`, points });
  };

  const interactive = mode === 'player-draw';
  return (
    <div
      ref={wrapRef}
      className={styles.canvasWrap}
      data-tool={interactive ? tool : 'none'}
    >
      {/* No frame in here (260728). The drawn box is .canvasBox one level up,
          because it holds the tools as well as the paper; a second outline this
          close inside it would read as two boxes. The canvas paints an opaque
          white background over its whole box, so anything that must stay
          visible above it needs .frameHost's z-index, which .canvasBox's frame
          has. */}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        style={{ touchAction: 'none', cursor: interactive ? 'crosshair' : 'default' }}
      />
    </div>
  );
}
