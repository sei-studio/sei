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
 * 260804 interaction, split into VIEW and EDIT modes (260805; camera +
 * per-region interactivity 260806):
 *  - VIEW (default): the overlay cannot be resized, and the CHARACTER is
 *    click-through — clicks over her land on whatever is under the window,
 *    like the caption box. Hover shows the outline (static tiles only — a
 *    Live2D companion keeps a clean silhouette until edit mode) and the
 *    chrome buttons: the pencil with the hold-to-drag move button above it,
 *    plus mute + captions while a call/backseat is live. The window is
 *    click-through by default with pointer events still FORWARDED (main sets
 *    ignoreMouseEvents {forward: true}) so hover works; real clicks
 *    (avatarOverlayInteractive) are requested only while the pointer is over
 *    the BUTTON COLUMN, with a short leave-delay so the flag cannot flap at
 *    the column's edge.
 *  - EDIT: the pencil becomes a tick (click to leave) and the corner handles
 *    (the only way to RESIZE the window) come up; the whole window stays
 *    interactive for the whole mode, hover or not. The wheel and drag act on
 *    the CHARACTER, not the window: over a Live2D tile the wheel zooms the
 *    character within its tile (face-only framing and back) and dragging
 *    pans it, streamed to main as a per-character camera
 *    (avatar:overlay-camera) and persisted.
 * The hold-to-drag button (both modes) is ordinary chrome streaming
 * screen-space deltas to main (avatar:overlay-move) — NOT an app-region,
 * which swallows pointer events and would blind the per-region tracking.
 * Tile size is pure CSS off the window height (main sizes the window;
 * height = tile + 2*16px chrome padding), so every resize path stays
 * consistent by construction.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AvatarCamera, AvatarEmotion, CallOverlayState } from '@shared/ipc';
import { sei } from './lib/ipcClient';
import { portraitSrc } from './lib/portraitSrc';
import { pickPalette } from './lib/portraitPalettes';
import { PixelPortrait } from './components/PixelPortrait';
import { Live2DView } from './lib/live2d/Live2DView';
import styles from './CallOverlay.module.css';

/** Top chrome padding — MUST match callOverlay.ts PAD_TOP and the .stage
 * padding in CallOverlay.module.css. There is no bottom padding: the tile's
 * bottom edge is flush with the window's bottom edge (260806). */
const PAD_TOP = 16;
const MIN_TILE = 48;
const MAX_TILE = 1024;

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const OPPOSITE: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

/** Character-camera bounds (mirror the zod caps in main/ipc.ts). */
const CAM_MIN_ZOOM = 0.5;
const CAM_MAX_ZOOM = 8;
const CAM_MAX_PAN = 1.5;
const DEFAULT_CAM: AvatarCamera = { zoom: 1, x: 0, y: 0 };

/** Tile edge in px, derived from the window height (re-measured on resize). */
function useTilePx(): number {
  const [px, setPx] = useState(() => Math.max(MIN_TILE, window.innerHeight - PAD_TOP));
  useEffect(() => {
    const onResize = (): void => setPx(Math.max(MIN_TILE, window.innerHeight - PAD_TOP));
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

  // Interactivity (260806, per-region): real clicks only while the pointer is
  // over the chrome BUTTON COLUMN, and for the whole of edit mode (leaving
  // mid-edit must not drop the handles; edit gestures cover the tiles too).
  // Over the character or the empty stage the window stays click-through, so
  // clicks land on whatever is under her. A short leave-delay keeps the flag
  // from flapping while the pointer skims the column's edge. Failure is
  // harmless: the chrome shows but cannot be grabbed.
  const [overChrome, setOverChrome] = useState(false);
  const chromeLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChromeEnter = useCallback((): void => {
    if (chromeLeaveTimer.current) clearTimeout(chromeLeaveTimer.current);
    chromeLeaveTimer.current = null;
    setOverChrome(true);
  }, []);
  const onChromeLeave = useCallback((): void => {
    if (chromeLeaveTimer.current) clearTimeout(chromeLeaveTimer.current);
    chromeLeaveTimer.current = setTimeout(() => {
      chromeLeaveTimer.current = null;
      setOverChrome(false);
    }, 160);
  }, []);
  useEffect(
    () => () => {
      if (chromeLeaveTimer.current) clearTimeout(chromeLeaveTimer.current);
    },
    [],
  );
  useEffect(() => {
    void sei.avatarOverlayInteractive?.(overChrome || editing).catch(() => {});
  }, [overChrome, editing]);
  const onEnter = useCallback((): void => setHovered(true), []);
  const onLeave = useCallback((): void => setHovered(false), []);

  // The caption window's edit chrome follows the pencil here.
  useEffect(() => {
    void sei.avatarOverlayEditing?.(editing).catch(() => {});
  }, [editing]);

  // ── Character camera (260806): zoom + pan WITHIN the tile ───────────────
  // Local values win while a gesture streams; ids never touched locally fall
  // back to the config-hydrated cameras main enriched into the state.
  const [cams, setCams] = useState<Record<string, AvatarCamera>>({});
  const camsRef = useRef(cams);
  camsRef.current = cams;
  const camFor = (id: string): AvatarCamera =>
    cams[id] ?? state?.cameras?.[id] ?? DEFAULT_CAM;
  const camPushRaf = useRef(0);
  const camCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamCamera = useCallback((id: string, cam: AvatarCamera, commit: boolean): void => {
    setCams((prev) => ({ ...prev, [id]: cam }));
    if (commit) {
      if (camPushRaf.current) cancelAnimationFrame(camPushRaf.current);
      camPushRaf.current = 0;
      void sei.avatarOverlayCamera?.({ id, ...cam, commit: true }).catch(() => {});
      return;
    }
    if (!camPushRaf.current) {
      camPushRaf.current = requestAnimationFrame(() => {
        camPushRaf.current = 0;
        void sei.avatarOverlayCamera?.({ id, ...cam }).catch(() => {});
      });
    }
  }, []);

  /** Edit-mode wheel over a Live2D tile: zoom the character (never the window). */
  const onTileWheel = useCallback(
    (id: string) =>
      (e: React.WheelEvent): void => {
        const cam = camFor(id);
        const zoom = Math.min(
          CAM_MAX_ZOOM,
          Math.max(CAM_MIN_ZOOM, cam.zoom * Math.exp(-e.deltaY * 0.002)),
        );
        streamCamera(id, { ...cam, zoom }, false);
        if (camCommitTimer.current) clearTimeout(camCommitTimer.current);
        camCommitTimer.current = setTimeout(() => {
          camCommitTimer.current = null;
          const latest = camsRef.current[id];
          if (latest) void sei.avatarOverlayCamera?.({ id, ...latest, commit: true }).catch(() => {});
        }, 350);
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamCamera, cams, state],
  );

  /** Edit-mode drag on a Live2D tile: pan the character within the tile. */
  const beginTilePan = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, id: string): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      const el = e.currentTarget;
      const startX = e.screenX;
      const startY = e.screenY;
      const start = camFor(id);
      const tile = Math.max(MIN_TILE, window.innerHeight - PAD_TOP);
      let latest = start;
      const onMove = (ev: PointerEvent): void => {
        latest = {
          zoom: start.zoom,
          x: Math.min(CAM_MAX_PAN, Math.max(-CAM_MAX_PAN, start.x + (ev.screenX - startX) / tile)),
          y: Math.min(CAM_MAX_PAN, Math.max(-CAM_MAX_PAN, start.y + (ev.screenY - startY) / tile)),
        };
        streamCamera(id, latest, false);
      };
      const onUp = (): void => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        streamCamera(id, latest, true);
      };
      el.setPointerCapture(e.pointerId);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamCamera, cams, state],
  );

  // Hold-to-drag window move (260806, both modes): pointer-capture drag on
  // the drag button streaming screen-space deltas to main, which moves the
  // window (mirrors the caption window's beginMove). Screen coordinates stay
  // valid while the window slides under the pointer, and pointer capture
  // keeps the column's hover state pinned for the whole drag.
  const beginWindowMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const startX = e.screenX;
    const startY = e.screenY;
    void sei.avatarOverlayMove?.({ phase: 'start' }).catch(() => {});
    let raf = 0;
    let dx = 0;
    let dy = 0;
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

  // Corner resize: pointer-capture drag streaming the desired TILE size to
  // main (which recomputes window bounds keeping the opposite corner fixed).
  const beginResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: Corner): void => {
      e.preventDefault();
      const el = e.currentTarget;
      const startX = e.screenX;
      const startY = e.screenY;
      const startSize = Math.max(MIN_TILE, window.innerHeight - PAD_TOP);
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

  if (!state || !state.enabled || state.participants.length === 0) return null;
  const hasLive2d = state.participants.some((p) => p.live2d && !live2dFailed[p.id]);
  const onCall = state.onCall === true;

  return (
    <div
      className={styles.stage}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ ['--tile' as string]: `${tilePx}px` }}
    >
      {/* Thin glowing outline: solid for the whole edit mode. On hover only
          for static tiles — a Live2D companion stays frameless in view mode
          (the box around a transparent character reads as a bug, 260806). */}
      <div
        className={`${styles.outline} ${editing || (hovered && !hasLive2d) ? styles.outlineOn : ''}`}
      />

      <div className={styles.row}>
        {state.participants.map((p) => {
          const speaking = p.speaking;
          const useLive2d = p.live2d && !live2dFailed[p.id];
          if (useLive2d) {
            return (
              <div
                key={p.id}
                className={`${styles.live2dTile} ${editing ? styles.live2dEditing : ''}`}
                title={p.name}
                onWheel={editing ? onTileWheel(p.id) : undefined}
                onPointerDown={editing ? (e) => beginTilePan(e, p.id) : undefined}
              >
                <Live2DView
                  characterId={p.id}
                  speaking={speaking}
                  levelRef={levelRefFor(p.id)}
                  emotion={(p.emotion ?? null) as AvatarEmotion | null}
                  camera={camFor(p.id)}
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

      {/* Edit-mode chrome: corner resize handles (the only way to RESIZE the
          window). */}
      {editing && (
        <>
          <div className={`${styles.handle} ${styles.tl}`} onPointerDown={(e) => beginResize(e, 'tl')} />
          <div className={`${styles.handle} ${styles.tr}`} onPointerDown={(e) => beginResize(e, 'tr')} />
          <div className={`${styles.handle} ${styles.bl}`} onPointerDown={(e) => beginResize(e, 'bl')} />
          <div className={`${styles.handle} ${styles.br}`} onPointerDown={(e) => beginResize(e, 'br')} />
        </>
      )}

      {/* Chrome buttons, stacked bottom-right (column-reverse: first child at
          the bottom): the mode button (pencil/tick), then the hold-to-drag
          button directly above it (the only way to MOVE the window, both
          modes since 260806), then mute + captions while a call/backseat is
          live. The column is the overlay's only interactive region in view
          mode — its enter/leave drive the click-through flip. */}
      {(hovered || editing) && (
        <div
          className={styles.btnCol}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={onChromeEnter}
          onPointerLeave={onChromeLeave}
        >
          <button
            type="button"
            className={styles.chromeBtn}
            title={editing ? 'Done' : 'Edit'}
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

          <div className={styles.dragBtn} title="Hold to move" onPointerDown={beginWindowMove}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <circle cx="2" cy="2" r="1" /><circle cx="5" cy="2" r="1" /><circle cx="8" cy="2" r="1" />
              <circle cx="2" cy="5" r="1" /><circle cx="5" cy="5" r="1" /><circle cx="8" cy="5" r="1" />
              <circle cx="2" cy="8" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="8" cy="8" r="1" />
            </svg>
          </div>

          {onCall && (
            <button
              type="button"
              className={`${styles.chromeBtn} ${state.muted ? styles.chromeBtnToggled : ''}`}
              title={state.muted ? 'Unmute' : 'Mute'}
              aria-pressed={state.muted === true}
              onClick={() => void sei.avatarOverlayMuteToggle?.().catch(() => {})}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="4.4" y="1" width="3.2" height="6" rx="1.6" fill="currentColor" />
                <path
                  d="M2.6 5.6 a3.4 3.4 0 0 0 6.8 0 M6 9 v2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
                {state.muted ? (
                  <path
                    d="M1.6 1.6 L10.4 10.4"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                ) : null}
              </svg>
            </button>
          )}

          {onCall && (
            <button
              type="button"
              className={`${styles.chromeBtn} ${state.captionsOn ? styles.chromeBtnToggled : ''}`}
              title="Captions"
              aria-pressed={state.captionsOn === true}
              onClick={() => void sei.avatarOverlayCaptionsToggle?.().catch(() => {})}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect
                  x="1"
                  y="2.4"
                  width="10"
                  height="7.2"
                  rx="1.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <path
                  d="M3 5.4 h2.6 M7 5.4 h2 M3 7.4 h3.6 M8 7.4 h1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}

        </div>
      )}
    </div>
  );
}
