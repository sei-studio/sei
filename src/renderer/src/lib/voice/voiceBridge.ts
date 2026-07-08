/**
 * voiceBridge (260705) — tiny mutable seam between the chat store and the
 * voice store, so neither imports the other (both are module-init singletons;
 * a direct circular import would make their init order load-bearing).
 *
 * useVoiceStore registers itself here at module init; useChatStore calls the
 * two functions below on every companion reply / call-state check. With no
 * call open they are no-ops.
 */

interface VoiceHooks {
  /** A companion chat message landed (send() reply or chat:message push). */
  onCompanionText(characterId: string, text: string): void;
  /** Is a voice call currently open with this character? */
  isCallActive(characterId: string): boolean;
  /**
   * The companion asked to hang up (end_call() — via the send() result flag or
   * the voice:call-ended push). Finish speaking what's queued, then end.
   */
  onRemoteEndCall(characterId: string): void;
  /**
   * The player sent a message to an on-call companion through a surface the
   * voice director doesn't own (typed into the chat composer mid-call). On a
   * group call the director mirrors it to the other companions and captures the
   * reply so the banter chain still runs; otherwise a typed message is a
   * conversation only its addressee ever hears.
   */
  onPlayerText(characterId: string, text: string): void;
  /**
   * Names of the OTHER companions on the live call with this character ([]
   * when solo or no call). A typed mid-call send must frame the reply as a
   * group turn (chatSend voicePeers) exactly like the director's own sends,
   * or the model answers as if alone on the line.
   */
  voicePeersFor(characterId: string): string[];
}

let hooks: VoiceHooks | null = null;

export function registerVoiceHooks(h: VoiceHooks): void {
  hooks = h;
}

export function notifyCompanionText(characterId: string, text: string): void {
  try {
    hooks?.onCompanionText(characterId, text);
  } catch {
    /* voice layer must never break chat */
  }
}

export function isVoiceCallActive(characterId: string): boolean {
  try {
    return hooks?.isCallActive(characterId) ?? false;
  } catch {
    return false;
  }
}

export function requestRemoteEndCall(characterId: string): void {
  try {
    hooks?.onRemoteEndCall(characterId);
  } catch {
    /* voice layer must never break chat */
  }
}

export function notifyPlayerText(characterId: string, text: string): void {
  try {
    hooks?.onPlayerText(characterId, text);
  } catch {
    /* voice layer must never break chat */
  }
}

export function voiceCallPeers(characterId: string): string[] {
  try {
    return hooks?.voicePeersFor(characterId) ?? [];
  } catch {
    return [];
  }
}
