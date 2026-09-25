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

/** When each open call went LIVE (the renderer's connect, not the dial). */
const liveSince = new Map<string, number>();

/**
 * Calls main closed itself on an account switch (260926). The renderer tears
 * its half of the call down afterwards and reports the hang-up as usual; that
 * report must not post a second call row (into the NEW account's transcript)
 * or a second voice_call_ended. Consumed by the report, cleared by a new dial.
 */
const closedByMain = new Set<string>();

export function setCallActive(characterId: string, active: boolean): void {
  if (active) {
    activeCalls.add(characterId);
    endedCalls.delete(characterId);
    liveSince.delete(characterId);
    closedByMain.delete(characterId);
  } else if (activeCalls.delete(characterId)) {
    endedCalls.set(characterId, Date.now());
    liveSince.delete(characterId);
  }
}

/**
 * The renderer's call connected (the moment its stopwatch starts). Ignored
 * for a call main no longer has open, so a connect racing an account switch
 * cannot resurrect a call main already ended.
 */
export function markCallLive(characterId: string): void {
  if (activeCalls.has(characterId) && !liveSince.has(characterId)) {
    liveSince.set(characterId, Date.now());
  }
}

/**
 * Close every open call from main (account switch, 260926). Returns each
 * call with how long it was live, null when it never connected (the
 * renderer's own rule: an unconnected call leaves no row and no event).
 */
export function closeAllCallsFromMain(): Array<{ characterId: string; connectedMs: number | null }> {
  const now = Date.now();
  const closed: Array<{ characterId: string; connectedMs: number | null }> = [];
  for (const id of activeCalls) {
    const since = liveSince.get(id);
    closed.push({ characterId: id, connectedMs: since === undefined ? null : Math.max(0, now - since) });
    endedCalls.set(id, now);
    closedByMain.add(id);
  }
  activeCalls.clear();
  liveSince.clear();
  return closed;
}

/**
 * True when main already closed this call: the caller skips the hang-up
 * bookkeeping the renderer's late report would otherwise repeat.
 */
export function wasClosedByMain(characterId: string): boolean {
  return closedByMain.has(characterId);
}

/** As wasClosedByMain, and forgets it: the renderer's hang-up report. */
export function consumeClosedByMain(characterId: string): boolean {
  return closedByMain.delete(characterId);
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
  liveSince.clear();
}
