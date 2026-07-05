/**
 * useVoiceStore (260705) — the live voice-call session.
 *
 * One call at a time. startCall() spins up the whole pipeline:
 *   mic → energy VAD → local Whisper (worker)  ──transcript──▶ useChatStore.send()
 *   companion reply text (send() result or chat:message push, via voiceBridge)
 *     ──voiceTts (proxy)──▶ audio queue → speakers
 * and tells main the call is open (voice:call-state), which flips the
 * voice-call primer on in prompts and reroutes an in-game bot's say() lines to
 * the call. endCall() tears all of it down and tells main — including how long
 * the call was actually live (connectedMs), which main turns into the
 * "You and X called for Y" transcript row.
 *
 * Once live, main is asked to make the companion GREET first (voice:greet —
 * like answering the phone), and the companion can hang up on its own via
 * end_call(): the remote-end path (voiceBridge.requestRemoteEndCall, wired to
 * both the send() result flag and the voice:call-ended push) waits for the
 * goodbye to finish playing before tearing down.
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
  /** While connecting: model-download percentage ('43') or null (no download
   * in flight — cached model, or still acquiring the mic). */
  connectingDetail: string | null;

  startCall: (characterId: string) => Promise<void>;
  endCall: () => void;
}

/** Non-reactive session internals (torn down in endCall). */
let dictation: Dictation | null = null;
let queue: AudioQueue | null = null;
/** Session token — guards async completions from a superseded/ended call. */
let session = 0;
/** When the call went LIVE (audio pipeline up) — basis for connectedMs. */
let liveSince: number | null = null;
/** TTS fetches in flight — the remote-end drain waits for these. */
let pendingTts = 0;
/** Companion hang-up (end_call): end as soon as queued speech finishes. */
let remoteEndAt: number | null = null;
let remoteEndTimers: number[] = [];

/** Companion-initiated hang-up must not clip the goodbye: the end_call signal
 * can beat the goodbye's TTS fetch, so wait at least this long before ending
 * on an idle queue. */
const REMOTE_END_GRACE_MS = 1800;
/** Hard bound — a stuck TTS fetch must not leave a zombie "ended" call. */
const REMOTE_END_MAX_WAIT_MS = 12_000;

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/VOICE_NO_SESSION/.test(msg)) return 'Sign in to use voice calls.';
  if (/VOICE_NO_CREDITS/.test(msg)) return "You're out of playtime — add more to keep calling.";
  if (/VOICE_RATE_LIMITED/.test(msg)) return "You've hit today's usage cap — it resets tomorrow.";
  if (/VOICE_NOT_CONFIGURED/.test(msg)) return 'Voice service is not available right now.';
  if (/permission/i.test(msg)) return 'Microphone access was blocked. Allow it and try again.';
  return 'Voice call failed to start. Try again in a moment.';
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  // Forward the shared mute toggle (useUiStore.callMuted) into the live mic.
  useUiStore.subscribe((s, prev) => {
    if (s.callMuted !== prev.callMuted) dictation?.setMuted(s.callMuted);
  });

  /** Companion hang-up: end once nothing is left to say (or the grace/max
   * timers decide nothing more is coming). Checked on every TTS settle and
   * every queue speaking→false edge. */
  function maybeFinishRemoteEnd(): void {
    if (remoteEndAt === null) return;
    const s = get();
    if (!s.callCharacterId) {
      remoteEndAt = null;
      return;
    }
    const waited = Date.now() - remoteEndAt;
    const drained = pendingTts === 0 && !(queue?.speaking() ?? false);
    if ((drained && waited >= REMOTE_END_GRACE_MS) || waited >= REMOTE_END_MAX_WAIT_MS) {
      remoteEndAt = null;
      const characterId = s.callCharacterId;
      get().endCall();
      // If the call screen is up it would immediately re-dial (its mount
      // effect treats "no call for this character" as intent to start one) —
      // route it back to chat instead. A minimized call just disappears.
      const ui = useUiStore.getState();
      if (ui.view.kind === 'voice-call' && ui.view.characterId === characterId) {
        ui.navigate({ kind: 'chat', characterId });
      }
    }
  }

  function requestRemoteEnd(characterId: string): void {
    const s = get();
    if (s.callCharacterId !== characterId) return;
    if (remoteEndAt !== null) return;
    remoteEndAt = Date.now();
    // Re-check after the grace window (covers "goodbye already played / never
    // came") and at the hard bound (covers a stuck TTS fetch).
    remoteEndTimers.push(window.setTimeout(maybeFinishRemoteEnd, REMOTE_END_GRACE_MS + 50));
    remoteEndTimers.push(window.setTimeout(maybeFinishRemoteEnd, REMOTE_END_MAX_WAIT_MS + 50));
  }

  // Chat → voice seam: companion text lands here from BOTH reply paths, and
  // companion hang-ups from BOTH end_call paths (send() flag / main push).
  registerVoiceHooks({
    isCallActive: (characterId) => get().callCharacterId === characterId,
    onRemoteEndCall: requestRemoteEnd,
    onCompanionText: (characterId, text) => {
      const s = get();
      if (s.callCharacterId !== characterId || s.status !== 'live') return;
      const mySession = session;
      set({ lastSpoken: text });
      pendingTts += 1;
      void sei
        .voiceTts({ characterId, text })
        .then((buf) => {
          if (session === mySession) queue?.enqueue(buf);
        })
        .catch((err) => {
          // A failed clip should not kill the call; surface out-of-allowance
          // copy in the caption line so the silence is explained.
          if (session !== mySession) return;
          const msg = String((err as Error)?.message ?? '');
          if (/VOICE_RATE_LIMITED/.test(msg)) {
            set({ lastSpoken: '[voice paused — daily usage cap reached]' });
          } else if (/VOICE_NO_CREDITS/.test(msg)) {
            set({ lastSpoken: '[voice paused — out of playtime]' });
          }
        })
        .finally(() => {
          pendingTts = Math.max(0, pendingTts - 1);
          maybeFinishRemoteEnd();
        });
    },
  });

  // Companion hung up from IN-GAME (end_call → main push). The idle-chat path
  // arrives via the send() result flag instead (useChatStore → voiceBridge).
  try {
    sei.onVoiceCallEnded?.(({ characterId }) => requestRemoteEnd(characterId));
  } catch {
    /* preload without onVoiceCallEnded — companion hang-ups just won't land */
  }

  return {
    callCharacterId: null,
    status: 'idle',
    speaking: false,
    lastHeard: '',
    lastSpoken: '',
    error: null,
    connectingDetail: null,

    startCall: async (characterId) => {
      const prev = get();
      if (prev.callCharacterId === characterId && prev.status !== 'error') return;
      if (prev.callCharacterId) get().endCall();

      const mySession = ++session;
      liveSince = null;
      pendingTts = 0;
      remoteEndAt = null;
      set({
        callCharacterId: characterId,
        status: 'connecting',
        speaking: false,
        lastHeard: '',
        lastSpoken: '',
        error: null,
        connectingDetail: null,
      });

      // Tell main immediately so an in-game bot goes quiet in chat and starts
      // routing to the call while the mic/model finish warming up.
      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});

      queue = createAudioQueue((speaking) => {
        if (session !== mySession) return;
        set({ speaking });
        dictation?.setHold(speaking);
        if (!speaking) maybeFinishRemoteEnd();
      });

      try {
        dictation = await createDictation({
          // First-run model download progress → "Preparing voice… N%" so the
          // ~40MB fetch never reads as a hang (260705 field report).
          onStatus: (status, detail) => {
            if (session !== mySession) return;
            set({ connectingDetail: status === 'loading-model' && detail ? detail : null });
          },
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
        // No connectedMs — the call never went live, so nothing is logged.
        void sei.voiceCallSetActive({ characterId, active: false }).catch(() => {});
        set({ status: 'error', error: friendlyError(err), connectingDetail: null });
        return;
      }

      if (session !== mySession) {
        // endCall (or a newer call) won while we were loading.
        dictation.stop();
        dictation = null;
        return;
      }
      dictation.setMuted(useUiStore.getState().callMuted);
      liveSince = Date.now();
      set({ status: 'live', connectingDetail: null });
      // The line is open — ask main to have the companion speak FIRST (like
      // answering the phone). Best-effort; the call works without it.
      void sei.voiceGreet?.(characterId)?.catch(() => {});
    },

    endCall: () => {
      const { callCharacterId } = get();
      session += 1;
      const connectedMs = liveSince !== null ? Date.now() - liveSince : undefined;
      liveSince = null;
      pendingTts = 0;
      remoteEndAt = null;
      for (const t of remoteEndTimers) window.clearTimeout(t);
      remoteEndTimers = [];
      dictation?.stop();
      dictation = null;
      queue?.stop();
      queue = null;
      if (callCharacterId) {
        // connectedMs (live-time only) lets main post the "You and X called
        // for Y" transcript row; absent when the call never connected.
        void sei
          .voiceCallSetActive({
            characterId: callCharacterId,
            active: false,
            ...(connectedMs !== undefined ? { connectedMs } : {}),
          })
          .catch(() => {});
      }
      set({
        callCharacterId: null,
        status: 'idle',
        speaking: false,
        lastHeard: '',
        lastSpoken: '',
        error: null,
        connectingDetail: null,
      });
      // Keep the legacy UI-store call state in sync (MinimizedCall/mute).
      useUiStore.getState().endCall();
    },
  };
});
