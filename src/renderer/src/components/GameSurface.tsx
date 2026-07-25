/**
 * GameSurface — shared chrome for game panels mounted in the ChatScreen game
 * area (chess, screen share, the Minecraft launch panel + dashboard).
 *
 * The game area sits on TOP of the chat (260721 top/bottom split); this
 * chrome overlays ONE bottom row (260722) on whichever panel is mounted:
 *
 *   left    - the expand "V" button: expands the game DOWN over the chat
 *             (chat hidden; chevron flips to "^" to restore). While chat is
 *             hidden, ChatScreen sets `unread` when a companion message lands
 *             and this button carries the red dot.
 *           - the app-window fullscreen button (window:fullscreen-toggle IPC);
 *             icon swaps between enter/exit states.
 *
 *   center  - the in-game call cluster (260722, replacing the CallDock strip):
 *             participant profile pics (click one to return to the fullscreen
 *             call) + the shared compact CallControls pills. Rendered only
 *             while a call session exists.
 *
 *   right   - the unified end "x". Every game ends here: with a live session
 *             (`confirmEnd`) it asks "This will end the game." first; without
 *             one it dismisses the surface directly. `onEnd` is each surface's
 *             existing end action, passed in by ChatScreen.
 *
 * The WHOLE row is hover-revealed: hidden at rest (display: none +
 * allow-discrete, so hidden chrome can never affect layout or overflow),
 * revealed while the pointer is within ~72px of the surface bottom, while
 * keyboard focus is inside the surface (tabbing into the game reveals the row
 * so its controls become reachable; focus on the controls keeps it open),
 * while the unread dot is lit, or while a call is connecting.
 *
 * Reserved-height contract: the surface sets `--game-chrome-h` (56px) so game
 * panels can pad their content clear of the overlay strip
 * (e.g. chess consumes var(--game-chrome-h, 56px)).
 *
 * The expand STATE lives in ChatScreen (it drives the game/chat heights via a
 * root class); fullscreen state is the OS window's and is re-read on resize so
 * an Esc exit keeps the icon honest.
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { BackIcon, FullscreenIcon, ExitFullscreenIcon, UserIcon } from './icons';
import { CallControls } from './call/CallControls';
import { ModalShell, ModalFooter } from './ModalShell';
import { Button } from './Button';
import confirmStyles from './confirmModal.module.css';
import styles from './GameSurface.module.css';

/** Pointer proximity band above the surface bottom that reveals the chrome. */
const CHROME_PROXIMITY_PX = 72;

export interface GameSurfaceProps {
  /** True while the game covers the chat column. */
  expanded: boolean;
  /** True while chat is hidden and an unseen companion message is waiting. */
  unread: boolean;
  /** Toggle the expand-over-chat state. */
  onToggle: () => void;
  /** The mounted surface's end action (end game / stop session / dismiss). */
  onEnd: () => void;
  /** True while a session is live: the end "x" asks for confirmation first. */
  confirmEnd: boolean;
  /** The mounted game panel. */
  children: React.ReactNode;
}

export function GameSurface({
  expanded,
  unread,
  onToggle,
  onEnd,
  confirmEnd,
  children,
}: GameSurfaceProps): React.ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Hover-reveal state for the bottom chrome row.
  const [nearBottom, setNearBottom] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);

  // In-game call cluster: the live call session, if any.
  const navigate = useUiStore((s) => s.navigate);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const characters = useDataStore((s) => s.characters);
  const callActive =
    participants.length > 0 && (callStatus === 'live' || callStatus === 'connecting');

  // Seed + track the OS fullscreen state. A resize fires on enter/leave
  // (including Esc / the native control), so re-reading there keeps the icon
  // in sync without a dedicated push channel.
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void sei
        .windowIsFullscreen()
        .then((v) => alive && setFullscreen(v))
        .catch(() => {
          /* older preload without the bridge — button stays in enter state */
        });
    };
    read();
    window.addEventListener('resize', read);
    return () => {
      alive = false;
      window.removeEventListener('resize', read);
    };
  }, []);

  const toggleLabel = expanded ? (unread ? 'Show chat, new messages' : 'Show chat') : 'Hide chat';

  // Reveal: pointer near the bottom, keyboard focus inside the surface, an
  // unread dot waiting (a hidden dot is no signal), or a call dialing (the
  // just-started in-place call needs visible feedback).
  const revealed = nearBottom || focusWithin || unread || callStatus === 'connecting';

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  return (
    <div
      className={styles.surface}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setNearBottom(r.bottom - e.clientY <= CHROME_PROXIMITY_PX);
      }}
      onPointerLeave={() => setNearBottom(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <div className={styles.content}>{children}</div>

      {/* Bottom chrome row: left cluster + centered call cluster + end "x".
          pointer-events pass through the empty parts so the game stays
          clickable under the transparent strip. */}
      <div className={revealed ? `${styles.chrome} ${styles.chromeRevealed}` : styles.chrome}>
        <div className={styles.chromeSide}>
          <button
            type="button"
            className={styles.chromeBtn}
            onClick={onToggle}
            aria-label={toggleLabel}
            title={expanded ? 'Show chat' : 'Hide chat'}
          >
            <span
              className={expanded ? `${styles.chev} ${styles.chevExpanded}` : styles.chev}
              aria-hidden="true"
            >
              <BackIcon size={14} />
            </span>
            {unread ? <span className={styles.unreadDot} aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            className={styles.chromeBtn}
            onClick={() =>
              void sei
                .windowFullscreenToggle()
                .then(setFullscreen)
                .catch(() => {
                  /* bridge missing — leave the window as is */
                })
            }
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />}
          </button>
        </div>

        {/* Centered call cluster: participant pics + compact pill controls. */}
        {callActive ? (
          <div className={styles.callCluster}>
            {participants.map((id) => {
              const c = characters.find((x) => x.id === id);
              const pal = pickPalette((c?.id ?? '') + (c?.name ?? ''), theme);
              const speaking = speakingId === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={speaking ? `${styles.tile} ${styles.tileSpeaking}` : styles.tile}
                  onClick={() => navigate({ kind: 'voice-call', characterId: participants[0] })}
                  aria-label={`Return to call with ${c?.name ?? 'Companion'}`}
                  title="Return to call"
                >
                  {c ? (
                    <PixelPortrait
                      seed={c.id + c.name}
                      palette={pal}
                      size={28}
                      portraitImage={c.portrait_image}
                      style={{ width: '100%', height: '100%' }}
                    />
                  ) : (
                    <UserIcon size={14} />
                  )}
                </button>
              );
            })}
            <CallControls size="sm" />
          </div>
        ) : null}

        {/* Right: the unified end control. */}
        <button
          type="button"
          className={`${styles.chromeBtn} ${styles.endBtn}`}
          onClick={() => (confirmEnd ? setConfirmOpen(true) : onEnd())}
          aria-label="End game"
          title="End game"
        >
          ×
        </button>
      </div>

      {confirmOpen ? (
        <ModalShell title="End game" onClose={() => setConfirmOpen(false)} scrimClose>
          <p className={confirmStyles.body}>This will end the game.</p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              kind="danger"
              size="md"
              onClick={() => {
                setConfirmOpen(false);
                onEnd();
              }}
            >
              End game
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </div>
  );
}
