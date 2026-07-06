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
