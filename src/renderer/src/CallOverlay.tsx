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
 * 260804 interaction: the window is click-through by default with pointer
 * events still FORWARDED (main sets ignoreMouseEvents {forward: true}), so
 * hover works. While the pointer is over the overlay we ask main for real
 * clicks (avatarOverlayInteractive) — that is what makes the drag button
 * (`-webkit-app-region: drag`) and the corner resize handles usable — and
 * hand them back on leave. Tile size is pure CSS off the window height
 * (main sizes the window; height = tile + 2*16px chrome padding), so every
 * resize path stays consistent by construction.
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

  // Hover chrome + interactivity handoff. Entering asks main for real clicks
  // (drag/resize need them); leaving restores click-through. Failure is
  // harmless: without the flip the chrome shows but cannot be grabbed.
  const onEnter = useCallback((): void => {
    setHovered(true);
    void sei.avatarOverlayInteractive?.(true).catch(() => {});
  }, []);
  const onLeave = useCallback((): void => {
    setHovered(false);
    void sei.avatarOverlayInteractive?.(false).catch(() => {});
  }, []);

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

  if (!state || !state.enabled || state.participants.length === 0) return null;

  return (
    <div
      className={styles.stage}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ ['--tile' as string]: `${tilePx}px` }}
    >
      {/* Thin glowing outline while hovered. */}
      <div className={`${styles.outline} ${hovered ? styles.outlineOn : ''}`} />

      <div className={styles.row}>
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

      {/* Hover chrome: corner resize handles + the hold-to-drag button. */}
      {hovered && (
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
    </div>
  );
}
