/**
 * 261110: her voice on the desktop. A call's TTS plays in the main window;
 * the companion on the desktop (WorldLink) must move her mouth while it
 * does. Pure parts of SeilinkVoiceRelay (components/seilink/SeilinkVoiceRelay.tsx).
 */
import type { SeilinkHostStatus } from '@shared/seilinkHost';

/** The companion whose room is on the desktop now, or null. */
export function desktopResident(status: SeilinkHostStatus | null | undefined): string | null {
  if (!status || !status.characterId) return null;
  return status.state === 'running' || status.state === 'starting' || status.state === 'restarting' ? status.characterId : null;
}

/**
 * Whether the resident is talking: the voice store's speaker is her. Another
 * companion talking in a group call is not her.
 */
export function residentSpeaking(resident: string | null, speakingId: string | null): boolean {
  return resident !== null && speakingId === resident;
}
