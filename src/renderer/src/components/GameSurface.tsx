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
 *           - the IN-APP fullscreen button (260728): hides the IconRail AND
 *             the chat, so the game gets every pixel the app window has. It
 *             used to toggle the OS window's fullscreen, which was the wrong
 *             verb: a game wants the whole app, not the whole display, and
 *             taking over the display is awkward to undo. State lives in
 *             useUiStore.gameFullscreen; icon swaps between enter/exit.
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
 * root class); the fullscreen flag lives in useUiStore because the IconRail it
 * hides is App.tsx's, not this component's.
 */

import React, { useEffect, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { startOrOpenCall } from '../lib/callLaunch';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { BackIcon, FullscreenIcon, ExitFullscreenIcon, PhoneIcon, UserIcon } from './icons';
import { CallControls } from './call/CallControls';
import { ModalShell, ModalFooter } from './ModalShell';
import { Button } from './Button';
import confirmStyles from './confirmModal.module.css';
import styles from './GameSurface.module.css';

/** Pointer proximity band above the surface bottom that reveals the chrome. */
export const CHROME_PROXIMITY_PX = 72;

export interface GameChromeRowProps {
  /** Who the game is with: the phone button dials them. */
  characterId: string;
  /** The host decides when the row shows (pointer proximity, focus, ...). */
  revealed: boolean;
  /** The mounted surface's end action (end game / stop session / dismiss). */
  onEnd: () => void;
  /** True while a session is live: the end "x" asks for confirmation first. */
  confirmEnd: boolean;
  /**
   * The expand-over-chat control, for surfaces that sit above a chat column.
   * Omitted on full-page games (Draw!), where there is no chat to cover.
   */
  expand?: { expanded: boolean; unread: boolean; onToggle: () => void };
}

/**
 * The universal bottom button row every game surface carries (260729): expand
 * (where a chat column exists), in-app fullscreen, the call cluster, and the
 * unified end "x". Extracted from GameSurface so the full-page Draw! route can
 * mount the SAME row instead of inventing its own corner buttons.
 *
 * The phone chip is new with the extraction: it starts a call IN PLACE when
 * none is running (startOrOpenCall). It has to live down here rather than only
 * in ChatTopBar, because fullscreen now hides the top bar and Draw! never had
 * one.
 */
export function GameChromeRow({
  characterId,
  revealed,
  onEnd,
  confirmEnd,
  expand,
}: GameChromeRowProps): React.ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false);

  // In-game call cluster: the live call session, if any.
  const navigate = useUiStore((s) => s.navigate);
  const participants = useVoiceStore((s) => s.participants);
  const callStatus = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const characters = useDataStore((s) => s.characters);
  const callActive =
    participants.length > 0 && (callStatus === 'live' || callStatus === 'connecting');

  // In-app fullscreen. The flag's on-unmount cleanup stays with the HOST
  // surface (GameSurface / DrawScreen), which owns the flag's lifetime.
  const fullscreen = useUiStore((s) => s.gameFullscreen);
  const setFullscreen = useUiStore((s) => s.setGameFullscreen);

  const toggleLabel = expand?.expanded
    ? expand.unread
      ? 'Show chat, new messages'
      : 'Show chat'
    : 'Hide chat';

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  return (
    <>
      {/* Bottom chrome row: left cluster + centered call cluster + end "x".
          pointer-events pass through the empty parts so the game stays
          clickable under the transparent strip. */}
      <div className={revealed ? `${styles.chrome} ${styles.chromeRevealed}` : styles.chrome}>
        <div className={styles.chromeSide}>
          {expand ? (
            <button
              type="button"
              className={styles.chromeBtn}
              onClick={expand.onToggle}
              aria-label={toggleLabel}
              title={expand.expanded ? 'Show chat' : 'Hide chat'}
            >
              <span
                className={expand.expanded ? `${styles.chev} ${styles.chevExpanded}` : styles.chev}
                aria-hidden="true"
              >
                <BackIcon size={14} />
              </span>
              {expand.unread ? <span className={styles.unreadDot} aria-hidden="true" /> : null}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.chromeBtn}
            onClick={() => setFullscreen(!fullscreen)}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <ExitFullscreenIcon size={14} /> : <FullscreenIcon size={14} />}
          </button>
        </div>

        {/* Centered call cluster: participant pics + compact pill controls
            while a call runs; the phone that STARTS one otherwise. */}
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
        ) : (
          <div className={styles.callCluster}>
            <button
              type="button"
              className={styles.chromeBtn}
              onClick={() => startOrOpenCall(characterId)}
              aria-label="Voice call"
              title="Voice call"
            >
              <PhoneIcon size={14} />
            </button>
          </div>
        )}

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
    </>
  );
}

export interface GameSurfaceProps {
  /** Who the game is with (threads through to the chrome's call buttons). */
  characterId: string;
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
  characterId,
  expanded,
  unread,
  onToggle,
  onEnd,
  confirmEnd,
  children,
}: GameSurfaceProps): React.ReactElement {
  // Hover-reveal state for the bottom chrome row.
  const [nearBottom, setNearBottom] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const callStatus = useVoiceStore((s) => s.status);

  // In-app fullscreen. The surface OWNS the flag: it clears it on unmount, so
  // ending a game or navigating away can never leave the IconRail hidden.
  const setFullscreen = useUiStore((s) => s.setGameFullscreen);
  useEffect(() => () => setFullscreen(false), [setFullscreen]);

  // Reveal: pointer near the bottom, keyboard focus inside the surface, an
  // unread dot waiting (a hidden dot is no signal), or a call dialing (the
  // just-started in-place call needs visible feedback).
  const revealed = nearBottom || focusWithin || unread || callStatus === 'connecting';

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

      <GameChromeRow
        characterId={characterId}
        revealed={revealed}
        onEnd={onEnd}
        confirmEnd={confirmEnd}
        expand={{ expanded, unread, onToggle }}
      />
    </div>
  );
}
