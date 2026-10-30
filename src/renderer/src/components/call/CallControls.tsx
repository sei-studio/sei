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
 * 261030: the interrupt pill (raised hand), right after deafen, while the call is
 * live. Same cut as a confirmed voice barge-in (useVoiceStore.interrupt), for
 * when talking over her does not work: a loud game, a noisy room, a shy
 * player. (The Space-key shortcut for it was removed 261031, Shawn's call: the
 * pill and the overlay's interrupt button are the manual paths.)
 *
 * 261031: every pill carries the shared fast data-tip tooltip (global.css),
 * placed ABOVE (data-tip-up) because the row sits at the bottom of the call
 * view (below it over art, see tipUp). They used native `title` before, which takes ~1.5 s to appear and read
 * as "no tooltip". aria-label carries the same words.
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
import { useDataStore } from '../../lib/stores/useDataStore';
import {
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  HandIcon,
  MountainIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  ScreenShareOffIcon,
} from '../icons';
import { useT } from '../../lib/i18n';
import { visionBlocked, visionGateReason } from '../../lib/visionGate';
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
  // 261030: the manual interrupt. Live calls only: while ringing there is
  // nothing to cut, and a disabled pill would just be noise in the row.
  const interrupt = useVoiceStore((s) => s.interrupt);
  const callLive = useVoiceStore((s) => s.status === 'live');

  // Screen share. The target is the call's first participant, the same one the
  // participant tiles route to, so this needs no prop that the two mount sites
  // would have to agree on.
  const openModal = useUiStore((s) => s.openModal);
  const participants = useVoiceStore((s) => s.participants);
  const sharingFor = useBackseatStore((s) => s.sharingFor);
  const startingShare = useBackseatStore((s) => s.starting);
  const stopSharing = useBackseatStore((s) => s.stopSharing);
  // Waiting for a game's window to share (261004) counts as sharing here: the
  // toggle is lit and pressing it stops the wait.
  const watching = useBackseatStore((s) => s.watch !== null);
  const sharing = sharingFor !== null || watching;
  const shareTarget = participants[0];

  // china-compat W9: backseat is an image surface, so a text-only local model
  // disables the share pill with the reason as its tooltip. Only a confident
  // 'no' locks ('unknown' stays usable; main's LLM_NO_VISION gate is the
  // backstop). Stopping an already-running share is never blocked.
  const shareVisionBlocked = visionBlocked(useUiStore((s) => s.llmVision));
  const llmModel = useUiStore((s) => s.llmModel);
  // A live Minecraft summon also disables the pill (260907): backseat and a
  // summon are mutually exclusive (main refuses BACKSEAT_MC_SESSION_ACTIVE),
  // so say so up front. Every disabled state carries its reason as the tooltip.
  const shareMcKind = useDataStore((s) =>
    shareTarget ? s.summons[shareTarget]?.kind : undefined,
  );
  const shareMcActive = shareMcKind === 'online' || shareMcKind === 'connecting';
  const shareReason = sharing
    ? null
    : shareVisionBlocked
      ? visionGateReason(t, 'backseat', llmModel)
      : shareMcActive
        ? t('End the Minecraft session to share your screen')
        : !shareTarget
          ? t('Start a voice call to share your screen')
          : null;

  const small = size === 'sm';
  const btn = small ? `${styles.pillBtn} ${styles.pillBtnSm}` : styles.pillBtn;
  const iconPx = small ? 16 : 22;

  // Tooltips go ABOVE the row, which sits at the bottom of every surface it
  // is mounted on. Over art (the backdrop view) the name + timer pill sits
  // right above the row, so there they hang BELOW instead, into the
  // --space-xl bottom margin, where there is only the picture to cover.
  const tipUp = onArt ? undefined : true;

  const muteLabel = muted ? t('Unmute') : t('Mute');
  const deafenLabel = deafened ? t('Undeafen') : t('Deafen');
  const backdropLabel = backdrop ? t('Show the call view') : t('Show the scene');
  const shareLabel = sharing ? t('Stop sharing') : (shareReason ?? t('Share screen'));

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
        aria-label={muteLabel}
        data-tip={muteLabel}
        data-tip-up={tipUp}
      >
        {muted ? <MicOffIcon size={iconPx} /> : <MicIcon size={iconPx} />}
      </button>

      <button
        type="button"
        className={deafened ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => setDeafened(!deafened)}
        aria-pressed={deafened}
        aria-label={deafenLabel}
        data-tip={deafenLabel}
        data-tip-up={tipUp}
      >
        {deafened ? <HeadphonesOffIcon size={iconPx} /> : <HeadphonesIcon size={iconPx} />}
      </button>

      {callLive ? (
        <button
          type="button"
          className={btn}
          onClick={interrupt}
          aria-label={t('Interrupt')}
          data-tip={t('Interrupt')}
          data-tip-up={tipUp}
        >
          <HandIcon size={iconPx} />
        </button>
      ) : null}

      {onToggleBackdrop ? (
        <button
          type="button"
          className={backdrop ? `${btn} ${styles.pillBtnToggled}` : btn}
          onClick={onToggleBackdrop}
          aria-pressed={backdrop}
          aria-label={backdropLabel}
          data-tip={backdropLabel}
          data-tip-up={tipUp}
        >
          <MountainIcon size={iconPx} />
        </button>
      ) : null}

      <button
        type="button"
        className={sharing ? `${btn} ${styles.pillBtnToggled}` : btn}
        onClick={() => {
          if (sharing) {
            void stopSharing('user_stop');
            return;
          }
          if (shareVisionBlocked || shareMcActive) return;
          if (shareTarget) openModal({ kind: 'share-screen', characterId: shareTarget });
        }}
        disabled={
          !sharing && (!shareTarget || startingShare || shareVisionBlocked || shareMcActive)
        }
        aria-pressed={sharing}
        aria-label={shareLabel}
        data-tip={shareLabel}
        data-tip-up={tipUp}
        // A disabled reason can outrun the one-line data-tip at the 'sm' size,
        // so it also rides the native title (same as ChatTopBar's Backseat).
        title={shareReason ?? undefined}
      >
        {sharing ? <ScreenShareOffIcon size={iconPx} /> : <ScreenShareIcon size={iconPx} />}
      </button>

      <button
        type="button"
        className={`${btn} ${styles.pillBtnHangup}`}
        onClick={() => {
          // A share belongs to the call, so it goes with it. 261023: endCall
          // stops it first (capture before the call, as this button used to),
          // for every way a call ends, with the reason.
          endCall('user_hangup');
          onHangUp?.();
        }}
        aria-label={t('Leave call')}
        data-tip={t('Leave call')}
        data-tip-up={tipUp}
      >
        <PhoneOffIcon size={small ? 17 : 24} />
      </button>
    </div>
  );
}
