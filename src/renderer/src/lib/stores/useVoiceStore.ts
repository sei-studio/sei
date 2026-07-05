/**
 * useVoiceStore (260705) — the live voice-call session.
 *
 * One call at a time. startCall() spins up the whole pipeline:
 *   mic → energy VAD → local Whisper (worker)  ──transcript──▶ useChatStore.send()
 *   companion reply text (send() result or chat:message push, via voiceBridge)
 *     ──voiceTts (proxy)──▶ audio queue → speakers
 * and tells main the call is open (voice:call-state), which flips the
 * voice-call primer on in prompts and reroutes an in-game bot's say() lines to
 * the call. endCall() tears all of it down and tells main.
 *
 * Mute lives in useUiStore (shared with the MinimizedCall widget, which
 * predates this store); we subscribe and forward it to the mic pipeline.
 * Half-duplex: while companion audio is audible the mic is held, so the
 * companion never hears itself (belt to getUserMedia echoCancellation's
 * suspenders).
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';
import { useChatStore } from './useChatStore';
import { createAudioQueue, type AudioQueue } from '../voice/audioQueue';
import { createDictation, type Dictation } from '../voice/dictation';
import { registerVoiceHooks } from '../voice/voiceBridge';

export type CallStatus =
  | 'idle'
  | 'connecting' // mic permission + model load in flight
  | 'live'
  | 'error';

interface VoiceState {
  /** Character the call is with; null when no call. */
  callCharacterId: string | null;
  status: CallStatus;
  /** Companion audio currently playing (drives the avatar pulse). */
  speaking: boolean;
  /** Last transcribed player utterance (caption line). */
  lastHeard: string;
  /** Last companion line sent to TTS (caption line). */
  lastSpoken: string;
  /** User-facing error copy when status === 'error'. */
  error: string | null;

  startCall: (characterId: string) => Promise<void>;
  endCall: () => void;
}

/** Non-reactive session internals (torn down in endCall). */
let dictation: Dictation | null = null;
let queue: AudioQueue | null = null;
/** Session token — guards async completions from a superseded/ended call. */
let session = 0;

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/VOICE_NO_SESSION/.test(msg)) return 'Sign in to use voice calls.';
  if (/VOICE_RATE_LIMITED/.test(msg)) return "You've used today's voice time — it resets tomorrow.";
  if (/VOICE_NOT_CONFIGURED/.test(msg)) return 'Voice service is not available right now.';
  if (/permission/i.test(msg)) return 'Microphone access was blocked. Allow it and try again.';
  return 'Voice call failed to start. Try again in a moment.';
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  // Forward the shared mute toggle (useUiStore.callMuted) into the live mic.
  useUiStore.subscribe((s, prev) => {
    if (s.callMuted !== prev.callMuted) dictation?.setMuted(s.callMuted);
  });

  // Chat → voice seam: companion text lands here from BOTH reply paths.
  registerVoiceHooks({
    isCallActive: (characterId) => get().callCharacterId === characterId,
    onCompanionText: (characterId, text) => {
      const s = get();
      if (s.callCharacterId !== characterId || s.status !== 'live') return;
      const mySession = session;
      set({ lastSpoken: text });
      void sei
        .voiceTts({ characterId, text })
        .then((buf) => {
          if (session === mySession) queue?.enqueue(buf);
        })
        .catch((err) => {
          // A failed clip should not kill the call; surface rate-limit copy
          // in the caption line so the silence is explained.
          if (session === mySession && /VOICE_RATE_LIMITED/.test(String((err as Error)?.message))) {
            set({ lastSpoken: '[voice paused — daily voice time used]' });
          }
        });
    },
  });

  return {
    callCharacterId: null,
    status: 'idle',
    speaking: false,
    lastHeard: '',
    lastSpoken: '',
    error: null,

    startCall: async (characterId) => {
      const prev = get();
      if (prev.callCharacterId === characterId && prev.status !== 'error') return;
      if (prev.callCharacterId) get().endCall();

      const mySession = ++session;
      set({
        callCharacterId: characterId,
        status: 'connecting',
        speaking: false,
        lastHeard: '',
        lastSpoken: '',
        error: null,
      });

      // Tell main immediately so an in-game bot goes quiet in chat and starts
      // routing to the call while the mic/model finish warming up.
      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});

      queue = createAudioQueue((speaking) => {
        if (session !== mySession) return;
        set({ speaking });
        dictation?.setHold(speaking);
      });

      try {
        dictation = await createDictation({
          onStatus: () => {},
          onUtterance: (text) => {
            if (session !== mySession) return;
            const s = get();
            if (s.status !== 'live' || !s.callCharacterId) return;
            set({ lastHeard: text });
            // Same pipeline as typed chat: persists, routes to a live game
            // session, and the reply comes back through the voice hooks above.
            void useChatStore.getState().send(s.callCharacterId, text);
          },
        });
      } catch (err) {
        if (session !== mySession) return;
        queue?.stop();
        queue = null;
        void sei.voiceCallSetActive({ characterId, active: false }).catch(() => {});
        set({ status: 'error', error: friendlyError(err) });
        return;
      }

      if (session !== mySession) {
        // endCall (or a newer call) won while we were loading.
        dictation.stop();
        dictation = null;
        return;
      }
      dictation.setMuted(useUiStore.getState().callMuted);
      set({ status: 'live' });
    },

    endCall: () => {
      const { callCharacterId } = get();
      session += 1;
      dictation?.stop();
      dictation = null;
      queue?.stop();
      queue = null;
      if (callCharacterId) {
        void sei.voiceCallSetActive({ characterId: callCharacterId, active: false }).catch(() => {});
      }
      set({
        callCharacterId: null,
        status: 'idle',
        speaking: false,
        lastHeard: '',
        lastSpoken: '',
        error: null,
      });
      // Keep the legacy UI-store call state in sync (MinimizedCall/mute).
      useUiStore.getState().endCall();
    },
  };
});
