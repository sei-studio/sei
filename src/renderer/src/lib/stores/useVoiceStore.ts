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
import { createAudioQueue, type AudioQueue, type TtsStreamHandle } from '../voice/audioQueue';
import { createDictation, type Dictation } from '../voice/dictation';
import { registerVoiceHooks } from '../voice/voiceBridge';
import {
  startRingtone,
  startAmbience,
  playHangupChime,
  playMuteClick,
  type StopFn,
} from '../voice/callTones';

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
  /** Epoch ms the call went live — drives the on-screen duration timer. */
  liveAt: number | null;

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
/** First moment the goodbye was observed fully drained (tail-delay basis). */
let remoteDrainedAt: number | null = null;
let remoteEndTimers: number[] = [];
/** Call dressing (260705): two-tone ring while dialing, comfort-noise bed
 * while live. Stop fns owned here; null when silent. */
let stopRing: StopFn | null = null;
let stopAmbience: StopFn | null = null;
/** Live TTS streams: streamId → queue slot. Chunk pushes multiplex over one
 * subscription; `orphans` catches chunks that beat the id registration. */
const ttsStreams = new Map<string, TtsStreamHandle>();
const ttsOrphans = new Map<string, Array<{ chunk?: ArrayBuffer; done?: boolean; error?: string }>>();

function silenceDressing(): void {
  stopRing?.();
  stopRing = null;
  stopAmbience?.();
  stopAmbience = null;
}

/** Companion-initiated hang-up must not clip the goodbye: the end_call signal
 * can beat the goodbye's TTS fetch, so wait at least this long before ending
 * on an idle queue. */
const REMOTE_END_GRACE_MS = 1800;
/** ...and once the goodbye HAS finished, linger this long before hanging up —
 * ending exactly on the queue-empty edge audibly clipped the last word
 * (260705 field report: Marv), and an instant hang-up feels abrupt anyway. */
const REMOTE_END_TAIL_MS = 700;
/** Hard bound — a stuck TTS fetch must not leave a zombie "ended" call. */
const REMOTE_END_MAX_WAIT_MS = 12_000;
/** Dial theater (260705): let the ring play at least this long before the
 * companion "picks up" — the greeting LLM call fires only after it. An
 * instant pickup reads as fake; a couple of rings reads as a phone. */
const MIN_RING_MS = 3000;

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
  // Forward the shared mute toggle (useUiStore.callMuted) into the live mic,
  // with a state-encoding click (down = muted, up = live) while on a call.
  // Deafen (260705) silences the call's OUTPUT — companion voice and the
  // ambience bed — without pausing playback, so undeafening rejoins live.
  useUiStore.subscribe((s, prev) => {
    if (s.callMuted !== prev.callMuted) {
      dictation?.setMuted(s.callMuted);
      if (get().callCharacterId) playMuteClick(s.callMuted);
    }
    if (s.callDeafened !== prev.callDeafened) {
      queue?.setOutputMuted(s.callDeafened);
      if (get().status === 'live') {
        if (s.callDeafened) {
          stopAmbience?.();
          stopAmbience = null;
        } else if (!stopAmbience) {
          stopAmbience = startAmbience();
        }
      }
      if (get().callCharacterId) playMuteClick(s.callDeafened);
    }
  });

  /** Companion hang-up: end once nothing is left to say (or the grace/max
   * timers decide nothing more is coming). Checked on every TTS settle and
   * every queue speaking→false edge. */
  function maybeFinishRemoteEnd(): void {
    if (remoteEndAt === null) return;
    const s = get();
    if (!s.callCharacterId) {
      remoteEndAt = null;
      remoteDrainedAt = null;
      return;
    }
    const waited = Date.now() - remoteEndAt;
    const drained = pendingTts === 0 && !(queue?.speaking() ?? false);
    // Tail delay: hang up REMOTE_END_TAIL_MS after the goodbye finishes, not
    // on the queue-empty edge (which audibly clipped the last word). A new
    // clip starting resets the basis.
    if (!drained) {
      remoteDrainedAt = null;
    } else if (remoteDrainedAt === null) {
      remoteDrainedAt = Date.now();
      remoteEndTimers.push(window.setTimeout(maybeFinishRemoteEnd, REMOTE_END_TAIL_MS + 30));
    }
    const tailDone = drained && remoteDrainedAt !== null && Date.now() - remoteDrainedAt >= REMOTE_END_TAIL_MS;
    if ((tailDone && waited >= REMOTE_END_GRACE_MS) || waited >= REMOTE_END_MAX_WAIT_MS) {
      remoteEndAt = null;
      remoteDrainedAt = null;
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

      const surfaceTtsError = (msg: string): void => {
        // A failed clip should not kill the call; surface out-of-allowance
        // copy in the caption line so the silence is explained.
        if (session !== mySession) return;
        if (/VOICE_RATE_LIMITED/.test(msg)) {
          set({ lastSpoken: '[voice paused — daily usage cap reached]' });
        } else if (/VOICE_NO_CREDITS/.test(msg)) {
          set({ lastSpoken: '[voice paused — out of playtime]' });
        }
      };
      const settleTts = (): void => {
        pendingTts = Math.max(0, pendingTts - 1);
        maybeFinishRemoteEnd();
      };

      // Streaming path (260705): reserve the queue slot NOW (reply order is
      // arrival order of text, not fetch completion) and play chunks as they
      // land — first audio on the first mp3 frame. pendingTts stays held
      // until the stream's terminal push (see onVoiceTtsChunk below).
      const canStream =
        typeof sei.voiceTtsStream === 'function' && typeof sei.onVoiceTtsChunk === 'function';
      if (canStream && queue) {
        const handle = queue.enqueueStream();
        void sei
          .voiceTtsStream({ characterId, text })
          .then(({ streamId }) => {
            if (session !== mySession) {
              handle.fail();
              settleTts();
              return;
            }
            ttsStreams.set(streamId, handle);
            // Flush any chunks that beat this registration (paranoia; invoke
            // replies normally land before push events).
            const early = ttsOrphans.get(streamId);
            if (early) {
              ttsOrphans.delete(streamId);
              for (const p of early) applyTtsPush(streamId, p);
            }
          })
          .catch((err) => {
            handle.fail();
            surfaceTtsError(String((err as Error)?.message ?? ''));
            settleTts();
          });
        return;
      }

      void sei
        .voiceTts({ characterId, text })
        .then((buf) => {
          if (session === mySession) queue?.enqueue(buf);
        })
        .catch((err) => surfaceTtsError(String((err as Error)?.message ?? '')))
        .finally(settleTts);
    },
  });

  /** Route one voice:tts-chunk push into its queue slot. Terminal pushes
   * release the slot and the pendingTts hold. */
  function applyTtsPush(
    streamId: string,
    push: { chunk?: ArrayBuffer; done?: boolean; error?: string },
  ): void {
    const handle = ttsStreams.get(streamId);
    if (!handle) return;
    if (push.chunk) handle.push(push.chunk);
    if (push.done || push.error) {
      ttsStreams.delete(streamId);
      if (push.error) handle.fail();
      else handle.end();
      pendingTts = Math.max(0, pendingTts - 1);
      maybeFinishRemoteEnd();
    }
  }

  try {
    sei.onVoiceTtsChunk?.((push) => {
      if (!ttsStreams.has(push.streamId)) {
        // Not registered (yet): park briefly in case the {streamId} reply is
        // still in flight; drop quietly if it never registers (ended call).
        if (ttsOrphans.size > 32) ttsOrphans.clear();
        const list = ttsOrphans.get(push.streamId) ?? [];
        list.push(push);
        ttsOrphans.set(push.streamId, list);
        return;
      }
      applyTtsPush(push.streamId, push);
    });
  } catch {
    /* preload without streaming — buffered path covers it */
  }

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
    liveAt: null,

    startCall: async (characterId) => {
      const prev = get();
      if (prev.callCharacterId === characterId && prev.status !== 'error') return;
      if (prev.callCharacterId) get().endCall();

      const mySession = ++session;
      const dialStart = Date.now();
      liveSince = null;
      pendingTts = 0;
      remoteEndAt = null;
      remoteDrainedAt = null;
      ttsStreams.clear();
      ttsOrphans.clear();
      set({
        callCharacterId: characterId,
        status: 'connecting',
        speaking: false,
        lastHeard: '',
        lastSpoken: '',
        error: null,
        connectingDetail: null,
        liveAt: null,
      });

      // Ring while dialing (260705) — stopped the moment the line opens.
      silenceDressing();
      stopRing = startRingtone();

      // Tell main immediately so an in-game bot goes quiet in chat and starts
      // routing to the call while the mic/model finish warming up.
      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});

      queue = createAudioQueue((speaking) => {
        if (session !== mySession) return;
        set({ speaking });
        dictation?.setHold(speaking);
        if (!speaking) maybeFinishRemoteEnd();
      });
      queue.setOutputMuted(useUiStore.getState().callDeafened);

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
          onBargeIn: () => {
            // The player spoke over the companion (260705): cut playback and
            // drop everything queued, immediately. The utterance that
            // triggered this keeps capturing and lands via onUtterance.
            if (session !== mySession) return;
            queue?.clear();
          },
        });
      } catch (err) {
        if (session !== mySession) return;
        queue?.stop();
        queue = null;
        silenceDressing();
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

      // Let it RING (260705): the companion picks up no sooner than
      // MIN_RING_MS after dialing — the greeting LLM turn fires after this,
      // not during it. Mic/model warm-up usually fits inside the window.
      const ringLeft = MIN_RING_MS - (Date.now() - dialStart);
      if (ringLeft > 0) {
        await new Promise((r) => window.setTimeout(r, ringLeft));
        if (session !== mySession) return; // hung up while ringing
      }
      liveSince = Date.now();
      // Line open: ring stops, the constant low comfort-noise bed starts (the
      // TTS noise floor otherwise reads as "static only while talking") —
      // unless the user pre-deafened while it rang.
      silenceDressing();
      if (!useUiStore.getState().callDeafened) stopAmbience = startAmbience();
      set({ status: 'live', connectingDetail: null, liveAt: liveSince });
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
      remoteDrainedAt = null;
      for (const t of remoteEndTimers) window.clearTimeout(t);
      remoteEndTimers = [];
      silenceDressing();
      // Closing chime — same instrument as the ring, own AudioContext so this
      // teardown can't clip it. Plays for player AND companion hang-ups (the
      // remote path funnels through here).
      if (callCharacterId) playHangupChime();
      ttsStreams.clear();
      ttsOrphans.clear();
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
        liveAt: null,
      });
      // Keep the legacy UI-store call state in sync (MinimizedCall/mute).
      useUiStore.getState().endCall();
    },
  };
});
