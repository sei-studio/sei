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
 */
import { useEffect } from 'react';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { sei } from '../lib/ipcClient';

export function CallOverlayPusher(): null {
  const participants = useVoiceStore((s) => s.participants);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const enabled = useUiStore((s) => s.callOverlayEnabled);

  useEffect(() => {
    const chars = useDataStore.getState().characters;
    void sei
      .voiceOverlaySet?.({
        enabled,
        participants: participants.map((id) => {
          const c = chars.find((x) => x.id === id);
          return { id, name: c?.name ?? 'Companion', portrait: c?.portrait_image ?? null };
        }),
        speakingId,
      })
      .catch(() => {
        /* overlay is best-effort; a failed push never affects the call */
      });
  }, [participants, speakingId, enabled]);

  return null;
}
