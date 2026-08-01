/**
 * callLaunch (260722) — routing for the top-bar phone button and the presence
 * panel's Call button.
 *
 * Starting a call normally opens the fullscreen VoiceCallScreen. But while a
 * GAME SURFACE is open for this character (chess, screen share, the Minecraft
 * launch panel or live dashboard), the call starts IN PLACE instead: the
 * chat/game screen stays put and GameSurface's bottom chrome row carries the
 * compact call cluster (participant pics + small CallControls). Ending the
 * last game surface still auto-returns to the fullscreen call (CallMiniBar).
 *
 * Consent caveat: dialing needs the ~40 MB voice module. Its install/consent
 * gate lives on VoiceCallScreen, so when the module is NOT ready we fall back
 * to the fullscreen view even under a game; once installed, in-place starts
 * work from then on.
 */

import { useUiStore } from './stores/useUiStore';
import { useVoiceStore } from './stores/useVoiceStore';
import { useDataStore } from './stores/useDataStore';
import { useChessStore, isChessOpen } from './stores/useChessStore';
import { useMcDashboardStore } from './stores/useMcDashboardStore';
import { useDrawStore, isDrawActive } from './stores/useDrawStore';
import { isVoiceModelReady } from './voice/modelPrefetch';

/**
 * True when this character has an open game surface: chess panel or game,
 * Minecraft bot online (dashboard) or the launch panel open, or a Draw! game
 * in play (its full-page route carries the same bottom chrome, 260729).
 */
export function isGameSurfaceOpen(characterId: string): boolean {
  if (isChessOpen(useChessStore.getState(), characterId)) return true;
  if (useDataStore.getState().summons[characterId]?.kind === 'online') return true;
  if (isDrawActive(useDrawStore.getState(), characterId)) return true;
  return useMcDashboardStore.getState().launch[characterId] === true;
}

/**
 * Phone-button action (from a non-call view): start or return to a call.
 *
 * - Call already running -> return to the fullscreen call view (explicit user
 *   intent; the game, if open, stays open behind it).
 * - No call, game surface open -> start the call in place (no navigation);
 *   VoiceCallScreen's consent gate is honored by falling back to the
 *   fullscreen view when the voice module is not installed yet.
 * - No call, no game -> today's behavior: open the fullscreen call view
 *   (its gate handles consent/install, then dials).
 */
export function startOrOpenCall(characterId: string): void {
  const navigate = useUiStore.getState().navigate;
  const voice = useVoiceStore.getState();
  const callActive =
    voice.participants.length > 0 && (voice.status === 'live' || voice.status === 'connecting');

  if (callActive || !isGameSurfaceOpen(characterId)) {
    navigate({ kind: 'voice-call', characterId });
    return;
  }

  void isVoiceModelReady()
    .then((ready) => {
      if (ready) {
        // startCall() is smart: dials a fresh call, or adds this character to
        // one already open. Idempotent for an existing participant.
        void useVoiceStore.getState().startCall(characterId);
      } else {
        navigate({ kind: 'voice-call', characterId });
      }
    })
    .catch(() => navigate({ kind: 'voice-call', characterId }));
}
