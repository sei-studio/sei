/**
 * SummonedWidget — a floating "in your world" popup (chat change #7).
 *
 * Whenever one or more companions have a live in-game session (status
 * online/connecting), this renders a small stack of call-popup-style cards in
 * the bottom-right — portrait + name + status + a Disconnect button — so the
 * user can end a session from anywhere in the app. Rendered once at the App
 * shell level so it persists across navigation. Renders nothing when no bot is
 * live.
 *
 * Like the minimized voice call, the stack is DRAGGABLE and pinned above the
 * chat composer dock so it never sits on the message box; when a voice call is
 * also minimized, the default dock is offset up so the two popups don't overlap.
 * A plain click on a card (no drag) opens that companion's profile page.
 */

import React, { useRef, useState } from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { sei } from '../lib/ipcClient';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { UserIcon } from './icons';
import styles from './SummonedWidget.module.css';

/**
 * Keep the stack's bottom edge just above the chat composer box (#5) — sits at
 * the same height as the most-recent message when highlighted. Kept in sync with
 * the ChatScreen `.list` bottom padding / composer dock. Lowering this also
 * relaxes the drag clamp so the card can be dragged further down.
 */
const BOTTOM_RESERVED = 72;
const EDGE_GAP = 8;
/** Extra lift for the default dock when the minimized call already sits there. */
const CALL_CLEARANCE = 56;

interface Pos {
  left: number;
  top: number;
}

export function SummonedWidget(): React.ReactElement | null {
  const summons = useDataStore((s) => s.summons);
  const characters = useDataStore((s) => s.characters);
  const navigate = useUiStore((s) => s.navigate);
  const callActive = useUiStore((s) => !!s.minimizedCall);
  // When a character's profile page is open, its own deploy bar is the connect/
  // disconnect control — so hide that character's floating card (it's redundant).
  const view = useUiStore((s) => s.view);
  const hiddenId = view.kind === 'character' ? view.id : null;

  // Free-drag position; null = docked bottom-right via inline/CSS default.
  const [pos, setPos] = useState<Pos | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<
    { startX: number; startY: number; origX: number; origY: number; moved: boolean; cid: string | null } | null
  >(null);

  const active = Object.values(summons).filter(
    (st) =>
      (st.kind === 'online' || st.kind === 'connecting') && st.characterId !== hiddenId,
  );
  if (active.length === 0) return null;

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const cardIdAt = (target: EventTarget | null): string | null =>
    (target as HTMLElement | null)?.closest('[data-cid]')?.getAttribute('data-cid') ?? null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Let the Disconnect buttons handle their own clicks.
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
      cid: cardIdAt(e.target),
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
    // Bottom edge clamped above the reserved composer band (#2).
    const maxTop = window.innerHeight - h - BOTTOM_RESERVED;
    const top = Math.max(EDGE_GAP, Math.min(maxTop, d.origY + dy));
    setPos({ left, top });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    ref.current?.releasePointerCapture(e.pointerId);
    // A click without a drag opens that companion's profile page (#5).
    if (d && !d.moved && d.cid) navigate({ kind: 'character', id: d.cid });
  };

  const defaultStyle: React.CSSProperties | undefined = callActive
    ? { bottom: BOTTOM_RESERVED + CALL_CLEARANCE }
    : undefined;

  return (
    <div
      ref={ref}
      className={styles.stack}
      style={pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : defaultStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {active.map((st) => {
        const c = characters.find((ch) => ch.id === st.characterId);
        const name = c?.name ?? 'Companion';
        const connecting = st.kind === 'connecting';
        return (
          <div
            key={st.characterId}
            className={styles.widget}
            data-cid={st.characterId}
            role="button"
            tabIndex={0}
            aria-label={`Open ${name}'s profile`}
            title="Click to open profile · drag to move"
          >
            <div className={styles.avatar}>
              {c ? (
                <PixelPortrait
                  seed={c.id + c.name}
                  palette={pickPalette(c.id + c.name, theme)}
                  size={30}
                  portraitImage={c.portrait_image}
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                <UserIcon size={16} />
              )}
            </div>
            <div className={styles.meta}>
              <span className={styles.name}>{name}</span>
              <span className={styles.status}>
                <span
                  className={`${styles.dot} ${connecting ? styles.dotConnecting : ''}`}
                  aria-hidden="true"
                />
                {connecting ? 'Connecting…' : 'Connected'}
              </span>
            </div>
            <Button
              kind="danger"
              size="sm"
              onClick={() => {
                // Instant (#3): drop the entry from the store immediately so the
                // widget clears on click — a failed/hanging join shouldn't leave
                // the button waiting on the stop round-trip. `stop` still runs to
                // tear down any real session; a later idle push is idempotent.
                useDataStore.getState().setStatus({ kind: 'idle', characterId: st.characterId });
                void sei.stop(st.characterId);
              }}
            >
              Disconnect
            </Button>
          </div>
        );
      })}
    </div>
  );
}
