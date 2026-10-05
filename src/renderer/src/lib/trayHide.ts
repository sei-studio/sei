/**
 * The main window was hidden to the menu bar / tray (261005, review fix).
 *
 * The renderer keeps running while hidden (backgroundThrottling is off), so a
 * voice call would keep listening and a Backseat share would keep capturing
 * with nothing on screen to show it. Closing the window has to end both, the
 * same way the hang-up button does: capture first, then the call, through the
 * ordinary teardown paths, so main writes the usual rows and _ended events.
 * A Minecraft bot keeps playing; that is what the tray mode is for.
 */
import { useBackseatStore } from './stores/useBackseatStore';
import { useVoiceStore } from './stores/useVoiceStore';
import { useUiStore } from './stores/useUiStore';

export function endCallSurfacesForTrayHide(): void {
  try {
    const backseat = useBackseatStore.getState();
    // A share armed for a call that is still connecting, or one waiting for
    // its game's window, must not start while nobody can see it.
    backseat.clearPendingShare();
    backseat.stopWatch();
    if (backseat.sharingFor) void backseat.stopSharing();
  } catch {
    /* keep going: the call still has to end */
  }
  try {
    const voice = useVoiceStore.getState();
    if (voice.participants.length > 0 || voice.status !== 'idle') {
      const characterId = voice.callCharacterId;
      voice.endCall();
      // Reopening should not land on a dead call screen (the hang-up
      // button's onHangUp does the same).
      const ui = useUiStore.getState();
      if (ui.view.kind === 'voice-call') {
        ui.navigate(characterId ? { kind: 'chat', characterId } : { kind: 'home' });
      }
    }
  } catch {
    /* best effort */
  }
}
