/**
 * CallControls — the mute / deafen / hang-up buttons, extracted from
 * VoiceCallScreen (260721) so the fullscreen call and GameSurface's in-game
 * call cluster share the EXACT same controls, just at two sizes.
 *
 * 260721 redesign: Discord-ish rounded-rectangle pills in a tight row — filled
 * shapes with large hit areas (mic toggle, deafen toggle, red hang-up pill)
 * instead of the old thin outline circles.
 *
 * 260730: an optional fourth pill, the backdrop toggle (mountain), sits between
 * deafen and hang-up. It is opt-in via props because only the fullscreen call
 * view has a backdrop to switch to — GameSurface's cluster passes neither prop
 * and renders the original three.
 *
 * Mute + deafen live in useUiStore (shared across call surfaces); hang-up is
 * useVoiceStore.endCall (the real teardown). `onHangUp` runs after the call
 * ends so each surface can route (the fullscreen view navigates back to chat;
 * the in-game cluster simply disappears when the call state clears).
 *
 * 260803: the screen-share button. This is the ONLY entry point to backseat now
 * that the "Backseat" tile is gone from the games picker, and it is here rather
 * than in the games grid because sharing a screen is not a game, it is a thing
 * you do on a call. Pressing it opens the source picker; pressing it while
 * sharing stops. Hanging up stops it too: the share cannot outlive the call it
 * belongs to.
 *
 * The one-time discovery tip is NOT here (260803). It was, briefly, pointing at
 * this button. But you cannot reach these controls without already being on a
 * call, and a notice about a feature is worth nothing to someone who has
 * already got as far as the call controls. It moved to the chat header, next to
 * the Backseat button, which is where a player actually starts.
 */

import React from 'react';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import {
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MountainIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
} from '../icons';
import { useT } from '../../lib/i18n';
import styles from './CallControls.module.css';

export interface CallControlsProps {
  /** 'lg' = the fullscreen call view; 'sm' = the docked call section. */
  size?: 'lg' | 'sm';
  /** Runs after endCall() so the host surface can route away. */
  onHangUp?: () => void;
  /**
   * Backdrop toggle (260730). Omit both and the button is not rendered — only
   * the fullscreen call view has a backdrop to switch to, so the in-game
   * cluster keeps the three controls it always had.
   */
  backdrop?: boolean;
  onToggleBackdrop?: () => void;
  /**
   * Painted over character art rather than an app surface, so the pills drop
   * the theme-tinted fill for a fixed dark scrim (see the CSS).
   */
  onArt?: boolean;
}

export function CallControls({
  size = 'lg',
  onHangUp,
  backdrop,
  onToggleBackdrop,
  onArt,
}: CallControlsProps): React.ReactElement {
  const t = useT();
  const muted = useUiStore((s) => s.callMuted);
  const setMuted = useUiStore((s) => s.setCallMuted);
  const deafened = useUiStore((s) => s.callDeafened);
  const setDeafened = useUiStore((s) => s.setCallDeafened);
  const endCall = useVoiceStore((s) => s.endCall);

  // Screen share. The target is the call's first participant, the same one the
  // participant tiles route to, so this needs no prop that the two mount sites
  // would have to agree on.
  const openModal = useUiStore((s) => s.openModal);
  const participants = useVoiceStore((s) => s.participants);
  const sharingFor = useBackseatStore((s) => s.sharingFor);
  const startingShare = useBackseatStore((s) => s.starting);
  const stopSharing = useBackseatStore((s) => s.stopSharing);
  const sharing = sharingFor !== null;
  const shareTarget = participants[0];

  const small = size === 'sm';
  const btn = small ? `${styles.pillBtn} ${styles.pillBtnSm}` : styles.pillBtn;
  const iconPx = small ? 16 : 22;

  const row = [styles.controls, small ? styles.controlsSm : '', onArt ? styles.controlsOnArt : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={row}>
      <button
        type="button"
        className={muted ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => setMuted(!muted)}
        aria-pressed={muted}
        aria-label={muted ? t('Unmute') : t('Mute')}
        title={muted ? t('Unmute') : t('Mute')}
      >
        {muted ? <MicOffIcon size={iconPx} /> : <MicIcon size={iconPx} />}
      </button>

      <button
        type="button"
        className={deafened ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => setDeafened(!deafened)}
        aria-pressed={deafened}
        aria-label={deafened ? t('Undeafen') : t('Deafen')}
        title={deafened ? t('Undeafen') : t('Deafen')}
      >
        {deafened ? <HeadphonesOffIcon size={iconPx} /> : <HeadphonesIcon size={iconPx} />}
      </button>

      {onToggleBackdrop ? (
        <button
          type="button"
          className={backdrop ? `${btn} ${styles.pillBtnToggled}` : btn}
          onClick={onToggleBackdrop}
          aria-pressed={backdrop}
          aria-label={backdrop ? t('Show the call view') : t('Show the scene')}
          title={backdrop ? t('Show the call view') : t('Show the scene')}
        >
          <MountainIcon size={iconPx} />
        </button>
      ) : null}

      <button
        type="button"
        className={sharing ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => {
          if (sharing) {
            void stopSharing();
            return;
          }
          if (shareTarget) openModal({ kind: 'share-screen', characterId: shareTarget });
        }}
        disabled={!sharing && (!shareTarget || startingShare)}
        aria-pressed={sharing}
        aria-label={sharing ? t('Stop sharing your screen') : t('Share your screen')}
        title={sharing ? t('Stop sharing') : t('Share your screen')}
      >
        {sharing ? <ScreenShareOffIcon size={iconPx} /> : <ScreenShareIcon size={iconPx} />}
      </button>

      <button
        type="button"
        className={`${btn} ${styles.pillBtnHangup}`}
        onClick={() => {
          // A share belongs to the call, so it goes with it. Ending the session
          // here rather than reacting to the call status keeps the teardown in
          // one place and ordered: capture stops before the call does.
          if (sharing) void stopSharing();
          endCall();
          onHangUp?.();
        }}
        aria-label={t('Hang up')}
        title={t('Hang up')}
      >
        <PhoneOffIcon size={small ? 17 : 24} />
      </button>
    </div>
  );
}
