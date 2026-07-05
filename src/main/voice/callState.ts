/**
 * Voice-call state (260705) — which characters currently have an open voice
 * call. Main-process source of truth, written by the `voice:call-state` IPC
 * handler when the renderer opens/hangs up a call, and read by:
 *   - the chat.send handler → sendChatMessage voiceCall flag (idle-chat prompt
 *     gets the VOICE_CALL_PRIMER),
 *   - botSupervisor (via opts.isVoiceCallActive) → re-applies the mode to a
 *     bot that spawns mid-call (the launch()-during-a-call handoff).
 *
 * Deliberately not persisted: a call cannot outlive the renderer that is
 * playing its audio, so process restart == every call ended.
 */

const activeCalls = new Set<string>();

export function setCallActive(characterId: string, active: boolean): void {
  if (active) activeCalls.add(characterId);
  else activeCalls.delete(characterId);
}

export function isCallActive(characterId: string): boolean {
  return activeCalls.has(characterId);
}
