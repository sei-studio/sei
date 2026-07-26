/**
 * voiceBridge (260705) — tiny mutable seam between the chat store and the
 * voice store, so neither imports the other (both are module-init singletons;
 * a direct circular import would make their init order load-bearing).
 *
 * useVoiceStore registers itself here at module init; useChatStore calls the
 * two functions below on every companion reply / call-state check. With no
 * call open they are no-ops.
 */

/**
 * Where a spoken line sits inside its OWN reply. Both fields feed ElevenLabs'
 * utterance conditioning (main/voice/tts.ts ttsContextFor), which is scoped to
 * one reply: the first line has no `prev`, the last has no `more`, and a
 * single-line reply has neither, so prosody resets at reply boundaries.
 */
export interface SpokenLineContext {
  /** The line of this same reply spoken immediately before this one. */
  prev?: string;
  /** Another line of this same reply follows this one. */
  more?: boolean;
}

interface VoiceHooks {
  /** A companion chat message landed (send() reply or chat:message push).
   * `ctx` places the line inside its reply for TTS conditioning. A pushed line
   * arrives alone with no siblings, so it passes an empty context. */
  onCompanionText(characterId: string, text: string, ctx: SpokenLineContext): void;
  /** Is a voice call currently open with this character? */
  isCallActive(characterId: string): boolean;
  /**
   * The companion asked to hang up (end_call() — via the send() result flag or
   * the voice:call-ended push). Finish speaking what's queued, then end.
   */
  onRemoteEndCall(characterId: string): void;
  /**
   * A chat turn for this companion FAILED for real (not an interrupt). Returns
   * true when the voice director owns the failure — it is retrying the turn
   * and showing "Reconnecting…", so the chat surface must NOT append its
   * unspoken apology bubble. False (no call, or not a director-dispatched
   * turn) keeps the chat surface's normal failure copy.
   */
  onTurnFailed(characterId: string): boolean;
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

export function notifyCompanionText(
  characterId: string,
  text: string,
  ctx: SpokenLineContext = {},
): void {
  try {
    hooks?.onCompanionText(characterId, text, ctx);
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

export function notifyTurnFailed(characterId: string): boolean {
  try {
    return hooks?.onTurnFailed(characterId) ?? false;
  } catch {
    return false;
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
