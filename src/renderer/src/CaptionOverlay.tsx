/**
 * CaptionOverlay (260806) — root component of the caption overlay window
 * (main/captionOverlay.ts), mounted when the renderer bundle loads with
 * `?captions=1` (see main.tsx).
 *
 * White companion captions over a darkened rounded box, fed by the same
 * `voice:overlay-state` pushes as the avatar overlay (lastSpoken /
 * lastSpokenId). The font size is FIXED: a line that does not fit the box is
 * broken into chunks (captionChunks.ts) and paged at reading speed — a bigger
 * font or a smaller box just pages more often.
 *
 * Interaction: NONE in view mode — the window is fully click-through (main
 * never lifts ignoreMouseEvents), so the cursor works on whatever is under
 * the captions. Edit mode (relayed from the avatar overlay's pencil over
 * avatar:caption-edit-state) makes the window interactive: corner handles
 * resize the box, dragging anywhere moves it, and the +/- buttons step the
 * font size. Geometry and font persist main-side (UserConfig.avatar_captions).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallOverlayState } from '@shared/ipc';
import { sei } from './lib/ipcClient';
import { captionCapacity, chunkCaption, visualUnits } from './lib/avatar/captionChunks';
import styles from './CaptionOverlay.module.css';

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const OPPOSITE: Record<Corner, Corner> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };

/** Window edge → box inset and box padding — MUST match the CSS. */
const BOX_INSET = 8;
const BOX_PAD_X = 14;
const BOX_PAD_Y = 10;

/** Reading-speed paging: latin units per second, with a floor per chunk. */
const UNITS_PER_SEC = 16;
const MIN_CHUNK_MS = 1600;
/** How long the last shown chunk lingers after the speaker goes quiet.
 * Short (260806): the caption must end WITH the speech — a long linger read
 * as the caption "continuing the response" after the voice had already moved
 * on (or been superseded by a newer turn). A new line becoming audible
 * replaces the text immediately either way. */
const LINGER_MS = 1500;

/** Window size bounds (mirror main/captionOverlay.ts). */
const MIN_W = 160;
const MAX_W = 1600;
const MIN_H = 60;
const MAX_H = 800;

export function CaptionOverlay(): React.ReactElement | null {
  const [state, setState] = useState<CallOverlayState | null>(null);
  const [editing, setEditing] = useState(false);
  const [fontSize, setFontSize] = useState(18);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const offState = sei.onVoiceOverlayState?.((s) => setState(s));
    const offEdit = sei.onAvatarCaptionEditState?.((on) => setEditing(on));
    // Pull the seeds — the reveal push can land before these subscriptions
    // exist (same race as the avatar overlay's).
    void sei
      .voiceOverlayGetState?.()
      .then((s) => {
        if (s) setState((prev) => prev ?? s);
      })
      .catch(() => {});
    void sei
      .avatarCaptionGet?.()
      .then((info) => {
        setEditing(info.editing);
        setFontSize(info.fontSize);
      })
      .catch(() => {});
    const onResize = (): void => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => {
      offState?.();
      offEdit?.();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ── Chunking + paging ───────────────────────────────────────────────────
  const text = state?.lastSpoken ?? '';
  const speakerSpeaking =
    !!state?.lastSpokenId &&
    state.participants.some((p) => p.id === state.lastSpokenId && p.speaking);

  const capacity = useMemo(
    () =>
      captionCapacity(
        Math.max(40, win.w - 2 * (BOX_INSET + BOX_PAD_X)),
        Math.max(20, win.h - 2 * (BOX_INSET + BOX_PAD_Y)),
        fontSize,
      ).unitsPerChunk,
    [win.w, win.h, fontSize],
  );
  const chunks = useMemo(() => chunkCaption(text, capacity), [text, capacity]);

  const [chunkIdx, setChunkIdx] = useState(0);
  useEffect(() => {
    setChunkIdx(0);
  }, [text]);
  useEffect(() => {
    if (chunkIdx >= chunks.length - 1) return undefined;
    // Page only while the voice is actually audible (260806): once the clip
    // has ended (or was interrupted), the remaining chunks describe speech
    // that is over — advancing through them made the caption trail the audio
    // by whole sentences. The shown chunk freezes and the linger below ends it.
    if (!speakerSpeaking) return undefined;
    const ms = Math.max(MIN_CHUNK_MS, (visualUnits(chunks[chunkIdx] ?? '') / UNITS_PER_SEC) * 1000);
    const timer = setTimeout(
      () => setChunkIdx((i) => Math.min(i + 1, chunks.length - 1)),
      ms,
    );
    return () => clearTimeout(timer);
  }, [chunks, chunkIdx, speakerSpeaking]);

  // Visibility: show while there is a line; linger after the speaker stops.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (chunks.length === 0) {
      setVisible(false);
      return undefined;
    }
    setVisible(true);
    if (speakerSpeaking) return undefined;
    const timer = setTimeout(() => setVisible(false), LINGER_MS);
    return () => clearTimeout(timer);
  }, [chunks, chunkIdx, speakerSpeaking]);

  // ── Edit-mode geometry (streams mirror the avatar overlay's) ────────────
  const beginResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: Corner): void => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      const startX = e.screenX;
      const startY = e.screenY;
      const startW = window.innerWidth;
      const startH = window.innerHeight;
      const anchor = OPPOSITE[corner];
      let latest = { width: startW, height: startH };
      let raf = 0;
      const onMove = (ev: PointerEvent): void => {
        const sx = (corner === 'tr' || corner === 'br' ? 1 : -1) * (ev.screenX - startX);
        const sy = (corner === 'bl' || corner === 'br' ? 1 : -1) * (ev.screenY - startY);
        latest = {
          width: Math.min(MAX_W, Math.max(MIN_W, startW + sx)),
          height: Math.min(MAX_H, Math.max(MIN_H, startH + sy)),
        };
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            void sei.avatarCaptionResize?.({ ...latest, anchor }).catch(() => {});
          });
        }
      };
      const onUp = (): void => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        if (raf) cancelAnimationFrame(raf);
        void sei.avatarCaptionResize?.({ ...latest, anchor, commit: true }).catch(() => {});
      };
      el.setPointerCapture(e.pointerId);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [],
  );

  const beginMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.screenX;
    const startY = e.screenY;
    void sei.avatarCaptionMove?.({ phase: 'start' }).catch(() => {});
    let raf = 0;
    let dx = 0;
    let dy = 0;
    const onMove = (ev: PointerEvent): void => {
      dx = ev.screenX - startX;
      dy = ev.screenY - startY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          void sei.avatarCaptionMove?.({ phase: 'move', dx, dy }).catch(() => {});
        });
      }
    };
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (raf) cancelAnimationFrame(raf);
      void sei.avatarCaptionMove?.({ phase: 'end' }).catch(() => {});
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }, []);

  const bumpFont = useCallback((delta: 1 | -1): void => {
    void sei
      .avatarCaptionFont?.(delta)
      .then((size) => setFontSize(size))
      .catch(() => {});
  }, []);

  // Nothing to paint outside edit mode when no caption is live.
  if (!editing && (!visible || chunks.length === 0)) return null;

  const line = chunks[Math.min(chunkIdx, Math.max(0, chunks.length - 1))] ?? '';

  return (
    <div className={styles.stage}>
      <div
        className={`${styles.box} ${editing ? styles.boxEditing : ''}`}
        style={{ ['--cap-font' as string]: `${fontSize}px` }}
        onPointerDown={editing ? beginMove : undefined}
        aria-live="polite"
      >
        <p className={styles.text}>
          {line || (editing ? 'Captions appear here' : '')}
        </p>

        {editing && (
          <>
            <div className={`${styles.handle} ${styles.tl}`} onPointerDown={(e) => beginResize(e, 'tl')} />
            <div className={`${styles.handle} ${styles.tr}`} onPointerDown={(e) => beginResize(e, 'tr')} />
            <div className={`${styles.handle} ${styles.bl}`} onPointerDown={(e) => beginResize(e, 'bl')} />
            <div className={`${styles.handle} ${styles.br}`} onPointerDown={(e) => beginResize(e, 'br')} />
            <div className={styles.fontBtns} onPointerDown={(e) => e.stopPropagation()}>
              <button type="button" className={styles.fontBtn} title="Smaller text" onClick={() => bumpFont(-1)}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 5 h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <button type="button" className={styles.fontBtn} title="Larger text" onClick={() => bumpFont(1)}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M5 2 v6 M2 5 h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
