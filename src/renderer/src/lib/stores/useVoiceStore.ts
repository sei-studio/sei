/**
 * useVoiceStore (260705, multi-companion 260706) — the live voice-call session.
 *
 * ONE call, but it can hold MULTIPLE companions. startCall(id) dials the first;
 * calling again for another id ADDS them to the same live call (addParticipant).
 * The pipeline is shared:
 *   mic → energy VAD → local Whisper (worker)  ──transcript──▶ the DIRECTOR
 *   companion reply text  ──voiceTts (proxy)──▶ ONE audio queue → speakers
 *
 * TURN-TAKING (the director, below). The single audio queue already serializes
 * all speech, so two companions physically cannot talk over each other. The
 * director sits on top and decides WHO generates when (policy in ../voice/pfcSteer,
 * "PFC steer"):
 *   - a player utterance goes to one chosen responder (addressed-by-name, else a
 *     varied pick that down-weights whoever answered last so it is not always the
 *     same AI first) and is silently mirrored into the other companions'
 *     transcripts so they keep context;
 *   - after a companion speaks, another companion MAY react — a probabilistic,
 *     depth-decaying decision, so an exchange sometimes stops at one line and
 *     sometimes banters on for a few turns (the player can just listen);
 *   - a player barge-in bumps the director sequence, cancelling any pending
 *     chain, and clears the audio queue — the player always wins the floor.
 * The chain is bounded (PFC_MAX_CHAIN) and single-flight, so it can never
 * deadlock or run away.
 *
 * PER-COMPANION SPEAKING STATE. Every TTS clip is tagged with its characterId,
 * so the queue reports WHO is speaking; `speakingId` names that companion (null
 * when silent) and the call UIs (tasks 3-4) render each pfp lit/dimmed from it.
 *
 * Once live, main is asked to make the (first) companion GREET first; an added
 * companion greets the room. Companions can hang up via end_call(): on a solo
 * call that ends the call (after the goodbye drains); on a group call it just
 * drops that one companion.
 *
 * Mute/deafen live in useUiStore (shared with the MinimizedCall widget); we
 * subscribe and forward them. Half-duplex: while companion audio is audible the
 * mic is held, so the companions never hear themselves.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';
import { useChatStore } from './useChatStore';
import { useDataStore } from './useDataStore';
import { createAudioQueue, type AudioQueue, type TtsStreamHandle } from '../voice/audioQueue';
import { createDictation, type Dictation } from '../voice/dictation';
import { registerVoiceHooks } from '../voice/voiceBridge';
import { pickResponder, decideReaction, isJunkTranscript, type Participant } from '../voice/pfcSteer';
import {
  startRingtone,
  startAmbience,
  playConnectedChime,
  playHangupChime,
  playMuteClick,
  type StopFn,
} from '../voice/callTones';

export type CallStatus =
  | 'idle'
  | 'connecting' // mic permission + model load in flight (first dial only)
  | 'live'
  | 'error';

interface VoiceState {
  /** Companions on the call, in join order (first = the one that was dialed).
   * Empty when no call is open. */
  participants: string[];
  /** Primary participant (participants[0]); kept for the surfaces that key off a
   * single character (VoiceCallScreen dial guard, MinimizedCall). null = no call. */
  callCharacterId: string | null;
  status: CallStatus;
  /** Any companion audio currently playing (drives the minimized "on call" pulse). */
  speaking: boolean;
  /** WHICH companion is speaking right now (null when silent). Per-companion
   * speaking state for the call UIs: a pfp is lit when its id === speakingId. */
  speakingId: string | null;
  /** True while the player's own mic has live speech — lights the SAME ring on
   * the caller's avatar that companions get while speaking. */
  userSpeaking: boolean;
  /** Last transcribed player utterance (caption line). */
  lastHeard: string;
  /** Last companion line sent to TTS (caption line). */
  lastSpoken: string;
  /** Which companion said `lastSpoken` (caption attribution). */
  lastSpokenId: string | null;
  /** User-facing error copy when status === 'error'. */
  error: string | null;
  /** While connecting: model-download percentage ('43') or null. */
  connectingDetail: string | null;
  /** Epoch ms the call went live — drives the on-screen duration timer. */
  liveAt: number | null;

  /** Dial the first companion, OR add another to a call already open. */
  startCall: (characterId: string) => Promise<void>;
  /** Add a companion to the live call (no-op if already on it). */
  addParticipant: (characterId: string) => void;
  /** Drop one companion from the call (ends the whole call if it was the last). */
  removeParticipant: (characterId: string) => void;
  /** Hang up the whole call. */
  endCall: () => void;
}

/** Non-reactive session internals (torn down in endCall). */
let dictation: Dictation | null = null;
let queue: AudioQueue | null = null;
/** Session token — guards async completions from a superseded/ended call. */
let session = 0;
/** When each participant's audio went live — basis for their connectedMs row. */
const liveSince = new Map<string, number>();
/** TTS fetches in flight — the remote-end drain waits for these. */
let pendingTts = 0;
/** Companion lines that arrived while the (first) call was still 'connecting'. */
let pendingCompanionLines: Array<{ characterId: string; text: string }> = [];
const MAX_PENDING_COMPANION_LINES = 12;
/** Solo companion hang-up (end_call): end as soon as queued speech finishes. */
let remoteEndAt: number | null = null;
let remoteDrainedAt: number | null = null;
let remoteEndTimers: number[] = [];
/** Call dressing (260705): ring while dialing, comfort-noise bed while live. */
let stopRing: StopFn | null = null;
let stopAmbience: StopFn | null = null;
/** Live TTS streams: streamId → queue slot. */
const ttsStreams = new Map<string, TtsStreamHandle>();
const ttsOrphans = new Map<string, Array<{ chunk?: ArrayBuffer; done?: boolean; error?: string }>>();
/** Module-level listener handles, torn down on HMR dispose (see module foot). */
let unsubUiMirror: (() => void) | null = null;
let offTtsChunk: (() => void) | null = null;
let offCallEnded: (() => void) | null = null;

// ── PFC steer: turn-taking director state ────────────────────────────────────
// The decision policy (who speaks, whether to chain, junk rejection) lives in
// ../voice/pfcSteer; this is the mutable session state the director threads
// through it. Search "pfc steer" to find the whole seam.
/** Bumped by every player utterance and by teardown; a running companion chain
 * that finds its captured value stale aborts (barge-in / supersede). */
let directorSeq = 0;
/** Who answered the LAST player utterance — down-weighted next time so the
 * first-to-speak varies instead of always being the same AI. */
let lastResponderId: string | null = null;
/** Who reacted most recently in the current chain — down-weighted so a trio
 * spreads the floor rather than two of them ping-ponging. */
let lastReactorId: string | null = null;
/** Perf: when the last player utterance was dispatched, so we can log the
 * renderer-visible reply latency (utterance → first spoken line) to the IN-APP
 * DevTools console. Main's [sei/chat] line only reaches the terminal; this makes
 * the number visible without leaving the app. Cleared once the first line lands. */
let replyClockAt: number | null = null;
/** Small pacing gaps between chained companion turns so banter doesn't feel
 * instant (and audio has a beat to start). */
const CHAIN_GAP_FIRST_MS = 300;
const CHAIN_GAP_NEXT_MS = 450;

function silenceDressing(): void {
  stopRing?.();
  stopRing = null;
  stopAmbience?.();
  stopAmbience = null;
}

/** Resolve a companion's display name (for prompt framing + greetings). */
function nameOf(characterId: string): string {
  return useDataStore.getState().characters.find((c) => c.id === characterId)?.name ?? 'Companion';
}

/** Participant ids → {id, name} pairs for the pure turn-taking helpers. */
function asParticipants(ids: string[]): Participant[] {
  return ids.map((id) => ({ id, name: nameOf(id) }));
}

const wait = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** Solo companion hang-up must not clip the goodbye (see the single-call notes). */
const REMOTE_END_GRACE_MS = 1800;
const REMOTE_END_TAIL_MS = 700;
const REMOTE_END_MAX_WAIT_MS = 12_000;
/** Dial theater: let the ring play at least this long before the companion picks
 * up. 260706: 3000 → 1300. 3s of ring was the single largest fixed delay before
 * the first word; the greeting LLM call now runs DURING the ring (see startCall),
 * so a shorter ring lands the first word ~2s after dialing instead of ~8s. */
const MIN_RING_MS = 1300;
// 260706 (tasks 2/3): the call stays OUTGOING (ringing, no stopwatch) until the
// companion's first line is actually ready — "connected" should never begin on
// dead air. We poll for the buffered greeting up to this cap, then connect
// anyway so a slow/empty greeting can't hang the dial forever.
const GREETING_READY_CAP_MS = 5000;
// Once connected, hold a beat before the first word — a real "pickup" pause, and
// it gives the greeting's TTS first-byte a moment to land.
const CONNECT_SPEAK_DELAY_MS = 1000;

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/VOICE_NO_SESSION/.test(msg)) return 'Sign in to use voice calls.';
  if (/VOICE_NO_CREDITS/.test(msg)) return "You're out of playtime. Add more to keep calling.";
  if (/VOICE_RATE_LIMITED/.test(msg)) return "You've hit today's usage cap. It resets tomorrow.";
  if (/VOICE_NOT_CONFIGURED/.test(msg)) return 'Voice service is not available right now.';
  if (/permission/i.test(msg)) return 'Microphone access was blocked. Allow it and try again.';
  return 'Voice call failed to start. Try again in a moment.';
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  // Forward the shared mute/deafen toggles into the live pipeline.
  unsubUiMirror = useUiStore.subscribe((s, prev) => {
    if (s.callMuted !== prev.callMuted) {
      dictation?.setMuted(s.callMuted);
      if (get().participants.length) playMuteClick(s.callMuted);
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
      if (get().participants.length) playMuteClick(s.callDeafened);
    }
  });

  /** Solo companion hang-up: end once nothing is left to say. */
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
      const ui = useUiStore.getState();
      if (ui.view.kind === 'voice-call' && ui.view.characterId === characterId) {
        ui.navigate({ kind: 'chat', characterId });
      }
    }
  }

  /** A companion asked to hang up (end_call). Solo call → drain then end the
   * call; group call → drop just that companion once its goodbye has played. */
  function requestRemoteEnd(characterId: string): void {
    const s = get();
    if (!s.participants.includes(characterId)) return;
    if (s.participants.length > 1) {
      // Let the goodbye clip (already queued) play, then remove just this one.
      remoteEndTimers.push(
        window.setTimeout(() => get().removeParticipant(characterId), REMOTE_END_GRACE_MS + REMOTE_END_TAIL_MS),
      );
      return;
    }
    if (remoteEndAt !== null) return;
    remoteEndAt = Date.now();
    remoteEndTimers.push(window.setTimeout(maybeFinishRemoteEnd, REMOTE_END_GRACE_MS + 50));
    remoteEndTimers.push(window.setTimeout(maybeFinishRemoteEnd, REMOTE_END_MAX_WAIT_MS + 50));
  }

  /** Synthesize + display one companion line on the LIVE call, tagged with the
   * speaker so the queue can report per-companion speaking state. */
  function speakCompanionLine(characterId: string, text: string): void {
    const mySession = session;
    if (replyClockAt !== null) {
      console.log(
        `[sei/voice] reply latency ${Math.round(performance.now() - replyClockAt)}ms ` +
          `(your utterance -> first spoken line). Excludes end-silence + Whisper before it.`,
      );
      replyClockAt = null;
    }
    set({ lastSpoken: text, lastSpokenId: characterId });
    pendingTts += 1;

    const surfaceTtsError = (msg: string): void => {
      if (session !== mySession) return;
      if (/VOICE_RATE_LIMITED/.test(msg)) {
        set({ lastSpoken: '[voice paused, daily usage cap reached]' });
      } else if (/VOICE_NO_CREDITS/.test(msg)) {
        set({ lastSpoken: '[voice paused, out of playtime]' });
      }
    };
    const settleTts = (): void => {
      pendingTts = Math.max(0, pendingTts - 1);
      maybeFinishRemoteEnd();
    };

    const canStream =
      typeof sei.voiceTtsStream === 'function' && typeof sei.onVoiceTtsChunk === 'function';
    if (canStream && queue) {
      const handle = queue.enqueueStream(characterId);
      void sei
        .voiceTtsStream({ characterId, text })
        .then(({ streamId }) => {
          if (session !== mySession) {
            handle.fail();
            settleTts();
            return;
          }
          ttsStreams.set(streamId, handle);
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
        if (session === mySession) queue?.enqueue(buf, characterId);
      })
      .catch((err) => surfaceTtsError(String((err as Error)?.message ?? '')))
      .finally(settleTts);
  }

  /** Flush the lines buffered during the first 'connecting' window. */
  function flushPendingCompanionLines(): void {
    if (pendingCompanionLines.length === 0) return;
    const lines = pendingCompanionLines;
    pendingCompanionLines = [];
    for (const line of lines) {
      if (get().participants.includes(line.characterId)) speakCompanionLine(line.characterId, line.text);
    }
  }

  // ── Turn-taking director ───────────────────────────────────────────────────

  /** Run one companion's turn and (bounded) let another react to it. `incoming`
   * is either the player's utterance or the previous companion's spoken line. */
  async function runCompanionTurn(
    mySeq: number,
    speakerId: string,
    incoming: { from: 'player'; text: string } | { from: 'companion'; fromName: string; text: string },
    depth: number,
  ): Promise<void> {
    if (mySeq !== directorSeq) return;
    const parts = get().participants;
    if (!parts.includes(speakerId)) return;
    const peers = parts.filter((id) => id !== speakerId).map(nameOf);

    let lines: string[] = [];
    try {
      if (incoming.from === 'player') {
        // Same pipeline as typed chat: persists, routes to a live game session if
        // in-world, and speaks each reply via the onCompanionText hook.
        const res = await useChatStore.getState().send(speakerId, incoming.text, undefined, peers);
        lines = (res?.replies ?? []).map((r) => r.text).filter(Boolean);
      } else {
        // Cross-companion reaction: a direct invoke that returns the lines (no
        // push), so the director speaks them here — but only if still current.
        const replies = await sei
          .voiceCompanionTurn?.({ characterId: speakerId, speakerName: incoming.fromName, text: incoming.text, peers })
          .catch(() => [] as { text: string }[]);
        lines = (replies ?? []).map((r) => r.text).filter(Boolean);
        if (mySeq !== directorSeq) return; // barged over while generating
        // Don't let a companion who was dropped mid-generation (end_call, or the
        // user removed them) still speak a queued reaction into the room — that
        // was the "Sui kept talking in the background after she left" bug.
        if (!get().participants.includes(speakerId)) return;
        if (get().status === 'live') for (const l of lines) speakCompanionLine(speakerId, l);
      }
    } catch {
      lines = [];
    }
    if (mySeq !== directorSeq) return;
    if (lines.length === 0) return; // nothing said → nothing to react to

    // Chain: PFC steer decides whether ANOTHER companion reacts (probabilistic +
    // capped), so an exchange sometimes stops after one line and sometimes
    // banters on for a few turns — not always both, not forever.
    const decision = decideReaction({
      speakerId,
      participants: asParticipants(parts),
      depth,
      lastReactorId,
      // The line just spoken — if it names a peer, that peer is forced to answer.
      text: lines[lines.length - 1],
    });
    const reactorId = decision?.reactorId ?? null;

    // Everyone on the call HEARS everything: mirror this turn's lines into every
    // other companion's transcript so a bystander stays in context. The reactor
    // is excluded — it receives the line as its own turn trigger (voiceCompanionTurn
    // persists it), so mirroring there too would double it.
    const speakerName = nameOf(speakerId);
    for (const id of parts) {
      if (id === speakerId || id === reactorId) continue;
      for (const l of lines) {
        void sei.voiceObserve?.({ characterId: id, from: speakerName, text: l }).catch(() => {});
      }
    }

    if (!decision) return;
    lastReactorId = decision.reactorId;
    const lastLine = lines[lines.length - 1];
    await wait(depth === 0 ? CHAIN_GAP_FIRST_MS : CHAIN_GAP_NEXT_MS);
    if (mySeq !== directorSeq) return;
    void runCompanionTurn(mySeq, decision.reactorId, { from: 'companion', fromName: speakerName, text: lastLine }, depth + 1);
  }

  /** A player utterance arrived (from the mic). Barge-in already cleared the
   * audio queue; here we supersede any running chain, mirror the line to the
   * non-responders for context, and kick off the responder's turn. */
  function dispatchUserTurn(text: string): void {
    const parts = get().participants;
    if (!parts.length || get().status !== 'live') return;
    // Reject Whisper hallucinations (echo/breath/silence → "hhhhh", "you",
    // "[BLANK_AUDIO]") before they become a turn: otherwise they inject lines
    // the player never said and, via supersede, delay the real reply.
    if (isJunkTranscript(text)) return;
    replyClockAt = performance.now(); // start the reply-latency clock (see speakCompanionLine)
    const mySeq = ++directorSeq; // cancels any in-flight companion chain
    lastReactorId = null; // fresh utterance: reset the chain's spread memory
    set({ lastHeard: text });
    if (parts.length === 1) {
      lastResponderId = parts[0];
      void runCompanionTurn(mySeq, parts[0], { from: 'player', text }, 0);
      return;
    }
    const pick = pickResponder(text, asParticipants(parts), lastResponderId);
    lastResponderId = pick.id;
    const responder = pick.id;
    // The responder hears the line through send(); mirror it into every other
    // companion's transcript so they have the player's words for their own turn.
    for (const id of parts) {
      if (id !== responder) void sei.voiceObserve?.({ characterId: id, from: 'player', text }).catch(() => {});
    }
    void runCompanionTurn(mySeq, responder, { from: 'player', text }, 0);
  }

  // Chat → voice seam: companion text lands here from BOTH reply paths (send()
  // result + chat:message push), and companion hang-ups from BOTH end_call paths.
  registerVoiceHooks({
    isCallActive: (characterId) => get().participants.includes(characterId),
    onRemoteEndCall: requestRemoteEnd,
    onCompanionText: (characterId, text) => {
      const s = get();
      if (!s.participants.includes(characterId)) return;
      // Lines can arrive before the (first) line opens: buffer and flush on live.
      if (s.status === 'connecting') {
        if (pendingCompanionLines.length < MAX_PENDING_COMPANION_LINES) {
          pendingCompanionLines.push({ characterId, text });
        }
        return;
      }
      if (s.status !== 'live') return;
      speakCompanionLine(characterId, text);
    },
  });

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
    offTtsChunk = sei.onVoiceTtsChunk?.((push) => {
      if (!ttsStreams.has(push.streamId)) {
        if (ttsOrphans.size > 32) ttsOrphans.clear();
        const list = ttsOrphans.get(push.streamId) ?? [];
        list.push(push);
        ttsOrphans.set(push.streamId, list);
        return;
      }
      applyTtsPush(push.streamId, push);
    }) ?? null;
  } catch {
    /* preload without streaming — buffered path covers it */
  }

  try {
    offCallEnded =
      sei.onVoiceCallEnded?.(({ characterId }) => requestRemoteEnd(characterId)) ?? null;
  } catch {
    /* preload without onVoiceCallEnded — companion hang-ups just won't land */
  }

  return {
    participants: [],
    callCharacterId: null,
    status: 'idle',
    speaking: false,
    speakingId: null,
    userSpeaking: false,
    lastHeard: '',
    lastSpoken: '',
    lastSpokenId: null,
    error: null,
    connectingDetail: null,
    liveAt: null,

    startCall: async (characterId) => {
      const prev = get();
      if (prev.participants.includes(characterId) && prev.status !== 'error') return;
      // A call is already open (or dialing) — add to it rather than restart.
      if (prev.participants.length > 0 && prev.status !== 'error') {
        get().addParticipant(characterId);
        return;
      }

      const mySession = ++session;
      directorSeq++; // fresh call: invalidate any stale chain token
      lastResponderId = null;
      lastReactorId = null;
      const dialStart = Date.now();
      liveSince.clear();
      pendingTts = 0;
      pendingCompanionLines = [];
      remoteEndAt = null;
      remoteDrainedAt = null;
      ttsStreams.clear();
      ttsOrphans.clear();
      set({
        participants: [characterId],
        callCharacterId: characterId,
        status: 'connecting',
        speaking: false,
        speakingId: null,
        userSpeaking: false,
        lastHeard: '',
        lastSpoken: '',
        lastSpokenId: null,
        error: null,
        connectingDetail: null,
        liveAt: null,
      });

      silenceDressing();
      stopRing = startRingtone();

      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});

      // Ask main to have the companion greet FIRST — fired NOW, before the local
      // Whisper model boots (the await below), so the greeting's Haiku + TTS
      // round-trip overlaps model load instead of starting after it. That model
      // bootup is the single largest unavoidable delay; running the greeting in
      // parallel with it is what lets the first word land right as we connect.
      // The reply arrives via onCompanionText while status is still 'connecting'
      // and is buffered into pendingCompanionLines, then spoken once we go live.
      void sei.voiceGreet?.(characterId)?.catch(() => {});

      queue = createAudioQueue((speaking, cid) => {
        if (session !== mySession) return;
        set({ speaking, speakingId: speaking ? cid : null });
        dictation?.setHold(speaking);
        if (!speaking) maybeFinishRemoteEnd();
      });
      queue.setOutputMuted(useUiStore.getState().callDeafened);

      try {
        dictation = await createDictation({
          onStatus: (status, detail) => {
            if (session !== mySession) return;
            set({ connectingDetail: status === 'loading-model' && detail ? detail : null });
          },
          onUtterance: (text) => {
            if (session !== mySession) return;
            const s = get();
            if (s.status !== 'live' || !s.participants.length) return;
            // The director handles addressing, mirroring, and the reply chain.
            dispatchUserTurn(text);
          },
          onBargeIn: () => {
            // The player spoke over the companions: cut playback + drop the queue.
            // dispatchUserTurn (fired by the following onUtterance) bumps the
            // director sequence, cancelling any pending companion chain too.
            if (session !== mySession) return;
            queue?.clear();
          },
          onSpeechActive: (active) => {
            // Light the caller's own avatar ring while they talk (same ring the
            // companions get). Muted → never lit, even if a frame leaks through.
            if (session !== mySession) return;
            set({ userSpeaking: active && !useUiStore.getState().callMuted });
          },
        });
      } catch (err) {
        if (session !== mySession) return;
        queue?.stop();
        queue = null;
        silenceDressing();
        void sei.voiceCallSetActive({ characterId, active: false }).catch(() => {});
        set({
          participants: [],
          callCharacterId: null,
          status: 'error',
          error: friendlyError(err),
          connectingDetail: null,
        });
        return;
      }

      if (session !== mySession) {
        dictation.stop();
        dictation = null;
        return;
      }
      dictation.setMuted(useUiStore.getState().callMuted);

      // Stay OUTGOING (ringing, no stopwatch) until the min ring has elapsed AND
      // the companion's first line is buffered and ready to play — so "connected"
      // never starts on dead air (tasks 2/3). The greeting was fired at dial time
      // and generates during model bootup, so it is usually already waiting here;
      // the cap only bites if it is slow or produced nothing, and connects anyway.
      const ringLeft = MIN_RING_MS - (Date.now() - dialStart);
      if (ringLeft > 0) {
        await wait(ringLeft);
        if (session !== mySession) return;
      }
      const greetDeadline = Date.now() + GREETING_READY_CAP_MS;
      while (pendingCompanionLines.length === 0 && Date.now() < greetDeadline) {
        await wait(80);
        if (session !== mySession) return;
      }

      // Connected: the stopwatch starts HERE, the moment we are actually ready.
      const now = Date.now();
      liveSince.set(characterId, now);
      silenceDressing();
      if (!useUiStore.getState().callDeafened) {
        playConnectedChime();
        stopAmbience = startAmbience();
      }
      set({ status: 'live', connectingDetail: null, liveAt: now });

      // A one-second beat after "connected" before the companion speaks — a real
      // pickup pause, and a head start for the greeting's TTS first byte.
      await wait(CONNECT_SPEAK_DELAY_MS);
      if (session !== mySession) return;
      flushPendingCompanionLines();
    },

    addParticipant: (characterId) => {
      const s = get();
      if (s.participants.includes(characterId)) return;
      if (s.participants.length === 0) {
        void get().startCall(characterId);
        return;
      }
      const peerNames = s.participants.map(nameOf); // names already on the call
      const joinerName = nameOf(characterId);
      set({ participants: [...s.participants, characterId] });
      liveSince.set(characterId, Date.now());
      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});
      // Tell the companions already on the call that someone joined, so they know
      // it is now a bigger room and act accordingly (their next turn's voicePeers
      // will include the newcomer, but this lands the fact in their transcript now).
      for (const id of s.participants) {
        void sei.voiceObserve?.({ characterId: id, from: joinerName, text: 'just joined the call.' }).catch(() => {});
      }
      // Greet the room (once the line is actually live). A companion added while
      // still dialing simply joins; the primary's greeting covers the opening.
      if (s.status === 'live') void sei.voiceGreet?.(characterId, peerNames)?.catch(() => {});
    },

    removeParticipant: (characterId) => {
      const s = get();
      if (!s.participants.includes(characterId)) return;
      const next = s.participants.filter((id) => id !== characterId);
      // A membership change is a barge point: cancel any in-flight companion chain
      // so the departing companion's queued reaction can't still fire (the
      // "she left but kept talking in the background" bug), and so a chain that
      // was about to hand the floor to the now-absent companion stops cleanly.
      directorSeq++;
      if (lastReactorId === characterId) lastReactorId = null;
      if (lastResponderId === characterId) lastResponderId = null;
      const since = liveSince.get(characterId);
      liveSince.delete(characterId);
      void sei
        .voiceCallSetActive({
          characterId,
          active: false,
          ...(since !== undefined ? { connectedMs: Date.now() - since } : {}),
        })
        .catch(() => {});
      if (next.length === 0) {
        get().endCall();
        return;
      }
      set({
        participants: next,
        callCharacterId: next[0],
        ...(get().speakingId === characterId ? { speaking: false, speakingId: null } : {}),
      });
    },

    endCall: () => {
      const { participants } = get();
      session += 1;
      directorSeq++; // cancel any running companion chain
      lastResponderId = null;
      lastReactorId = null;
      pendingTts = 0;
      pendingCompanionLines = [];
      remoteEndAt = null;
      remoteDrainedAt = null;
      for (const t of remoteEndTimers) window.clearTimeout(t);
      remoteEndTimers = [];
      silenceDressing();
      if (participants.length) playHangupChime();
      ttsStreams.clear();
      ttsOrphans.clear();
      dictation?.stop();
      dictation = null;
      queue?.stop();
      queue = null;
      const now = Date.now();
      for (const id of participants) {
        const since = liveSince.get(id);
        void sei
          .voiceCallSetActive({
            characterId: id,
            active: false,
            ...(since !== undefined ? { connectedMs: now - since } : {}),
          })
          .catch(() => {});
      }
      liveSince.clear();
      set({
        participants: [],
        callCharacterId: null,
        status: 'idle',
        speaking: false,
        speakingId: null,
        userSpeaking: false,
        lastHeard: '',
        lastSpoken: '',
        lastSpokenId: null,
        error: null,
        connectingDetail: null,
        liveAt: null,
      });
      useUiStore.getState().endCall();
    },
  };
});

// Dev-only (Vite HMR): let the STALE instance release the world before the
// fresh module re-registers everything (see the single-call notes).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try {
      useVoiceStore.getState().endCall();
    } catch {
      /* dispose must never block the reload */
    }
    unsubUiMirror?.();
    offTtsChunk?.();
    offCallEnded?.();
  });
}
