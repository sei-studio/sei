/**
 * CallSceneHost — drives a CallScene from the live call's state.
 *
 * The choreography, and why it is in this order:
 *
 *   1. The BACKDROP is up the instant the call view mounts. Pressing call
 *      should land you somewhere immediately; waiting for a connection to see
 *      the grass would make the scene feel like a loading screen.
 *   2. The CHARACTER waits off-stage while the call connects, and walks on when
 *      it goes live. She arrives because the call is ready, so the walk reads
 *      as her answering rather than as an animation on a timer.
 *   3. Her first line waits until she has ARRIVED. The greeting is generated
 *      during the ring like always; `setIntroHold` just keeps it buffered, so
 *      nothing is regenerated or lost. Without it she greets you from
 *      off-screen mid-stride.
 *
 * Mounting mid-call (the player toggling into scene view during a conversation)
 * skips all of it: she is already there, so she is drawn standing, and no hold
 * is taken.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { CallScene as CallSceneData } from '@shared/callScene';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { CallScene, type CallScenePhase } from './CallScene';

/** Footsteps sit well under the companion's voice; deafen silences them. */
const FOOTSTEP_VOLUME = 0.22;

export interface CallSceneHostProps {
  scene: CallSceneData;
  /** The character on stage — her `speakingId` drives the mouth. */
  characterId: string;
}

export function CallSceneHost({ scene, characterId }: CallSceneHostProps): React.ReactElement {
  const status = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const setIntroHold = useVoiceStore((s) => s.setIntroHold);
  const deafened = useUiStore((s) => s.callDeafened);

  /**
   * Already on stage? Only a call that is ALREADY LIVE at mount gets to skip
   * the walk. `'idle'` is not that call: pressing call mounts this screen and
   * dials from an effect, and child effects run before the parent's, so the
   * store still says idle for one tick. Testing for "not connecting" here made
   * every dial skip the entrance (260730) — she was simply drawn standing.
   */
  const [arrived, setArrived] = useState(() => useVoiceStore.getState().status === 'live');
  /** Whether THIS mount owns the hold, so releasing it twice is impossible. */
  const heldRef = useRef(false);

  const release = (): void => {
    if (!heldRef.current) return;
    heldRef.current = false;
    setIntroHold(false);
  };

  // Take the hold once, on mount: anything short of a live call has an intro
  // still to play, and its first line must wait for her to arrive.
  useEffect(() => {
    if (useVoiceStore.getState().status === 'live') return undefined;
    heldRef.current = true;
    setIntroHold(true);
    // Unmounting mid-walk (hang up, or a toggle out of scene view) must not
    // leave the call permanently mute.
    return release;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A dial that fails never goes live, so the walk never starts and the hold
  // would sit until its cap. Drop it as soon as we know — but only on a real
  // TRANSITION, since mounting at 'idle' is the normal start of a dial and must
  // not release the hold we just took.
  const prevStatus = useRef(status);
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (was !== status && (status === 'error' || status === 'idle')) release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const phase: CallScenePhase = arrived
    ? // `speakingId` is set from the first audible sample, so the mouth opens
      // with the voice. It used to be set when the clip reached the audio
      // queue's playhead, a whole TTS round trip earlier (260730).
      speakingId === characterId
      ? 'talking'
      : 'idle'
    : status === 'live'
      ? 'entering'
      : 'offstage';

  return (
    <CallScene
      scene={scene}
      phase={phase}
      sfxVolume={deafened ? 0 : FOOTSTEP_VOLUME}
      onEntered={() => {
        setArrived(true);
        release();
      }}
    />
  );
}
