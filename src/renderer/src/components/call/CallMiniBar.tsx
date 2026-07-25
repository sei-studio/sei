/**
 * CallMiniBar — the app-level call watchdog (260722 rework; renders NOTHING).
 * The old docked CallDock strip is gone: while a game surface is open the
 * in-game call UI lives inside GameSurface's bottom chrome row instead.
 *
 * Always mounted in the App shell so one responsibility survives every view:
 *
 *   Auto-return: when the LAST open game surface drops while a call session
 *   exists and the fullscreen call view is not on screen, restore the call
 *   view (spec: "ending the game returns the call to its normal fullscreen
 *   surface").
 *
 * On non-chat views with a call running there is deliberately no floating
 * call UI: the icon-rail activity badge is the ambient indicator, and
 * clicking the character (or the chat top bar's phone) returns to the call.
 */

import { useEffect, useRef } from 'react';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useChessStore, isChessOpen } from '../../lib/stores/useChessStore';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';

export function CallMiniBar(): null {
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const participants = useVoiceStore((s) => s.participants);
  const status = useVoiceStore((s) => s.status);
  const summons = useDataStore((s) => s.summons);
  const chessState = useChessStore((s) => s);
  const mcDashState = useMcDashboardStore((s) => s);

  const callExists = participants.length > 0 && (status === 'live' || status === 'connecting');
  const awayFromCall = callExists && view.kind !== 'voice-call';

  // Any OPEN game surface among the call's participants (chess panel or a
  // game, the Minecraft dashboard or launch panel). Surface-open (not
  // game-live) on purpose: a resigned chess game still shows its result
  // screen, and the call should only reclaim the screen once the surface is
  // actually gone (the unified end "x").
  const gameActive = participants.some((id) => {
    if (isChessOpen(chessState, id)) return true;
    const online = summons[id]?.kind === 'online';
    // The Minecraft dashboard is always open while the bot is online (no
    // hide/minimize, 260721); offline, the launch panel counts while open.
    return online || mcDashState.launch[id] === true;
  });

  // Ending the game returns the call to its fullscreen surface: when the last
  // open game surface drops while the call is elsewhere, restore the call view.
  const prevGameActive = useRef(false);
  useEffect(() => {
    const was = prevGameActive.current;
    prevGameActive.current = gameActive;
    if (was && !gameActive && awayFromCall && participants.length > 0) {
      navigate({ kind: 'voice-call', characterId: participants[0] });
    }
  }, [gameActive, awayFromCall, participants, navigate]);

  return null;
}
