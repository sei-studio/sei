/**
 * CallOverlayPusher (260706, task 4) — bridges the live voice-call state to the
 * always-on-top overlay window. Renders nothing; it just watches the call's
 * participants + who is speaking + the settings toggle and pushes the overlay's
 * desired state to main (voice:overlay-set), which spawns/positions/tears down
 * the overlay window and forwards the state to it.
 *
 * Lives in the MAIN window (mounted in the App shell), where the character
 * roster is available to resolve each participant's name + portrait. Reading the
 * roster via getState() inside the effect keeps it OFF the dependency list, so a
 * routine character-status update does not re-push the overlay state.
 *
 * 260707: the player is on the overlay too, as the LAST circle (matching the
 * call screen's tile order) with the exact same treatment as the AIs — their
 * profile picture (procedural fallback otherwise) and a speaking ring lit while
 * they talk into an unmuted mic. Speaking is per-participant so the player's
 * ring is independent of a companion's TTS, like the call-screen tiles.
 */
import { useEffect, useState } from 'react';
import type { UserProfile } from '@shared/ipc';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { sei } from '../lib/ipcClient';

export function CallOverlayPusher(): null {
  const participants = useVoiceStore((s) => s.participants);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const userSpeaking = useVoiceStore((s) => s.userSpeaking);
  const muted = useUiStore((s) => s.callMuted);
  const enabled = useUiStore((s) => s.callOverlayEnabled);

  // The player's own name + pfp (same source as the call screen's user tile).
  // Fetched once; a stale-on-first-call profile edit is fine for an overlay.
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    let cancelled = false;
    void sei
      .userGetProfile()
      .then((p) => !cancelled && setProfile(p))
      .catch(() => {
        /* procedural-portrait fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const chars = useDataStore.getState().characters;
    void sei
      .voiceOverlaySet?.({
        enabled,
        participants:
          participants.length === 0
            ? []
            : [
                ...participants.map((id) => {
                  const c = chars.find((x) => x.id === id);
                  return {
                    id,
                    name: c?.name ?? 'Companion',
                    portrait: c?.portrait_image ?? null,
                    speaking: speakingId === id,
                  };
                }),
                {
                  id: 'player',
                  name: profile?.preferredName?.trim() || 'You',
                  portrait: profile?.profilePicture ?? null,
                  speaking: userSpeaking && !muted,
                },
              ],
      })
      .catch(() => {
        /* overlay is best-effort; a failed push never affects the call */
      });
  }, [participants, speakingId, userSpeaking, muted, enabled, profile]);

  return null;
}
