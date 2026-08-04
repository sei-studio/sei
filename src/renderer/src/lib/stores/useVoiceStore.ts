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
 *   - a player utterance is broadcast to EVERY participant (260708): each gets a
 *     real turn and decides for itself whether the line is its to answer (the
 *     group-call prompt sanctions "(silence)"), so nobody is left with a
 *     transcript row and no voice — the old single-responder pick starved the
 *     others of launch() and had the picked one fabricating their lines;
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
 * Mute/deafen live in useUiStore (shared with the CallMiniBar); we
 * subscribe and forward them. Half-duplex: while companion audio is audible the
 * mic is held, so the companions never hear themselves.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';
import { useChatStore } from './useChatStore';
import { useDataStore } from './useDataStore';
// 260804: the director has to know whether the companion it is about to give a
// turn to is already running one with the screen attached. One-way — the
// backseat store knows nothing about calls.
import { useBackseatStore, backseatCapture } from './useBackseatStore';
import { voicePitchRate } from '@shared/voicePitch';
import { createAudioQueue, type AudioQueue, type TtsStreamHandle } from '../voice/audioQueue';
import { t } from '../i18n';
import { createDictation, type Dictation } from '../voice/dictation';
import { sttPolicy } from '../voice/sttPolicy';
import { prefetchVoiceModel } from '../voice/modelPrefetch';
import { registerVoiceHooks } from '../voice/voiceBridge';
import { decideReaction, isJunkTranscript, type Participant } from '../voice/pfcSteer';
import type { SpokenLineContext } from '../voice/voiceBridge';
import {
  startRingtone,
  startAmbience,
  playConnectedChime,
  playHangupChime,
  playMuteClick,
  type StopFn,
} from '../voice/callTones';
import { warm as warmPitchBus } from '../voice/pitchBus';

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
   * single character (VoiceCallScreen dial guard, CallMiniBar). null = no call. */
  callCharacterId: string | null;
  status: CallStatus;
  /** Any companion audio currently playing (drives the minimized "on call" pulse). */
  speaking: boolean;
  /**
   * WHICH companion is speaking right now (null when silent). Per-companion
   * speaking state for the call UIs: a pfp is lit when its id === speakingId.
   *
   * Set from the first AUDIBLE sample of a clip, not from the moment it reaches
   * the audio queue's playhead (260730). For a streamed clip the playhead comes
   * first by an entire TTS round trip, so every ring, caption and talking
   * animation in the app used to start before the voice did.
   */
  speakingId: string | null;
  /** True while the player's own mic has live speech — lights the SAME ring on
   * the caller's avatar that companions get while speaking. */
  userSpeaking: boolean;
  /** 260725: true while a failed voice turn is being retried (LLM/proxy
   * hiccup). The call screen swaps the duration subtitle for "Reconnecting…"
   * so a retry window reads as a connection blip, not a frozen companion. */
  reconnecting: boolean;
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
  /** 260725: cloud STT failed on a model-less ('none' policy) call, so an
   * utterance was dropped with nothing to fall back on. The call screen shows
   * a non-blocking prompt offering the local backup-model install. Edge-fired
   * once per call by dictation; dismissing hides it for the rest of the call. */
  sttFallbackPrompt: boolean;
  /**
   * 260730 — hold the companion's first line while a call scene plays its
   * intro. The scene raises this on mount and drops it when the character has
   * finished walking on, so she starts talking where she stopped rather than
   * from off-screen.
   *
   * It reuses the buffer the 'connecting' window already fills, so nothing new
   * races it: lines keep arriving and keep queueing, the flush just happens
   * later. Held lines are never lost, and `setIntroHold(true)` arms a cap so a
   * scene that somehow never reports arrival cannot mute the call.
   */
  introHold: boolean;

  /** Dial the first companion, OR add another to a call already open. */
  startCall: (characterId: string) => Promise<void>;
  /** Add a companion to the live call (no-op if already on it). */
  addParticipant: (characterId: string) => void;
  /** Drop one companion from the call (ends the whole call if it was the last). */
  removeParticipant: (characterId: string) => void;
  /** Hang up the whole call. */
  endCall: () => void;
  /** Accept the local-backup offer: persists stt_local_fallback = true and
   * starts the model download now; the fallback applies from the NEXT call. */
  acceptSttFallback: () => Promise<void>;
  /** Dismiss the local-backup offer for the rest of this call. */
  dismissSttFallback: () => void;
  /** 260730: hold (or release) the companion's first line for a scene intro. */
  setIntroHold: (hold: boolean) => void;
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
/** Companion lines that arrived while the (first) call was still 'connecting'.
 * `seq` is the line's ORIGIN sequence resolved at buffer time (see
 * speakerOriginSeq), threaded through the flush into speakAndCapture. */
let pendingCompanionLines: Array<{ characterId: string; text: string; seq: number; ctx: SpokenLineContext }> = [];
const MAX_PENDING_COMPANION_LINES = 12;
/** Auto-release for a scene intro hold that never reports arrival. */
let introHoldTimer = 0;
/** 260725 turn-failure retry: while runCompanionTurnInner has a player send in
 * flight for a speaker, this maps speakerId → its director sequence. The chat
 * store's real-failure path asks (via the voiceBridge onTurnFailed hook)
 * whether the director owns the failure; ownership = an entry here that is
 * still current. Typed-composer sends are never in this map, so they keep the
 * chat surface's apology bubble. */
const directorSendSeq = new Map<string, number>();
/** Speakers whose in-flight director send just failed (consumed by the retry
 * loop right after send() settles). */
const directorSendFailed = new Set<string>();
/** Backoff schedule for retrying a failed voice turn. Bounded: after the last
 * attempt the line clears and the turn stays silent — the player's next
 * utterance starts a fresh turn anyway. */
const TURN_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
/** How many retry waits are showing "Reconnecting…" right now (a group
 * broadcast can have several). State flag = count > 0. */
let reconnectingCount = 0;
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
let offCreditsHardStop: (() => void) | null = null;

// ── PFC steer: turn-taking director state ────────────────────────────────────
// The decision policy (who speaks, whether to chain, junk rejection) lives in
// ../voice/pfcSteer; this is the mutable session state the director threads
// through it. Search "pfc steer" to find the whole seam.
/** Bumped by every player utterance and by teardown; a running companion chain
 * that finds its captured value stale aborts (barge-in / supersede). */
let directorSeq = 0;
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

// ── Idle conversation starter (260707) ───────────────────────────────────────
// The call's equivalent of the in-game idle tick: when the line has been quiet
// for a randomly sampled 5-60s stretch (measured from the moment the last clip
// finished playing / the last activity settled), one companion gets a nudge to
// start a topic — or to stay quiet via silence(). Gated on the "Conversation
// starters" settings toggle (useUiStore.convoStartersEnabled, default ON).
// A 1s tick (chained setTimeout, session-guarded) evaluates a busy predicate;
// while ANYTHING is happening — audio playing, TTS in flight, the player
// mid-utterance, a reply being captured, a reaction generating, a nudge already
// running — the quiet clock keeps resetting, so the timer can only expire on a
// genuinely dead line. The nudge NEVER preempts real work: main additionally
// skips it if a turn is in flight for the character, and the reply is dropped
// if the player spoke while it generated (director sequence check).
const IDLE_NUDGE_MIN_MS = 5_000;
const IDLE_NUDGE_MAX_MS = 60_000;
const IDLE_TICK_MS = 1_000;
// 260730: an UNANSWERED QUESTION is not the same silence. When the companion's
// last spoken line ended in a question mark, the quiet that follows is the
// player not answering, and the ordinary 5-60s window leaves the question
// hanging long past the point a person would have followed up. That case gets
// its own much tighter window and its own note in main (see sendVoiceIdleTurn):
// one gentle, unpressured follow-up.
const QUESTION_NUDGE_MIN_MS = 5_000;
const QUESTION_NUDGE_MAX_MS = 15_000;
/** The last line spoken on the call ended in a question mark. */
let idleAwaitingAnswer = false;
/** A follow-up already went out for that question. One is a nudge; a second one
 * on the same unanswered question is nagging, so the normal window (and its
 * backoff) takes over until the player says something. */
let idleQuestionNudged = false;
/** True when the next nudge should be the gentle follow-up to a question. */
function idleQuestionMode(): boolean {
  return idleAwaitingAnswer && !idleQuestionNudged && idleQuietStreak === 0;
}
/** Ends in '?' (or the full-width '？'), ignoring trailing quotes/space. */
function endsWithQuestion(line: string): boolean {
  return /[?？]["'”’)\]\s]*$/.test(line.trim());
}
/** When the conversation last was busy — the quiet stretch is measured from here. */
let idleQuietSince = 0;
/** The current sampled quiet threshold; resampled for every new quiet stretch. */
let idleTargetMs = IDLE_NUDGE_MAX_MS;
/** True while a nudge turn is in flight (counts as busy — never stack nudges). */
let idleNudgeInFlight = false;
/** Companion reaction turns currently generating (no turn capture is armed for
 * these, so the busy predicate needs its own signal). */
let companionTurnsInFlight = 0;
/** Consecutive nudges that produced no spoken line (chose silence, were
 * skipped, or FAILED — e.g. the network is down). Each one doubles the next
 * quiet threshold (capped 8x, so 40s-8min), so an unattended silent call tapers
 * off instead of firing an LLM turn every ~30s forever. Any real conversation
 * activity resets it. */
let idleQuietStreak = 0;
const IDLE_BACKOFF_CAP = 8;
// 260725: proactiveness is a runtime-only Minecraft mode now (never read from
// character metadata), so every call runs the one laid-back nudge window.
function sampleIdleTarget(): number {
  // The tight window applies only to the FIRST nudge after the question
  // (streak 0). If that follow-up also goes unanswered, the normal window and
  // its backoff take over — asking again every 10 seconds is the pressuring
  // behavior this is meant to avoid, not the point of it.
  if (idleQuestionMode()) {
    return QUESTION_NUDGE_MIN_MS + Math.random() * (QUESTION_NUDGE_MAX_MS - QUESTION_NUDGE_MIN_MS);
  }
  return IDLE_NUDGE_MIN_MS + Math.random() * (IDLE_NUDGE_MAX_MS - IDLE_NUDGE_MIN_MS);
}

/** Spoken-turn capture. A companion's spoken lines almost always arrive ASYNC
 * through onCompanionText — streamed reply sentences land while send() is still
 * in flight, an in-world routed reply streams back over the chat push, a join
 * greeting or a typed-message reply arrives with no director turn running at
 * all — so the director can never see a turn's lines inline to drive the banter
 * chain. Instead, whoever holds the floor gets a capture: the lines are
 * collected as they arrive, and a short quiet window then finalizes the turn
 * (mirror to peers + hand the floor to a reactor, see chainFromLines). Only ONE
 * is ever pending — deeper reaction turns use the synchronous voiceCompanionTurn
 * path, which returns its lines directly. */
let turnCapture:
  | { seq: number; speakerId: string; depth: number; lines: string[]; timer: number }
  | null = null;
/** Quiet gap after the last captured line before the reaction fires — long
 * enough that a multi-line reply lands as one turn, short enough to keep banter
 * tight. Only starts once the FIRST line has arrived (a reply's own generation
 * latency is seconds, far longer than this). */
const CAPTURE_QUIET_MS = 900;
/** How long to wait for a captured turn to START producing lines before giving
 * up on the chain. Covers the in-game bot's generation latency (~chat timeout);
 * if nothing lands by then the turn produced nothing, so the chain just rests
 * (finalizing with no lines is a harmless no-op). */
const CAPTURE_FIRST_LINE_MS = 22_000;
/** Once a NOT-in-game responder's send() has fully resolved with no spoken
 * line, its empty capture is released after this short grace instead of the
 * full first-line window (see the silent-turn release in runCompanionTurnInner). */
const CAPTURE_SILENT_RELEASE_MS = 1200;
function clearTurnCapture(): void {
  if (!turnCapture) return;
  window.clearTimeout(turnCapture.timer);
  turnCapture = null;
}

/** ORIGIN sequence of each speaker's latest renderer-dispatched generation: the
 * directorSeq current when it was kicked off (recorded by armTurnCapture and
 * the voiceGreet dispatches). Spoken lines land ASYNC through onCompanionText,
 * so this is how a line is dated to its turn: origin !== directorSeq means a
 * barge-in superseded the turn while it generated — the line is still spoken
 * and mirrored, but may never arm or feed a capture (arming at the LIVE seq
 * would pass the seq guard trivially and revive the chain the player just
 * killed). No entry = a generation the renderer never dispatched (an in-world
 * say() routed up): treated as current. The record is released when the turn's
 * capture finalizes, so a later spontaneous line opens a fresh turn again;
 * entries left stale by a barge are overwritten by the speaker's next dispatch. */
const speakerOriginSeq = new Map<string, number>();

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

/** Pitch shift for a companion's TTS clips, as a frequency multiplier (1 = as
 * recorded). Applied locally at playback and pace-preserving, so synthesis is
 * asked for nothing (see shared/voicePitch.ts, lib/voice/pitchBus.ts). */
function pitchRateOf(characterId: string): number {
  const character = useDataStore.getState().characters.find((c) => c.id === characterId);
  return voicePitchRate(character ?? { id: characterId, metadata: {} });
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
/** How long the ring will wait for the mic before starting anyway (260730 — see
 * ringNow in startCall). Normally getUserMedia resolves in well under this; the
 * wait only bites on a first-run permission prompt or a busy device, where a
 * silent dial would read as a broken call button. */
const RING_WITHOUT_MIC_MS = 600;
// 260706 (tasks 2/3): the call stays OUTGOING (ringing, no stopwatch) until the
// companion's first line is actually ready — "connected" should never begin on
// dead air. We poll for the buffered greeting up to this cap, then connect
// anyway so a slow/empty greeting can't hang the dial forever.
const GREETING_READY_CAP_MS = 5000;
// Once connected, hold a beat before the first word — a real "pickup" pause, and
// it gives the greeting's TTS first-byte a moment to land.
const CONNECT_SPEAK_DELAY_MS = 1000;
/**
 * 260730: hard cap on a call scene's intro hold. The scene backs its arrival
 * callback with its own timer, and this backs THAT: a bug in scene data (a
 * walk that never ends) must degrade to a slightly late greeting, never to a
 * companion who picks up and says nothing.
 */
const INTRO_HOLD_CAP_MS = 8000;
/**
 * Shortest line that still goes down the STREAMING TTS path (see
 * speakCompanionLine). Below this the clip is fetched whole and played from one
 * Blob, which cannot underrun. 24 chars is roughly a second of speech at these
 * voices: long enough that streaming's head start is worth having, short enough
 * that the one-word answers and interjections that were coming out choppy
 * ("you", "are you", "yeah lol") take the safe path. Raise it if choppiness
 * shows up on longer lines; each raise trades a little first-word latency on
 * those lines for buffer safety.
 */
const STREAM_MIN_CHARS = 24;

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  // getUserMedia failures arrive as DOMExceptions whose `message` is often
  // empty — the `name` is the reliable signal (NotAllowedError / NotFoundError).
  const name = (err as { name?: string })?.name ?? '';
  if (/VOICE_NO_SESSION/.test(msg)) return t('Sign in to use voice calls.');
  if (/VOICE_NO_CREDITS/.test(msg)) return t("You've used this week's credits. Upgrade or top up to keep calling.");
  if (/VOICE_RATE_LIMITED/.test(msg)) return t("You've hit today's usage cap. It resets tomorrow.");
  if (/VOICE_NOT_CONFIGURED/.test(msg)) return t('Voice service is not available right now.');
  // BYOK (260726): the curated pool lives in Sei's ElevenLabs account, so the
  // user's own key cannot speak that voice until they add it to their library.
  if (/VOICE_NOT_IN_LIBRARY/.test(msg)) {
    return t('This voice is not in your ElevenLabs library. Add it there, or pick a different voice.');
  }
  if (name === 'NotFoundError' || /device not found/i.test(msg)) {
    return t('No microphone was found. Connect one and try again.');
  }
  if (name === 'NotAllowedError' || /permission/i.test(msg)) {
    // Windows has no per-app prompt for desktop apps: access is silently
    // blocked by the OS privacy toggle, so name the exact switch (260709).
    return sei.platform === 'win32'
      ? t('Microphone access is blocked by Windows. In Settings, open Privacy & security > Microphone, turn on microphone access and "Let desktop apps access your microphone", then try again.')
      : t('Microphone access was blocked. Allow it and try again.');
  }
  return t('Voice call failed to start. Try again in a moment.');
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
   * speaker so the queue can report per-companion speaking state. `ctx` places
   * the line inside its own reply (previous sibling / whether one follows),
   * which is what main conditions the clip's opening and closing contour on
   * (see ttsContextFor). */
  function speakCompanionLine(characterId: string, text: string, ctx: SpokenLineContext = {}): void {
    const mySession = session;
    if (replyClockAt !== null) {
      console.log(
        `[sei/voice] reply latency ${Math.round(performance.now() - replyClockAt)}ms ` +
          `(your utterance -> first spoken line). Excludes end-silence + Whisper before it.`,
      );
      replyClockAt = null;
    }
    // Caption is set when this clip reaches the playhead (see the audio queue's
    // onSpeakingChange below), NOT here at enqueue time — otherwise a multi-line
    // reply (or two companions' queued lines) would jump the caption straight to
    // the LAST enqueued line while earlier lines are still being spoken. Threading
    // the text through the queue makes the caption flow in step with the audio.
    pendingTts += 1;

    const surfaceTtsError = (msg: string): void => {
      if (session !== mySession) return;
      if (/VOICE_RATE_LIMITED/.test(msg)) {
        set({ lastSpoken: '[voice paused, daily usage cap reached]' });
      } else if (/VOICE_NO_CREDITS/.test(msg)) {
        set({ lastSpoken: '[voice paused, out of credits]' });
      } else if (/VOICE_NOT_IN_LIBRARY/.test(msg)) {
        // BYOK key + a curated-pool voice: every clip fails until they add the
        // voice to their own ElevenLabs library or pick another one (260726).
        set({ lastSpoken: '[voice unavailable, this voice is not in your ElevenLabs library]' });
      }
    };
    const settleTts = (): void => {
      pendingTts = Math.max(0, pendingTts - 1);
      maybeFinishRemoteEnd();
    };

    const canStream =
      typeof sei.voiceTtsStream === 'function' && typeof sei.onVoiceTtsChunk === 'function';
    // 260726: a TINY line does not stream. Streaming exists to cut time-to-
    // first-audio on a long clip, and its cost is that playback starts on a
    // buffer that is still filling. On a clip of a few hundred ms there is
    // never a lead to absorb a network hiccup, and the underruns land at the
    // only two places available — the first frames and the last ones before
    // endOfStream. Symptom: "are you" and "you" came out choppy at both ends
    // while full sentences were clean. Under the threshold the whole clip is
    // fetched, then played from one Blob with its silence padding already baked
    // in: no MSE, no underrun, and the latency given up is only the tail of an
    // already-short synthesis.
    //
    // 260731: what made this ACUTE was pitched playback — every pitched
    // character ran playbackRate > 1 (Sui: 1.224) with preservesPitch off, so
    // the renderer drained the buffer faster than the network filled it. The
    // shift is local and pace-preserving now (pitchBus.ts), so clips play at
    // rate 1 and the drain is back to real time. The threshold stays: a short
    // clip has no lead to spare either way, and the latency it trades is small.
    const worthStreaming = text.length >= STREAM_MIN_CHARS;
    if (canStream && worthStreaming && queue) {
      const handle = queue.enqueueStream(characterId, text, pitchRateOf(characterId));
      void sei
        .voiceTtsStream({ characterId, text, ...ctx })
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

    // Reserve the slot NOW, fill it when the clip lands (260729). This path used
    // to enqueue on RESOLVE, which put the line's position in the reply at the
    // mercy of its synthesis time: a short line emitted first was heard after a
    // long one emitted later, because the long one streams and takes its slot
    // instantly. Live: "oh." / "so you're still tweaking me." played backwards,
    // and a five-line reply came out shuffled. `blob: true` keeps the safe
    // fetch-whole playback that STREAM_MIN_CHARS chose (see above); only the
    // bookkeeping moves.
    const slot = queue?.enqueueStream(characterId, text, pitchRateOf(characterId), { blob: true });
    void sei
      .voiceTts({ characterId, text, ...ctx })
      .then((buf) => {
        if (session !== mySession) {
          slot?.fail();
          return;
        }
        slot?.push(buf);
        slot?.end();
      })
      .catch((err) => {
        slot?.fail();
        surfaceTtsError(String((err as Error)?.message ?? ''));
      })
      .finally(settleTts);
  }

  /** Speak one companion line on the live call and run the director's capture
   * bookkeeping for it. `originSeq` is the directorSeq current when this line's
   * generation was dispatched (see speakerOriginSeq) — only a CURRENT-origin
   * line may arm or feed the capture; a late line from a superseded turn is
   * spoken and mirrored but must never revive the chain the barge-in killed.
   * A current line landing with NO capture armed is a spoken turn the director
   * didn't run — a join greeting, the reply to a typed message, an in-world
   * say() routed up mid-call — so on a group call, open a capture for it: the
   * rest of the room hears it (mirror) and gets a turn to react. Without this,
   * companions are deaf to every speech path except the mic one (the "Sui does
   * not respond to Lyra" report: Sui never heard Lyra's greeting OR her
   * typed-prompted reply). An armed capture for THIS speaker collects the line
   * and re-arms the quiet timer; the reaction fires once the speaker stops (see
   * armTurnCapture). Any spoken line that cannot own the capture — the floor is
   * another speaker's, or the turn was superseded — is mirrored to the peers
   * immediately: the room heard it, so its transcripts must too, it just takes
   * no floor and chains nothing. */
  function speakAndCapture(characterId: string, text: string, originSeq: number, ctx: SpokenLineContext): void {
    speakCompanionLine(characterId, text, ctx);
    const current = originSeq === directorSeq;
    // Floor-steal (260708): an armed capture whose speaker has produced NOTHING
    // yet is a pending floor, not a held one. A real spoken line from someone
    // ELSE takes it: without this, a responder that chose silence held the
    // floor for the full CAPTURE_FIRST_LINE_MS (22s), and any line landing in
    // that window — a join greeting, an in-world say() — was mirrored but never
    // chained, so the room audibly heard it and nobody reacted (Sui greeted the
    // call, Marv's empty reply-capture ate the chain, Marv "said nothing").
    // A capture that already has lines keeps the floor; the newcomer's line
    // stays a mirrored interjection as before.
    if (
      current &&
      turnCapture &&
      turnCapture.seq === directorSeq &&
      turnCapture.speakerId !== characterId &&
      turnCapture.lines.length === 0
    ) {
      clearTurnCapture();
    }
    if (current && !turnCapture && get().participants.length > 1) {
      armTurnCapture(directorSeq, characterId, 0);
    }
    if (current && turnCapture && turnCapture.seq === directorSeq && turnCapture.speakerId === characterId) {
      turnCapture.lines.push(text);
      window.clearTimeout(turnCapture.timer);
      turnCapture.timer = window.setTimeout(() => finalizeTurnCapture(), CAPTURE_QUIET_MS);
      return;
    }
    // Spoken but uncaptured (interjection over another speaker's floor, or a
    // superseded turn's straggler): mirror it now or the bystanders permanently
    // miss a line that was audibly said on the call.
    if (get().participants.length > 1) mirrorLinesToPeers(characterId, [text], null);
  }

  /** Flush the lines buffered during the first 'connecting' window. */
  function flushPendingCompanionLines(): void {
    if (pendingCompanionLines.length === 0) return;
    const lines = pendingCompanionLines;
    pendingCompanionLines = [];
    for (const line of lines) {
      if (get().participants.includes(line.characterId)) {
        speakAndCapture(line.characterId, line.text, line.seq, line.ctx);
      }
    }
  }

  // ── Turn-taking director ───────────────────────────────────────────────────

  /** Everyone on the call HEARS everything: mirror `speakerId`'s spoken lines
   * into every OTHER companion's transcript so bystanders keep context.
   * `excludeId` skips a companion that receives the lines through its own turn
   * trigger instead (the reactor — voiceCompanionTurn persists them; mirroring
   * there too would double them). null = no exclusion. */
  function mirrorLinesToPeers(speakerId: string, lines: string[], excludeId: string | null): void {
    const speakerName = nameOf(speakerId);
    for (const id of get().participants) {
      if (id === speakerId || id === excludeId) continue;
      for (const l of lines) {
        void sei.voiceObserve?.({ characterId: id, from: speakerName, text: l }).catch(() => {});
      }
    }
  }

  /** Given the lines `speakerId` just spoke at `depth`, mirror them to the other
   * companions for context and hand the floor to the next companion. Ends the
   * chain when the speaker said nothing (a natural lull) or the turn was
   * superseded. Shared by the synchronous paths and the in-world async capture. */
  async function chainFromLines(mySeq: number, speakerId: string, lines: string[], depth: number): Promise<void> {
    if (mySeq !== directorSeq) return;
    const parts = get().participants;
    if (!parts.includes(speakerId)) return;
    if (lines.length === 0) return; // natural lull — the exchange rests here

    // Who takes the floor next. No random stop: with two+ companions the banter
    // keeps going until one has nothing to add (its own turn returns no line),
    // and the player can cut in at any time (barge-in supersedes this chain).
    // 260708: in-game companions are excluded from the reactor pool. They hear
    // every mirrored line inside their game session (main routes voiceObserve
    // into the live session as record-only context, waking on a by-name
    // request) and drive their own reactions there; handing them a standalone
    // chat turn here as well double-drove them with a brain that has no world
    // state. All reactors in-game → the chain rests and the game brains carry
    // the conversation.
    const chainSummons = useDataStore.getState().summons;
    const reactorPool = parts.filter((id) => {
      if (id === speakerId) return true; // decideReaction excludes the speaker itself
      const k = chainSummons[id]?.kind;
      return k !== 'online' && k !== 'connecting';
    });
    const decision = decideReaction({
      speakerId,
      participants: asParticipants(reactorPool),
      depth,
      lastReactorId,
      // The line just spoken — if it names a peer, that peer is forced to answer.
      text: lines[lines.length - 1],
    });
    const reactorId = decision?.reactorId ?? null;

    // The reactor is excluded from the mirror — it receives the line as its own
    // turn trigger (voiceCompanionTurn persists it), so mirroring there too
    // would double it.
    mirrorLinesToPeers(speakerId, lines, reactorId);

    if (!decision) return;
    lastReactorId = decision.reactorId;
    const lastLine = lines[lines.length - 1];
    await wait(depth === 0 ? CHAIN_GAP_FIRST_MS : CHAIN_GAP_NEXT_MS);
    if (mySeq !== directorSeq) return;
    void runCompanionTurn(mySeq, decision.reactorId, { from: 'companion', fromName: nameOf(speakerId), text: lastLine }, depth + 1);
  }

  /** Arm the spoken-turn capture for `speakerId`: its lines stream in via
   * onCompanionText, which appends to it and re-arms the quiet timer; when the
   * speaker falls quiet the chain fires. If nothing arrives, the timer still
   * fires with no lines and chainFromLines([]) is a harmless no-op, so a stuck
   * turn can never wedge the director. */
  function armTurnCapture(seq: number, speakerId: string, depth: number): void {
    clearTurnCapture();
    // Date the dispatch: lines from this turn arrive later through
    // onCompanionText and resolve their origin here (see speakerOriginSeq).
    speakerOriginSeq.set(speakerId, seq);
    // Wait for the turn to START producing lines (generation latency). Once the
    // first line lands, onCompanionText switches this to the short quiet window.
    const timer = window.setTimeout(() => finalizeTurnCapture(), CAPTURE_FIRST_LINE_MS);
    turnCapture = { seq, speakerId, depth, lines: [], timer };
  }

  function finalizeTurnCapture(): void {
    const cap = turnCapture;
    turnCapture = null;
    if (!cap) return;
    // The turn is complete: release the speaker's dispatch-origin record so a
    // later spontaneous line (an in-world say()) opens a fresh turn again.
    if (speakerOriginSeq.get(cap.speakerId) === cap.seq) speakerOriginSeq.delete(cap.speakerId);
    void chainFromLines(cap.seq, cap.speakerId, cap.lines, cap.depth);
  }

  /** Run one companion's turn, then let the banter chain continue. `incoming` is
   * either the player's utterance or the previous companion's spoken line. */
  async function runCompanionTurn(
    mySeq: number,
    speakerId: string,
    incoming: { from: 'player'; text: string } | { from: 'companion'; fromName: string; text: string },
    depth: number,
    opts?: { capture?: boolean },
  ): Promise<void> {
    if (mySeq !== directorSeq) return;
    const parts = get().participants;
    if (!parts.includes(speakerId)) return;
    const peers = parts.filter((id) => id !== speakerId).map(nameOf);

    // Signal the idle-starter clock that a turn is generating (the reaction
    // path arms no capture, so this counter is its only busy signal).
    companionTurnsInFlight += 1;
    try {
      await runCompanionTurnInner(mySeq, speakerId, incoming, depth, peers, opts?.capture !== false);
    } finally {
      companionTurnsInFlight = Math.max(0, companionTurnsInFlight - 1);
    }
  }

  async function runCompanionTurnInner(
    mySeq: number,
    speakerId: string,
    incoming: { from: 'player'; text: string } | { from: 'companion'; fromName: string; text: string },
    depth: number,
    peers: string[],
    capture: boolean = true,
  ): Promise<void> {
    let lines: string[] = [];
    try {
      if (incoming.from === 'player') {
        // Same pipeline as typed chat: persists, routes to a live game session if
        // in-world, and speaks each reply via the onCompanionText hook. The
        // capture is armed BEFORE the send because every reply path delivers its
        // spoken lines through onCompanionText while (or long after) send() is
        // in flight — streamed sentences, the blocking reveal loop, an in-world
        // routed reply — and the chain fires from the capture once the responder
        // falls quiet. Chaining from send()'s returned replies instead would
        // race the stream and double-drive the chain. (260708: a multi-bot
        // in-game broadcast passes capture=false — the single capture slot
        // cannot track parallel responders, and replies still speak + mirror
        // through onCompanionText → speakAndCapture.)
        if (capture) armTurnCapture(mySeq, speakerId, depth);
        // 260725 turn-failure retry: a real send() failure on a call used to
        // be pure dead air — the chat store's apology bubble is never spoken,
        // so the companion just froze (the "Marv froze after okay bye" class
        // of report, when the cause IS a failed LLM call). The chat store now
        // hands call-time failures back here (voiceBridge onTurnFailed); we
        // retry the same utterance on a short backoff while the call subtitle
        // shows "Reconnecting…". A new utterance (directorSeq bump), a
        // hang-up, or exhausting the schedule ends the loop; the retried
        // send's replies stream through onCompanionText like any other turn.
        let holdsReconnectSlot = false;
        try {
          for (let attempt = 0; ; attempt += 1) {
            directorSendFailed.delete(speakerId);
            directorSendSeq.set(speakerId, mySeq);
            try {
              await useChatStore.getState().send(speakerId, incoming.text, undefined, peers);
            } finally {
              directorSendSeq.delete(speakerId);
            }
            // Success, abort/supersede, or a failure the chat surface kept.
            if (!directorSendFailed.delete(speakerId)) break;
            if (attempt >= TURN_RETRY_DELAYS_MS.length) break;
            if (mySeq !== directorSeq || get().status !== 'live' || !get().participants.includes(speakerId)) break;
            if (!holdsReconnectSlot) {
              holdsReconnectSlot = true;
              reconnectingCount += 1;
              if (!get().reconnecting) set({ reconnecting: true });
            }
            await wait(TURN_RETRY_DELAYS_MS[attempt]);
            if (mySeq !== directorSeq || get().status !== 'live') break;
          }
        } finally {
          // Whichever way the loop exited (reply landed, superseded, gave up),
          // this turn stops contributing to the indicator.
          if (holdsReconnectSlot) {
            reconnectingCount = Math.max(0, reconnectingCount - 1);
            if (reconnectingCount === 0 && get().reconnecting) set({ reconnecting: false });
          }
        }
        // Silent-turn floor release (260708). For a NOT-in-game responder,
        // send() resolving means the whole turn is done — every streamed
        // sentence was already pushed — so a capture still empty here is a
        // turn that chose silence. Shorten its timer from the 22s
        // first-line window (which exists for in-game routed replies that
        // arrive long after send() returns) to a short IPC grace, so the
        // floor and the idle-starter clock free up as soon as the quiet is
        // real. A straggler line landing inside the grace still feeds the
        // capture and re-arms the normal quiet window.
        const k = useDataStore.getState().summons[speakerId]?.kind;
        if (
          k !== 'online' &&
          k !== 'connecting' &&
          turnCapture &&
          turnCapture.seq === mySeq &&
          turnCapture.speakerId === speakerId &&
          turnCapture.lines.length === 0
        ) {
          window.clearTimeout(turnCapture.timer);
          turnCapture.timer = window.setTimeout(() => finalizeTurnCapture(), CAPTURE_SILENT_RELEASE_MS);
        }
        return;
      } else {
        // Cross-companion reaction: a direct invoke that returns the lines (no
        // push), so the director speaks them here — but only if still current.
        const replies = await sei
          .voiceCompanionTurn?.({ characterId: speakerId, speakerName: incoming.fromName, text: incoming.text, peers, depth })
          .catch(() => [] as { text: string }[]);
        lines = (replies ?? []).map((r) => r.text).filter(Boolean);
        if (mySeq !== directorSeq) return; // barged over while generating
        // Don't let a companion who was dropped mid-generation (end_call, or the
        // user removed them) still speak a queued reaction into the room — that
        // was the "Sui kept talking in the background after she left" bug.
        if (!get().participants.includes(speakerId)) return;
        // Place each line inside its own reply for TTS conditioning (260729),
        // the same way the reveal loop and the idle nudge do.
        if (get().status === 'live') {
          for (let i = 0; i < lines.length; i++) {
            speakCompanionLine(speakerId, lines[i], {
              prev: i > 0 ? lines[i - 1] : undefined,
              more: i < lines.length - 1,
            });
          }
        }
      }
    } catch {
      lines = [];
    }
    await chainFromLines(mySeq, speakerId, lines, depth);
  }

  /** One tick of the idle-starter clock (module-level notes at the constants).
   * Chained setTimeout guarded by the session token, so the chain dies with the
   * call and two calls can never double-tick. */
  function idleTick(mySession: number): void {
    if (session !== mySession) return;
    const s = get();
    const busyConversation =
      (queue?.speaking() ?? false) ||
      pendingTts > 0 ||
      s.userSpeaking ||
      turnCapture !== null ||
      companionTurnsInFlight > 0;
    const busy = s.status !== 'live' || busyConversation || idleNudgeInFlight;
    if (busy) {
      // The conversation is doing something: restart the quiet stretch and give
      // it a fresh randomly-sampled target ("x is sampled every turn"). Real
      // conversation (not the nudge machinery itself) also clears the backoff.
      idleQuietSince = Date.now();
      idleTargetMs = sampleIdleTarget();
      if (busyConversation) idleQuietStreak = 0;
    } else if (
      useUiStore.getState().convoStartersEnabled &&
      // 2 ** not <<: the 32-bit shift goes NEGATIVE at streak 31 and wraps back
      // to 1 at 32, snapping an abandoned overnight call from the 8x backoff to
      // full-rate paid nudges. 2 ** overflows toward Infinity; the cap holds.
      Date.now() - idleQuietSince >= idleTargetMs * Math.min(IDLE_BACKOFF_CAP, 2 ** idleQuietStreak)
    ) {
      void fireIdleNudge(mySession);
    }
    window.setTimeout(() => idleTick(mySession), IDLE_TICK_MS);
  }

  /** The quiet stretch expired: ask one companion to start a topic (or stay
   * silent via silence()). Never preempts real work — main skips the turn if
   * one is in flight for the character, and the reply is dropped here if the
   * player spoke (director sequence) or the call changed while it generated. */
  async function fireIdleNudge(mySession: number): Promise<void> {
    const s = get();
    if (s.status !== 'live' || !s.participants.length) return;
    // In-game companions already have their own idle ticks (their lines reach
    // the call through say()); nudging them here too would double-drive. Pick
    // only from participants NOT in a game session; all in-game → skip.
    const summons = useDataStore.getState().summons;
    const eligible = s.participants.filter((id) => {
      const k = summons[id]?.kind;
      return k !== 'online' && k !== 'connecting';
    });
    idleNudgeInFlight = true;
    // Read BEFORE the turn runs and spend it here: main gets a different note
    // for a follow-up, and only one follow-up goes out per question.
    const awaitingAnswer = idleQuestionMode();
    if (awaitingAnswer) idleQuestionNudged = true;
    const mySeq = directorSeq;
    let spoke = false;
    try {
      if (!eligible.length) return;
      // 260725: no per-character proactiveness dial anymore — any eligible
      // companion may start a topic; the random pick keeps the spread.
      const speakerId = eligible[Math.floor(Math.random() * eligible.length)];
      const peers = s.participants.filter((id) => id !== speakerId).map(nameOf);
      const quietSeconds = Math.round((Date.now() - idleQuietSince) / 1000);
      const result = await sei
        .voiceIdleNudge?.({ characterId: speakerId, quietSeconds, peers, awaitingAnswer })
        ?.catch(() => null);
      if (session !== mySession || mySeq !== directorSeq) return; // superseded while generating
      if (get().status !== 'live' || !get().participants.includes(speakerId)) return;
      const nudgeLines = (result?.messages ?? []).filter((r) => r.text);
      for (let i = 0; i < nudgeLines.length; i++) {
        // Group calls: capture opens so the room hears it and may react.
        spoke = true;
        speakAndCapture(speakerId, nudgeLines[i].text, mySeq, {
          prev: i > 0 ? nudgeLines[i - 1].text : undefined,
          more: i < nudgeLines.length - 1,
        });
      }
      // The nudge turn hung up (end_call). Same path as the send() endCall flag
      // and the voice:call-ended push: the goodbye lines just queued above get
      // to finish playing before the companion (or the whole call) drops.
      if (result?.endCall) requestRemoteEnd(speakerId);
    } finally {
      idleNudgeInFlight = false;
      // The next quiet stretch starts now, with a fresh target. A quiet outcome
      // (silence, skip, failure) grows the backoff; a spoken line resets it.
      idleQuietStreak = spoke ? 0 : idleQuietStreak + 1;
      idleQuietSince = Date.now();
      idleTargetMs = sampleIdleTarget();
    }
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
    clearTurnCapture(); // a fresh utterance supersedes any pending turn capture
    lastReactorId = null; // fresh utterance: reset the chain's spread memory
    // Whatever they said, the question is no longer hanging (260730).
    idleAwaitingAnswer = false;
    idleQuestionNudged = false;
    set({ lastHeard: text });
    // 260708: EVERY participant gets a real turn for every player utterance —
    // in-game or not. In-game recipients route to their game brain, which
    // carries the group-addressing guidance and decides for itself whether the
    // line is its to answer (this replaced pickResponder for play-while-calling
    // sessions, where STT-mangled names — "Marv" heard as "My bar", "Sui" as
    // "sweet"/"soy" — routed commands to the wrong bot). Off-game recipients
    // run the standalone voice turn, which honors launch() against live LAN
    // state and may yield via "(silence)". Later the same day the director's
    // single-responder flow was dropped for pure-call groups too: routing
    // "both of you join my world" to ONE companion left the other with a
    // transcript row and no turn — it could neither answer nor launch, and the
    // picked one (told the other "spoke" only through the transcript) filled
    // the gap by fabricating a line in the other's voice. The group-call
    // prompt gives every recipient the yield guidance, so a line meant for one
    // companion alone still gets one answer, not N. send() persists the player
    // row before routing, so no separate observe mirror is needed.
    // 260804: a companion who is watching a shared screen answers THROUGH
    // backseat, not through the standalone voice turn.
    //
    // The bug this fixes was two conversations at once. Backseat runs its own
    // turn loop with the grid attached; the director runs its own with the
    // microphone attached; both write to the same chat thread and both speak
    // through the same call. So the player got a companion who could see their
    // screen and never heard a word they said, talking over a companion who
    // could hear them and had no idea what was on screen. Nothing was broken in
    // either loop — there were simply two of them, and neither knew.
    //
    // The share is the more informed of the two (it has the grid, the audio
    // transcript and the window title on top of everything the voice turn has),
    // so the utterance is routed there and the duplicate voice turn is skipped.
    // Anyone else on the call still takes a normal turn.
    const sharingFor = useBackseatStore.getState().sharingFor;
    const capture = sharingFor && parts.includes(sharingFor) ? backseatCapture() : null;
    for (const id of parts) {
      if (capture && id === sharingFor) {
        // Date the dispatch the way armTurnCapture would, so the reply arriving
        // later through onCompanionText resolves to THIS turn rather than being
        // read as a spontaneous line from an older one.
        if (parts.length === 1) armTurnCapture(mySeq, id, 0);
        else speakerOriginSeq.set(id, mySeq);
        void capture.sendUserTick(text).catch(() => {
          /* a dropped tick is a missed answer, never a broken call */
        });
        continue;
      }
      // No director-side turn capture on a multi-recipient broadcast: the
      // capture slot is single and the replies stream back through
      // onCompanionText, which speaks and mirrors them regardless (the first
      // responder to actually produce a line takes the floor there).
      void runCompanionTurn(mySeq, id, { from: 'player', text }, 0, { capture: parts.length === 1 });
    }
  }

  // Chat → voice seam: companion text lands here from BOTH reply paths (send()
  // result + chat:message push), and companion hang-ups from BOTH end_call paths.
  registerVoiceHooks({
    isCallActive: (characterId) => get().participants.includes(characterId),
    onRemoteEndCall: requestRemoteEnd,
    onTurnFailed: (characterId) => {
      // Own the failure only when it belongs to a director-dispatched voice
      // turn that is STILL current — the retry loop in runCompanionTurnInner
      // is awaiting this very send. Typed-composer sends (never in the map)
      // and stale turns keep the chat surface's apology bubble.
      if (directorSendSeq.get(characterId) !== directorSeq) return false;
      if (get().status !== 'live' || !get().participants.includes(characterId)) return false;
      directorSendFailed.add(characterId);
      return true;
    },
    onCompanionText: (characterId, text, ctx) => {
      const s = get();
      if (!s.participants.includes(characterId)) return;
      // Date the line to its turn: the seq current when this speaker's
      // generation was dispatched (armTurnCapture / voiceGreet recorded it). No
      // record = a generation the renderer never dispatched (an in-world say()
      // routed up), which is current by definition.
      const originSeq = speakerOriginSeq.get(characterId) ?? directorSeq;
      // Lines can arrive before the (first) line opens, or while a call scene
      // is still walking the companion on (introHold): buffer, and flush when
      // the gate lifts. Anything outside those two states has no call to speak
      // into and is dropped.
      if (s.status === 'connecting' || (s.status === 'live' && s.introHold)) {
        if (pendingCompanionLines.length < MAX_PENDING_COMPANION_LINES) {
          pendingCompanionLines.push({ characterId, text, seq: originSeq, ctx });
        }
        return;
      }
      if (s.status !== 'live') return;
      // Speak it, and open/feed the director's turn capture so the rest of the
      // room hears it and the banter chain runs (see speakAndCapture).
      speakAndCapture(characterId, text, originSeq, ctx);
    },
    onPlayerText: (characterId, text) => {
      // A message TYPED to an on-call companion (the chat composer mid-call)
      // bypasses dispatchUserTurn, so the director does its bookkeeping here:
      // the player took the floor addressing `characterId`, the others should
      // hear the words, and the reply should chain reactions like any responder
      // turn. Solo calls need none of that (the addressee is the whole room).
      const s = get();
      if (s.status !== 'live' || s.participants.length < 2 || !s.participants.includes(characterId)) return;
      const mySeq = ++directorSeq; // the player takes the floor: cancel running banter
      clearTurnCapture();
      lastReactorId = null;
      set({ lastHeard: text });
      for (const id of s.participants) {
        if (id !== characterId) {
          void sei.voiceObserve?.({ characterId: id, from: 'player', text }).catch(() => {});
        }
      }
      armTurnCapture(mySeq, characterId, 0);
    },
    voicePeersFor: (characterId) => {
      const s = get();
      if (!s.participants.includes(characterId)) return [];
      return s.participants.filter((id) => id !== characterId).map(nameOf);
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

  // Usage limit (260730): every companion line on a call is a cloud LLM + TTS
  // call, so once the ledger 402s the call is a dead line anyway. Hang up so
  // the player is not left talking to silence; the HardStopModal (raised by
  // the same push, at the App root) explains what happened.
  try {
    offCreditsHardStop =
      sei.onCreditsHardStop?.(() => {
        const st = useVoiceStore.getState();
        if (st.participants.length > 0 && (st.status === 'live' || st.status === 'connecting')) {
          st.endCall();
        }
      }) ?? null;
  } catch {
    /* preload without onCreditsHardStop — the popup alone covers it */
  }

  return {
    participants: [],
    callCharacterId: null,
    status: 'idle',
    speaking: false,
    speakingId: null,
    userSpeaking: false,
    reconnecting: false,
    lastHeard: '',
    lastSpoken: '',
    lastSpokenId: null,
    error: null,
    connectingDetail: null,
    liveAt: null,
    sttFallbackPrompt: false,
    introHold: false,

    startCall: async (characterId) => {
      const prev = get();
      if (prev.participants.includes(characterId) && prev.status !== 'error') return;
      // A call is already open (or dialing) — add to it rather than restart.
      if (prev.participants.length > 0 && prev.status !== 'error') {
        get().addParticipant(characterId);
        return;
      }

      // 260730: this used to prime the shared AudioContext here, before the mic
      // work below. That turned out to be backwards. The context opened at dial
      // is precisely the one the mic's echo-cancellation reroute then tears
      // down, so priming early guaranteed it was caught by the switch. The
      // context is now created by the first call sound instead, which happens
      // after the mic is up (see ringNow), and callTones waits for the output
      // to be genuinely rendering before it schedules anything.
      const mySession = ++session;
      directorSeq++; // fresh call: invalidate any stale chain token
      clearTurnCapture();
      speakerOriginSeq.clear();
      lastReactorId = null;
      const dialStart = Date.now();
      liveSince.clear();
      pendingTts = 0;
      pendingCompanionLines = [];
      remoteEndAt = null;
      remoteDrainedAt = null;
      ttsStreams.clear();
      ttsOrphans.clear();
      directorSendSeq.clear();
      directorSendFailed.clear();
      reconnectingCount = 0;
      set({
        participants: [characterId],
        callCharacterId: characterId,
        status: 'connecting',
        speaking: false,
        speakingId: null,
        userSpeaking: false,
        reconnecting: false,
        lastHeard: '',
        lastSpoken: '',
        lastSpokenId: null,
        error: null,
        connectingDetail: null,
        liveAt: null,
        sttFallbackPrompt: false,
      });

      silenceDressing();
      // The ring waits for the MIC, not for the dial (260730). Opening a
      // capture stream with echoCancellation reconfigures the page's audio
      // OUTPUT: Chromium reroutes playback through the echo canceller so it can
      // subtract it from the mic, and whatever was scheduled across that switch
      // is dropped. The mic opens a few hundred ms into dialing, which is
      // exactly the ring's first bar — heard as "the chime is cut off at the
      // start, only audible after a second". It survived the earlier
      // shared-AudioContext fix because the switch happens on EVERY dial, warm
      // context or not, which is why it was broken "always" and not just on the
      // first call of a session.
      const ringNow = (): void => {
        if (session !== mySession || stopRing) return;
        stopRing = startRingtone();
        // The pitch shifter is built here for the SAME reason the ring is:
        // it lives on the same shared context, and a worklet created across
        // the echo-canceller reroute comes up attached to an output being
        // torn down. Fire-and-forget, and seconds ahead of the first TTS
        // clip; if it is somehow not ready when one lands, that clip plays
        // unshifted rather than waiting (see pitchBus.ts).
        warmPitchBus();
      };
      // If the mic is slow (a first-run permission prompt, a busy device), ring
      // anyway rather than leave the dial silent: a clipped ring beats none.
      const ringFallback = window.setTimeout(ringNow, RING_WITHOUT_MIC_MS);

      void sei.voiceCallSetActive({ characterId, active: true }).catch(() => {});

      // Ask main to have the companion greet FIRST — fired NOW, before the local
      // Whisper model boots (the await below), so the greeting's Haiku + TTS
      // round-trip overlaps model load instead of starting after it. That model
      // bootup is the single largest unavoidable delay; running the greeting in
      // parallel with it is what lets the first word land right as we connect.
      // The reply arrives via onCompanionText while status is still 'connecting'
      // and is buffered into pendingCompanionLines, then spoken once we go live.
      speakerOriginSeq.set(characterId, directorSeq); // date the greet's lines
      void sei.voiceGreet?.(characterId)?.catch(() => {});

      queue = createAudioQueue(
        (speaking, cid, text) => {
          if (session !== mySession) return;
          // Only the STOP is published from here. A slot reaching the playhead
          // is not a sound: for a streamed clip the TTS request has not even
          // been sent yet, so lighting the ring (and the caption, and the call
          // scene's mouth) here put all three ahead of the audio by a whole
          // synthesis round trip. The start is published from onAudible below.
          if (!speaking) set({ speaking: false, speakingId: null });
          // Track whether the floor was handed back with a question on it
          // (260730) — read by sampleIdleTarget and sent to main with the
          // nudge. Set from the line that actually REACHES the playhead, so a
          // question that was cut off by a barge-in never counts as asked.
          if (speaking && text) {
            const asks = endsWithQuestion(text);
            if (asks !== idleAwaitingAnswer) idleQuestionNudged = false;
            idleAwaitingAnswer = asks;
          }
          // Hold still tracks the SLOT, not the audio: the synthesis gap before
          // a clip's first byte must keep the stiffer barge bar, or a noise in
          // that gap trips the much lower normal speech threshold instead. The
          // grace window inside the hold is armed separately, below.
          dictation?.setHold(speaking);
          if (!speaking) maybeFinishRemoteEnd();
        },
        (cid, text) => {
          if (session !== mySession) return;
          // First audible sample of this clip: the companion is talking NOW.
          // Everything the player can see of that lands together here, so the
          // caption advances with the voice rather than ahead of it.
          set({
            speaking: true,
            speakingId: cid,
            ...(text ? { lastSpoken: text, lastSpokenId: cid } : {}),
          });
          dictation?.armBargeGrace();
        },
      );
      queue.setOutputMuted(useUiStore.getState().callDeafened);

      // 260709: conversation language — picks the local Whisper model
      // (English-only tiny.en vs multilingual base) and pins its decode
      // language. Read at call start; the value is auto-detected from voice
      // by main (260725, voice/languageAutoSwitch.ts), so a mid-call switch
      // applies from the next call. Best-effort: a failed config read falls
      // back to English rather than blocking the dial.
      // 260725: the same read feeds the STT policy (sttPolicy.ts) — whether the
      // local Whisper worker boots at all, and whether cloud Scribe is wired.
      const callCfg = await sei.getConfig().catch(() => null);
      if (session !== mySession) return;
      const chatLanguage = callCfg?.chat_language ?? 'en';
      // 260725: kind from the fresh config read (main truth), not the display
      // store — the store can be UNKNOWN (null) at call time.
      const policy = sttPolicy(callCfg, callCfg?.ai_backend_kind ?? 'cloud-proxy');

      // Cloud STT (260724): race ElevenLabs Scribe against the local Whisper
      // worker for every utterance (dictation/sttArbiter own the policy; local
      // is always the fallback, so this can only improve transcripts). One
      // {unavailable} answer (signed out + no dev key, no credits, daily cap)
      // turns it off for the remainder of this call — no per-utterance
      // re-probing of a dead surface.
      let cloudSttOff = false;
      // 260725: 'no-credentials' means cloud STT can never work this call
      // (signed out, or BYOK with no ElevenLabs key and no dev key) — that
      // disable stays SILENT: in 'none' mode it must not raise the backup-
      // model prompt the way a genuine upstream failure does.
      let cloudSttSilentOff = false;
      const cloudTranscribe = async (audio: Float32Array): Promise<string | null> => {
        if (cloudSttOff || !sei.voiceStt) return null;
        try {
          // No language pin (260725): Scribe auto-detects per utterance, and
          // main persists a confident repeated detection into
          // UserConfig.chat_language (voice/languageAutoSwitch.ts) — this is
          // how the conversation language switches now that the picker UI is
          // gone. The next call start re-reads the config for the local
          // Whisper model choice below.
          const res = await sei.voiceStt({
            pcm: audio.buffer.slice(0, audio.byteLength) as ArrayBuffer,
          });
          if ('unavailable' in res) {
            cloudSttOff = true;
            const { reason } = res as { unavailable: true; reason?: 'no-credentials' | 'upstream' };
            if (reason === 'no-credentials') cloudSttSilentOff = true;
            return null;
          }
          return res.text;
        } catch {
          return null; // transient — local covers this utterance, retry on the next
        }
      };

      try {
        dictation = await createDictation({
          language: chatLanguage,
          // Output path settled — safe to schedule the ring (see ringNow).
          onMicReady: () => {
            window.clearTimeout(ringFallback);
            ringNow();
          },
          // Mode matrix (sttPolicy.ts): cloud users without the local-fallback
          // opt-in run 'none' (Scribe-only, no model download); everyone else
          // runs 'eager' (today's race). BYOK with stt_engine 'whisper' drops
          // cloudTranscribe entirely.
          localModel: policy.localModel,
          cloudTranscribe: policy.useCloud ? cloudTranscribe : undefined,
          onCloudSttFailure:
            policy.localModel === 'none'
              ? () => {
                  if (session !== mySession) return;
                  if (cloudSttSilentOff) return; // no-credentials: stay quiet
                  set({ sttFallbackPrompt: true });
                }
              : undefined,
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
          // Stage one (260804): something that might be the player crossed a low
          // bar. Duck, do not clear — the seq is NOT bumped and no chain is
          // cancelled, because this is retractable and half of these are a
          // cough. The player perceives this as the interrupt; onBargeIn below
          // is only the bookkeeping that follows a confirmed word.
          onBargeSuspect: () => {
            if (session !== mySession) return;
            queue?.duck(true);
          },
          onBargeAbort: () => {
            if (session !== mySession) return;
            queue?.duck(false);
          },
          onBargeIn: () => {
            // The player spoke over the companions: cut playback AND cancel any
            // in-flight banter chain right now. Bumping the director sequence
            // here (not waiting for the utterance to finish transcribing) is what
            // makes two-bot banter interruptible — otherwise the chain kept
            // generating and re-queuing lines while the player talked, so they
            // never actually went quiet (the "not interruptible with two bots"
            // report). dispatchUserTurn bumps the sequence again and starts the
            // responder; a junk/echo barge-in just leaves the floor to the player.
            if (session !== mySession) return;
            directorSeq++;
            clearTurnCapture();
            queue?.clear();
            // Kill the screen-share turn too. Clearing the queue only silences
            // what is already synthesised; a backseat turn still generating
            // would land its line a second later, which reads as the companion
            // carrying on with the sentence she was interrupted in.
            const sharing = useBackseatStore.getState().sharingFor;
            if (sharing) void sei.backseatInterrupt?.(sharing).catch(() => {});
          },
          onSpeechActive: (active) => {
            // Light the caller's own avatar ring while they talk (same ring the
            // companions get). Muted → never lit, even if a frame leaks through.
            if (session !== mySession) return;
            // 260724 latency: speech just OPENED — prewarm the voice upstream
            // now so the STT request at utterance-end (and the TTS reply after)
            // lands on a warm connection. Throttled in main; fire-and-forget.
            if (active) void sei.voiceSttPrewarm?.().catch(() => {});
            // Latch the screen as it looked when they STARTED talking, not as it
            // looks when they stop. Someone reacting to a moment describes the
            // moment they reacted to, and by the end of the sentence it is gone.
            if (active) backseatCapture()?.armUserGrid();
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

      // Idle conversation starter: the quiet clock starts at connect (the
      // greeting about to play immediately resets it anyway) and ticks for the
      // life of the call — the session guard kills the chain at hang-up.
      idleQuietSince = now;
      idleAwaitingAnswer = false; // module state: never inherit the last call's
      idleQuestionNudged = false;
      idleTargetMs = sampleIdleTarget();
      idleQuietStreak = 0;
      window.setTimeout(() => idleTick(mySession), IDLE_TICK_MS);

      // A one-second beat after "connected" before the companion speaks — a real
      // pickup pause, and a head start for the greeting's TTS first byte.
      await wait(CONNECT_SPEAK_DELAY_MS);
      if (session !== mySession) return;
      // A call scene still walking the companion on keeps the lines buffered;
      // its setIntroHold(false) does this flush instead.
      if (!get().introHold) flushPendingCompanionLines();
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
      if (s.status === 'live') {
        speakerOriginSeq.set(characterId, directorSeq); // date the greet's lines
        void sei.voiceGreet?.(characterId, peerNames)?.catch(() => {});
      }
    },

    removeParticipant: (characterId) => {
      const s = get();
      if (!s.participants.includes(characterId)) return;
      const next = s.participants.filter((id) => id !== characterId);
      // A membership change is a barge point: cancel any in-flight companion chain
      // so the departing companion's queued reaction can't still fire (the
      // "she left but kept talking in the background" bug), and so a chain that
      // was about to hand the floor to the now-absent companion stops cleanly.
      // The seq bump and the capture clear travel TOGETHER at every barge point:
      // a stale armed capture blocks speakAndCapture from arming a fresh one
      // (it only arms when null) and fails its seq guard, so later companion
      // lines would speak but never mirror to the peers again.
      directorSeq++;
      clearTurnCapture();
      speakerOriginSeq.delete(characterId);
      if (lastReactorId === characterId) lastReactorId = null;
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
        ...(get().speakingId === characterId
          ? { speaking: false, speakingId: null }
          : {}),
      });
    },

    endCall: () => {
      const { participants } = get();
      session += 1;
      directorSeq++; // cancel any running companion chain (bump + clear travel together)
      clearTurnCapture();
      speakerOriginSeq.clear();
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
      directorSendSeq.clear();
      directorSendFailed.clear();
      reconnectingCount = 0;
      window.clearTimeout(introHoldTimer);
      set({
        participants: [],
        callCharacterId: null,
        status: 'idle',
        speaking: false,
        speakingId: null,
        userSpeaking: false,
        reconnecting: false,
        lastHeard: '',
        lastSpoken: '',
        lastSpokenId: null,
        error: null,
        connectingDetail: null,
        liveAt: null,
        sttFallbackPrompt: false,
        introHold: false,
      });
      useUiStore.getState().endCall();
    },

    // 260725: the cloud-STT backup-model offer (see sttFallbackPrompt).
    acceptSttFallback: async () => {
      set({ sttFallbackPrompt: false });
      try {
        const cfg = await sei.getConfig();
        await sei.saveConfig({ ...cfg, stt_local_fallback: true });
      } catch {
        // Best-effort: if the write fails the prompt can fire again next call.
      }
      // Start the ~40MB download NOW so the next call boots with the fallback
      // in place. This call stays cloud-only — hot-swapping a Whisper worker
      // into a live dictation session is not worth the machinery, and the
      // download would not finish in time to help this call anyway.
      void prefetchVoiceModel().catch(() => {});
    },

    dismissSttFallback: () => set({ sttFallbackPrompt: false }),

    setIntroHold: (hold) => {
      window.clearTimeout(introHoldTimer);
      if (hold) {
        set({ introHold: true });
        introHoldTimer = window.setTimeout(
          () => get().setIntroHold(false),
          INTRO_HOLD_CAP_MS,
        );
        return;
      }
      if (!get().introHold) return;
      set({ introHold: false });
      // Releasing IS the flush the connect path skipped. Only once live: a
      // release while still ringing must not jump the pickup.
      if (get().status === 'live') flushPendingCompanionLines();
    },
  };
});

/**
 * Chess reveal gating (260710): whether the call's speech pipeline is fully
 * drained — no TTS fetch in flight AND nothing playing. Same predicate the
 * solo hang-up drain uses (maybeFinishRemoteEnd). Module-level because
 * pendingTts / queue are non-reactive session internals; poll it (the chess
 * useAiMoveReveal hook does) rather than subscribing.
 */
export function voiceTtsDrained(): boolean {
  return pendingTts === 0 && !(queue?.speaking() ?? false);
}

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
    offCreditsHardStop?.();
  });
}
