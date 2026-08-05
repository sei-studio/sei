/**
 * CallOverlay (260706; 260804 avatar rework) — the always-on-top avatar
 * overlay's ROOT component.
 *
 * Mounted (only) in the dedicated overlay BrowserWindow, which loads the
 * renderer bundle with `?overlay=1` (see main.tsx). It never mounts the full
 * App: it subscribes to the main-process `voice:overlay-state` push and
 * renders one tile per companion — static portrait (lit while speaking,
 * darkened while idle, unless "always bright") or the Live2D model.
 *
 * 260804 interaction, split into VIEW and EDIT modes (260805):
 *  - VIEW (default): the overlay is completely fixed — no dragging, no
 *    resizing. Hover shows the outline and ONE pencil button; clicking the
 *    pencil enters edit mode. The window is click-through by default with
 *    pointer events still FORWARDED (main sets ignoreMouseEvents
 *    {forward: true}) so hover works; while hovered we ask main for real
 *    clicks (avatarOverlayInteractive) so the pencil is pressable.
 *  - EDIT: the pencil becomes a tick (click to leave), the hold-to-drag
 *    button (`-webkit-app-region: drag`) appears above it, corner handles
 *    resize, the wheel zooms around the center, and dragging anywhere on the
 *    tiles moves the window (screen-delta stream over avatar:overlay-move).
 *    The window stays interactive for the whole mode, hover or not.
 * Tile size is pure CSS off the window height (main sizes the window;
 * height = tile + 2*16px chrome padding), so every resize path stays
 * consistent by construction.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AvatarEmotion, CallOverlayState } from '@shared/ipc';
import { sei } from './lib/ipcClient';
import { portraitSrc } from './lib/portraitSrc';
import { pickPalette } from './lib/portraitPalettes';
import { PixelPortrait } from './components/PixelPortrait';
import { Live2DView } from './lib/live2d/Live2DView';
import styles from './CallOverlay.module.css';

/** Vertical chrome padding per edge — MUST match callOverlay.ts PAD_Y and the
 * .stage padding in CallOverlay.module.css. */
const PAD_Y = 16;
const MIN_TILE = 48;
const MAX_TILE = 1024;

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const OPPOSITE: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

/** Tile edge in px, derived from the window height (re-measured on resize). */
function useTilePx(): number {
  const [px, setPx] = useState(() => Math.max(MIN_TILE, window.innerHeight - PAD_Y * 2));
  useEffect(() => {
    const onResize = (): void => setPx(Math.max(MIN_TILE, window.innerHeight - PAD_Y * 2));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return px;
}

export function CallOverlay(): React.ReactElement | null {
  const [state, setState] = useState<CallOverlayState | null>(null);
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Live2D tiles that failed to load — they fall back to the static tile. */
  const [live2dFailed, setLive2dFailed] = useState<Record<string, boolean>>({});
  const tilePx = useTilePx();

  // Per-character mouth-level refs, mutated by the level push at ~25 Hz and
  // read per frame by Live2DView — never React state (that would re-render
  // the tree per sample). -1 = "no feed yet" (Live2DView pseudo-envelopes).
  const levelRefs = useRef<Record<string, { current: number }>>({});
  const levelRefFor = (id: string): { current: number } => {
    levelRefs.current[id] ??= { current: -1 };
    return levelRefs.current[id];
  };

  useEffect(() => {
    const offState = sei.onVoiceOverlayState?.((s) => setState(s));
    const offLevel = sei.onAvatarOverlayLevel?.(({ id, level }) => {
      levelRefFor(id).current = level;
    });
    // Main seeds the state with a push at window-reveal, but that push can land
    // BEFORE this subscription exists (React effects run after first paint) —
    // when it did, the overlay stayed blank until the next speaking change. Pull
    // the current state too; a push that already arrived wins (it is newer).
    void sei
      .voiceOverlayGetState?.()
      .then((s) => {
        if (s) setState((prev) => prev ?? s);
      })
      .catch(() => {});
    return () => {
      offState?.();
      offLevel?.();
    };
  }, []);

  // Interactivity: real clicks while hovered (the pencil needs them) and for
  // the whole of edit mode (leaving mid-edit must not drop the handles).
  // Failure is harmless: the chrome shows but cannot be grabbed.
  useEffect(() => {
    void sei.avatarOverlayInteractive?.(hovered || editing).catch(() => {});
  }, [hovered, editing]);
  const onEnter = useCallback((): void => setHovered(true), []);
  const onLeave = useCallback((): void => setHovered(false), []);

  // Corner resize: pointer-capture drag streaming the desired TILE size to
  // main (which recomputes window bounds keeping the opposite corner fixed).
  const beginResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: Corner): void => {
      e.preventDefault();
      const el = e.currentTarget;
      const startX = e.screenX;
      const startY = e.screenY;
      const startSize = Math.max(MIN_TILE, window.innerHeight - PAD_Y * 2);
      const anchor = OPPOSITE[corner];
      let latest = startSize;
      let raf = 0;
      const onMove = (ev: PointerEvent): void => {
        // Outward drag along either axis grows the tile; average the two so
        // diagonal drags feel 1:1 rather than doubled.
        const sx = (corner === 'tr' || corner === 'br' ? 1 : -1) * (ev.screenX - startX);
        const sy = (corner === 'bl' || corner === 'br' ? 1 : -1) * (ev.screenY - startY);
        latest = Math.min(MAX_TILE, Math.max(MIN_TILE, startSize + (sx + sy) / 2));
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            void sei.avatarOverlayResize?.({ size: latest, anchor }).catch(() => {});
          });
        }
      };
      const onUp = (): void => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (raf) cancelAnimationFrame(raf);
        void sei.avatarOverlayResize?.({ size: latest, anchor, commit: true }).catch(() => {});
      };
      el.setPointerCapture(e.pointerId);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [],
  );

  // Edit mode: drag anywhere on the tiles to move the window. Screen-space
  // deltas from pointer-down, rAF-throttled; main anchors them to the window
  // origin it snapshotted at 'start', so the stream stays 1:1 while the
  // window moves under the pointer.
  const beginMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.screenX;
    const startY = e.screenY;
    void sei.avatarOverlayMove?.({ phase: 'start' }).catch(() => {});
    let dx = 0;
    let dy = 0;
    let raf = 0;
    const onMove = (ev: PointerEvent): void => {
      dx = ev.screenX - startX;
      dy = ev.screenY - startY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          void sei.avatarOverlayMove?.({ phase: 'move', dx, dy }).catch(() => {});
        });
      }
    };
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (raf) cancelAnimationFrame(raf);
      void sei.avatarOverlayMove?.({ phase: 'end' }).catch(() => {});
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }, []);

  // Edit mode: wheel zooms the tile around the window center. The stream
  // rides its own size accumulator (window-height feedback lags the IPC);
  // commit fires when the wheel goes quiet.
  const wheelSizeRef = useRef<number | null>(null);
  const wheelCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWheel = useCallback((e: React.WheelEvent): void => {
    wheelSizeRef.current ??= Math.max(MIN_TILE, window.innerHeight - PAD_Y * 2);
    const next = Math.min(
      MAX_TILE,
      Math.max(MIN_TILE, wheelSizeRef.current * Math.exp(-e.deltaY * 0.002)),
    );
    wheelSizeRef.current = next;
    void sei.avatarOverlayResize?.({ size: next, anchor: 'center' }).catch(() => {});
    if (wheelCommitTimer.current) clearTimeout(wheelCommitTimer.current);
    wheelCommitTimer.current = setTimeout(() => {
      wheelCommitTimer.current = null;
      const size = wheelSizeRef.current;
      wheelSizeRef.current = null;
      if (size != null) {
        void sei.avatarOverlayResize?.({ size, anchor: 'center', commit: true }).catch(() => {});
      }
    }, 350);
  }, []);

  if (!state || !state.enabled || state.participants.length === 0) return null;

  return (
    <div
      className={styles.stage}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onWheel={editing ? onWheel : undefined}
      style={{ ['--tile' as string]: `${tilePx}px` }}
    >
      {/* Thin glowing outline while hovered; solid for the whole edit mode. */}
      <div className={`${styles.outline} ${hovered || editing ? styles.outlineOn : ''}`} />

      <div
        className={`${styles.row} ${editing ? styles.rowEditing : ''}`}
        onPointerDown={editing ? beginMove : undefined}
      >
        {state.participants.map((p) => {
          const speaking = p.speaking;
          const useLive2d = p.live2d && !live2dFailed[p.id];
          if (useLive2d) {
            return (
              <div key={p.id} className={styles.live2dTile} title={p.name}>
                <Live2DView
                  characterId={p.id}
                  speaking={speaking}
                  levelRef={levelRefFor(p.id)}
                  emotion={(p.emotion ?? null) as AvatarEmotion | null}
                  className={styles.live2dCanvas}
                  onStatus={(s) => {
                    if (s === 'error') setLive2dFailed((prev) => ({ ...prev, [p.id]: true }));
                  }}
                />
              </div>
            );
          }
          const src = portraitSrc(p.portrait);
          // Overlay floats over arbitrary apps; the dark procedural fallback
          // reads fine on any backdrop, so a fixed dark palette is right here.
          const palette = pickPalette(p.id + p.name, 'dark');
          const indicator = p.alwaysBright
            ? styles.bright
            : speaking
              ? styles.speaking
              : styles.idle;
          const frameClass = p.frame === 'square' ? styles.squareFrame : '';
          return (
            <div
              key={p.id}
              className={`${styles.circle} ${frameClass} ${indicator}`}
              title={p.name}
            >
              {src ? (
                <img src={src} alt="" />
              ) : (
                <PixelPortrait
                  seed={p.id + p.name}
                  palette={palette}
                  size={tilePx}
                  portraitImage={p.portrait ?? undefined}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Edit-mode chrome: corner resize handles + the hold-to-drag button
          (stacked above the mode button). */}
      {editing && (
        <>
          <div className={`${styles.handle} ${styles.tl}`} onPointerDown={(e) => beginResize(e, 'tl')} />
          <div className={`${styles.handle} ${styles.tr}`} onPointerDown={(e) => beginResize(e, 'tr')} />
          <div className={`${styles.handle} ${styles.bl}`} onPointerDown={(e) => beginResize(e, 'bl')} />
          <div className={`${styles.handle} ${styles.br}`} onPointerDown={(e) => beginResize(e, 'br')} />
          <div className={styles.dragBtn} title="">
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="2" cy="2" r="1" /><circle cx="5" cy="2" r="1" /><circle cx="8" cy="2" r="1" />
              <circle cx="2" cy="5" r="1" /><circle cx="5" cy="5" r="1" /><circle cx="8" cy="5" r="1" />
              <circle cx="2" cy="8" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="8" cy="8" r="1" />
            </svg>
          </div>
        </>
      )}

      {/* The mode button: pencil (enter edit) / tick (done). Shown on hover in
          view mode, always while editing. */}
      {(hovered || editing) && (
        <button
          type="button"
          className={styles.modeBtn}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? (
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2 6.5 L4.8 9.2 L10 3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M8.6 1.6 L10.4 3.4 L4.2 9.6 L1.6 10.4 L2.4 7.8 Z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
