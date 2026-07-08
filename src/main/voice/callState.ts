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
/** When each character's call last ended (ms epoch), kept briefly so a reply the
 * in-game bot generated DURING the call but emitted a beat after hang-up is still
 * treated as a call line — see wasCallRecentlyActive / onBotChat in index.ts. */
const endedCalls = new Map<string, number>();

/** Grace window after hang-up during which a late in-game say() is still counted
 * as call audio (voice-flagged, hidden from the DM thread) rather than surfacing
 * as a normal chat message. Covers the LLM/TTS tail of a turn the bot began mid
 * call; short enough that genuinely post-call in-game chatter still shows. */
const RECENT_CALL_GRACE_MS = 8000;

export function setCallActive(characterId: string, active: boolean): void {
  if (active) {
    activeCalls.add(characterId);
    endedCalls.delete(characterId);
  } else if (activeCalls.delete(characterId)) {
    endedCalls.set(characterId, Date.now());
  }
}

export function isCallActive(characterId: string): boolean {
  return activeCalls.has(characterId);
}

/** True if the character is on a call OR hung up within RECENT_CALL_GRACE_MS. */
export function wasCallRecentlyActive(characterId: string): boolean {
  if (activeCalls.has(characterId)) return true;
  const endedAt = endedCalls.get(characterId);
  if (endedAt === undefined) return false;
  if (Date.now() - endedAt <= RECENT_CALL_GRACE_MS) return true;
  endedCalls.delete(characterId);
  return false;
}

/** Ids with an open call — used by the renderer-death sweep in index.ts. */
export function activeCallIds(): string[] {
  return [...activeCalls];
}

/**
 * Drop every open call. A call cannot survive its renderer (the mic + audio
 * live there), so index.ts calls this when the renderer navigates/reloads or
 * its process dies — otherwise a mid-call reload leaves the flag stuck and an
 * in-game bot mutes its minecraft chat forever.
 */
export function clearAllCalls(): void {
  const now = Date.now();
  for (const id of activeCalls) endedCalls.set(id, now);
  activeCalls.clear();
}
