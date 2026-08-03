/**
 * CallControls — the mute / deafen / hang-up buttons, extracted from
 * VoiceCallScreen (260721) so the fullscreen call and GameSurface's in-game
 * call cluster share the EXACT same controls, just at two sizes.
 *
 * 260721 redesign: Discord-ish rounded-rectangle pills in a tight row — filled
 * shapes with large hit areas (mic toggle, deafen toggle, red hang-up pill)
 * instead of the old thin outline circles.
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
 * 260803: the one-time discovery tip anchored to that button. Backseat is in
 * beta and the button is the fourth glyph in a row of call controls, so it read
 * as more call plumbing. The tip is shown once ever and then never again. The
 * predicate, and the reasoning behind "never again", live in
 * lib/backseatTipPref.
 */

import React, { useState } from 'react';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import {
  backseatTipDone,
  dismissBackseatTip,
  shouldShowBackseatTip,
} from '../../lib/backseatTipPref';
import {
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
} from '../icons';
import styles from './CallControls.module.css';

export interface CallControlsProps {
  /** 'lg' = the fullscreen call view; 'sm' = the docked call section. */
  size?: 'lg' | 'sm';
  /** Runs after endCall() so the host surface can route away. */
  onHangUp?: () => void;
}

export function CallControls({ size = 'lg', onHangUp }: CallControlsProps): React.ReactElement {
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

  // One-time tip. `done` is read once at mount (localStorage), then flipped in
  // memory by "Got it" so the popover leaves without a re-read. Starting a
  // share no longer counts as done (see backseatTipPref): the predicate hides
  // the card while sharing, and if they stop, an undismissed tip is still owed.
  const [tipDone, setTipDone] = useState(backseatTipDone);
  const showTip = shouldShowBackseatTip({
    done: tipDone,
    sharing,
    hasTarget: !!shareTarget,
    size,
  });

  return (
    <div className={small ? `${styles.controls} ${styles.controlsSm}` : styles.controls}>
      <button
        type="button"
        className={muted ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => setMuted(!muted)}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? <MicOffIcon size={iconPx} /> : <MicIcon size={iconPx} />}
      </button>

      <button
        type="button"
        className={deafened ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => setDeafened(!deafened)}
        aria-pressed={deafened}
        aria-label={deafened ? 'Undeafen' : 'Deafen'}
        title={deafened ? 'Undeafen' : 'Deafen'}
      >
        {deafened ? <HeadphonesOffIcon size={iconPx} /> : <HeadphonesIcon size={iconPx} />}
      </button>

      {/* Wrapped so the tip can anchor to the button itself rather than to the
          row, which would drift as the row's width changes. */}
      <div className={styles.shareWrap}>
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
          aria-label={sharing ? 'Stop sharing your screen' : 'Share your screen'}
          title={sharing ? 'Stop sharing' : 'Share your screen'}
        >
          {sharing ? <ScreenShareOffIcon size={iconPx} /> : <ScreenShareIcon size={iconPx} />}
        </button>

        {/* No aria-live role on the card: it holds a focusable "Got it", and a
            live region wrapping interactive content reads badly. */}
        {showTip ? (
          <div className={styles.tip}>
            <div className={styles.tipHead}>
              <span className={styles.tipIcon} aria-hidden="true">
                <ScreenShareIcon size={18} />
              </span>
              <span className={styles.tipNew}>NEW</span>
            </div>
            <p className={styles.tipTitle}>Stream anything with Backseat (beta)</p>
            <p className={styles.tipBody}>Try streaming your game or doomscrolling together!</p>
            <button
              type="button"
              className={styles.tipBtn}
              onClick={() => {
                dismissBackseatTip();
                setTipDone(true);
              }}
            >
              Got it
            </button>
            <span className={styles.tipTail} aria-hidden="true" />
          </div>
        ) : null}
      </div>

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
        aria-label="Hang up"
        title="Hang up"
      >
        <PhoneOffIcon size={small ? 17 : 24} />
      </button>
    </div>
  );
}
