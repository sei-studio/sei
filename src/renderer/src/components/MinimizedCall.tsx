/**
 * MinimizedCall — the floating "call in progress" widget (chat change #6).
 *
 * When the voice call is minimized (useUiStore.minimizeCall), the call keeps
 * "running" as a thin, draggable rectangle pinned to the bottom-right corner:
 * companion portrait + name + a mute toggle + a hang-up button. It is rendered
 * once at the App shell level so it survives navigation between screens.
 *
 * Dragging moves the window (pointer-captured, clamped to the viewport). A plain
 * click on the body (no drag) restores the full-screen voice-call view. Mute is
 * shared with VoiceCallScreen via the store; hang-up ends the call.
 *
 * Renders nothing when no call is minimized.
 */

import React, { useMemo, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { MicIcon, MicOffIcon, PhoneOffIcon, UserIcon } from './icons';
import styles from './MinimizedCall.module.css';

interface Pos {
  left: number;
  top: number;
}

/**
 * #5 — the widget must never sit on top of the chat message box, even when
 * dragged. Reserve a band at the bottom of the viewport (roughly the composer
 * dock height) that the widget's bottom edge can't cross. Kept in sync with the
 * ChatScreen `.list` bottom padding / composer dock.
 */
const BOTTOM_RESERVED = 116;
const EDGE_GAP = 8;

export function MinimizedCall(): React.ReactElement | null {
  const minimizedCall = useUiStore((s) => s.minimizedCall);
  const muted = useUiStore((s) => s.callMuted);
  const setMuted = useUiStore((s) => s.setCallMuted);
  // Real teardown (mic + TTS queue + main call-state) lives in useVoiceStore;
  // it also clears the UI store's minimized/mute state.
  const endCall = useVoiceStore((s) => s.endCall);
  const restoreCall = useUiStore((s) => s.restoreCall);

  const character = useDataStore((s) =>
    minimizedCall ? s.characters.find((c) => c.id === minimizedCall.characterId) : undefined,
  );

  // Free-drag position; null = docked bottom-right via CSS (initial state).
  const [pos, setPos] = useState<Pos | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(
    null,
  );

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  if (!minimizedCall) return null;

  const companionName = character?.name ?? 'Companion';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Let the mute / hang-up buttons handle their own clicks.
    if ((e.target as HTMLElement).closest('button')) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(EDGE_GAP, Math.min(window.innerWidth - w - EDGE_GAP, d.origX + dx));
    // Bottom edge clamped above the reserved message-box band (#5).
    const maxTop = window.innerHeight - h - BOTTOM_RESERVED;
    const top = Math.max(EDGE_GAP, Math.min(maxTop, d.origY + dy));
    setPos({ left, top });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    ref.current?.releasePointerCapture(e.pointerId);
    // A click without a drag restores the full call.
    if (d && !d.moved) restoreCall();
  };

  return (
    <div
      ref={ref}
      className={styles.widget}
      style={pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="button"
      tabIndex={0}
      aria-label={`Return to call with ${companionName}`}
      title="Click to return to call · drag to move"
    >
      <div className={styles.avatar}>
        {character ? (
          <PixelPortrait
            seed={character.id + character.name}
            palette={palette}
            size={30}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <UserIcon size={16} />
        )}
      </div>

      <div className={styles.meta}>
        <span className={styles.name}>{companionName}</span>
        <span className={styles.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          On call
        </span>
      </div>

      <button
        type="button"
        className={`${styles.ctlBtn} ${muted ? styles.ctlBtnMuted : ''}`}
        onClick={() => setMuted(!muted)}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
      </button>
      <button
        type="button"
        className={`${styles.ctlBtn} ${styles.ctlBtnHangup}`}
        onClick={endCall}
        aria-label="Hang up"
        title="Hang up"
      >
        <PhoneOffIcon size={16} />
      </button>
    </div>
  );
}
