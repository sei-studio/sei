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
 * Mute/deafen live in useUiStore (shared with the MinimizedCall widget); we
 * subscribe and forward them. Half-duplex: while companion audio is audible the
 * mic is held, so the companions never hear themselves.
 */

import { create } from 'zustand';
import { sei } from '../ipcClient';
import { useUiStore } from './useUiStore';
import { useChatStore } from './useChatStore';
import { useDataStore } from './useDataStore';
import { voicePitchRate } from '@shared/voicePitch';
import { createAudioQueue, type AudioQueue, type TtsStreamHandle } from '../voice/audioQueue';
import { createDictation, type Dictation } from '../voice/dictation';
import { registerVoiceHooks } from '../voice/voiceBridge';
import { decideReaction, isJunkTranscript, type Participant } from '../voice/pfcSteer';
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
/** Companion lines that arrived while the (first) call was still 'connecting'.
 * `seq` is the line's ORIGIN sequence resolved at buffer time (see
 * speakerOriginSeq), threaded through the flush into speakAndCapture. */
let pendingCompanionLines: Array<{ characterId: string; text: string; seq: number }> = [];
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
// Proactiveness-keyed pacing (260708): when an AGENTIC character (proactiveness
// dial 2) is on the call, quiet stretches are shorter — it is the one expected
// to keep the conversation going (its nudge prompt in main also drops the
// silence option), so the call never sits dead for a minute waiting on the
// default window. Turning the character's dial down restores the laid-back
// cadence; the "Conversation starters" toggle still gates all of it.
const PROACTIVE_NUDGE_MIN_MS = 6_000;
const PROACTIVE_NUDGE_MAX_MS = 18_000;
const IDLE_TICK_MS = 1_000;
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
function sampleIdleTarget(level = 1): number {
  const min = level >= 2 ? PROACTIVE_NUDGE_MIN_MS : IDLE_NUDGE_MIN_MS;
  const max = level >= 2 ? PROACTIVE_NUDGE_MAX_MS : IDLE_NUDGE_MAX_MS;
  return min + Math.random() * (max - min);
}

/** The proactiveness dial (0-2) of a call participant — same source + clamp as
 * main and the bot (character.metadata.proactiveness, junk → 1). */
function proactivenessOf(characterId: string): number {
  const p = useDataStore.getState().characters.find((c) => c.id === characterId)?.metadata
    ?.proactiveness;
  return typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 2 ? p : 1;
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

/** Playback rate (preservesPitch off) for a companion's TTS clips — the
 * playback half of the pitch shift; main slows the synthesis to match so the
 * net pace stays normal (see shared/voicePitch.ts). */
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
      const handle = queue.enqueueStream(characterId, text, pitchRateOf(characterId));
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
        if (session === mySession) queue?.enqueue(buf, characterId, text, pitchRateOf(characterId));
      })
      .catch((err) => surfaceTtsError(String((err as Error)?.message ?? '')))
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
  function speakAndCapture(characterId: string, text: string, originSeq: number): void {
    speakCompanionLine(characterId, text);
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
        speakAndCapture(line.characterId, line.text, line.seq);
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
        await useChatStore.getState().send(speakerId, incoming.text, undefined, peers);
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
        if (get().status === 'live') for (const l of lines) speakCompanionLine(speakerId, l);
      }
    } catch {
      lines = [];
    }
    await chainFromLines(mySeq, speakerId, lines, depth);
  }

  /** The pacing level for the idle starter: the HIGHEST proactiveness dial
   * among the call's nudge-eligible (not-in-game) participants — one agentic
   * companion on the line is enough to keep it moving. No eligible off-game
   * participant → default pacing (the nudge will skip anyway). */
  function callIdleLevel(): number {
    const summons = useDataStore.getState().summons;
    const off = get().participants.filter((id) => {
      const k = summons[id]?.kind;
      return k !== 'online' && k !== 'connecting';
    });
    return off.length ? Math.max(...off.map(proactivenessOf)) : 1;
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
      idleTargetMs = sampleIdleTarget(callIdleLevel());
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
    const mySeq = directorSeq;
    let spoke = false;
    try {
      if (!eligible.length) return;
      // The most proactive companion is the one who starts topics (260708): an
      // agentic character on the call is expected to carry the conversation, so
      // it gets the nudge over a laid-back peer; ties keep the random spread.
      const top = Math.max(...eligible.map(proactivenessOf));
      const pool = eligible.filter((id) => proactivenessOf(id) === top);
      const speakerId = pool[Math.floor(Math.random() * pool.length)];
      const peers = s.participants.filter((id) => id !== speakerId).map(nameOf);
      const quietSeconds = Math.round((Date.now() - idleQuietSince) / 1000);
      const result = await sei
        .voiceIdleNudge?.({ characterId: speakerId, quietSeconds, peers })
        ?.catch(() => null);
      if (session !== mySession || mySeq !== directorSeq) return; // superseded while generating
      if (get().status !== 'live' || !get().participants.includes(speakerId)) return;
      for (const r of result?.messages ?? []) {
        // Group calls: capture opens so the room hears it and may react.
        if (r.text) {
          spoke = true;
          speakAndCapture(speakerId, r.text, mySeq);
        }
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
      idleTargetMs = sampleIdleTarget(callIdleLevel());
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
    for (const id of parts) {
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
    onCompanionText: (characterId, text) => {
      const s = get();
      if (!s.participants.includes(characterId)) return;
      // Date the line to its turn: the seq current when this speaker's
      // generation was dispatched (armTurnCapture / voiceGreet recorded it). No
      // record = a generation the renderer never dispatched (an in-world say()
      // routed up), which is current by definition.
      const originSeq = speakerOriginSeq.get(characterId) ?? directorSeq;
      // Lines can arrive before the (first) line opens: buffer and flush on live.
      if (s.status === 'connecting') {
        if (pendingCompanionLines.length < MAX_PENDING_COMPANION_LINES) {
          pendingCompanionLines.push({ characterId, text, seq: originSeq });
        }
        return;
      }
      if (s.status !== 'live') return;
      // Speak it, and open/feed the director's turn capture so the rest of the
      // room hears it and the banter chain runs (see speakAndCapture).
      speakAndCapture(characterId, text, originSeq);
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
      speakerOriginSeq.set(characterId, directorSeq); // date the greet's lines
      void sei.voiceGreet?.(characterId)?.catch(() => {});

      queue = createAudioQueue((speaking, cid, text) => {
        if (session !== mySession) return;
        // Advance the caption to the line that just STARTED playing, so it flows
        // in step with the audio (each line shows as it's spoken) instead of
        // jumping to the last-enqueued line. The previous line stays up during the
        // brief gap between clips (speaking=false) until the next one begins.
        set({
          speaking,
          speakingId: speaking ? cid : null,
          ...(speaking && text ? { lastSpoken: text, lastSpokenId: cid } : {}),
        });
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

      // Idle conversation starter: the quiet clock starts at connect (the
      // greeting about to play immediately resets it anyway) and ticks for the
      // life of the call — the session guard kills the chain at hang-up.
      idleQuietSince = now;
      idleTargetMs = sampleIdleTarget(callIdleLevel());
      idleQuietStreak = 0;
      window.setTimeout(() => idleTick(mySession), IDLE_TICK_MS);

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
        ...(get().speakingId === characterId ? { speaking: false, speakingId: null } : {}),
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
