/**
 * Voice reply clock (261106, `reply_latency` surface voice).
 *
 * How long the player waits on a call: from a dispatched utterance (the STT
 * final the director turns into a turn) to the first AUDIBLE sample of a
 * companion clip (the audio queue's onAudible, the one honest "sound is
 * coming out now" signal). Turn numbers count utterances within one call.
 *
 * Outcomes:
 *   - replied: a companion clip became audible.
 *   - aborted: a new utterance superseded the turn (barge-in), or the call
 *     ended, before anything played.
 *   - silent: every off-game companion's turn returned and nothing was queued
 *     to speak (a "(silence)" answer), or nothing at all within
 *     VOICE_REPLY_GIVE_UP_MS (an in-game companion's reply comes back long
 *     after its send, so only the give-up timer can call that one silent).
 *   - error: the director gave up retrying a failed turn, or a line was
 *     queued but no audio played by the give-up timer (TTS failed).
 *
 * The renderer only measures. The sample goes to main through
 * analytics:track, where it is re-validated, sampled and sent
 * (src/main/replyLatency.ts). Shape only: no text, no ids.
 *
 * Phases (261123, O5 voice latency). `ms` alone could not say where the
 * ~3s goes, so the sample also carries where the turn had got to, each in
 * ms from the same dispatch (absent when that point was never reached):
 *   - speech_end_to_final_ms: BEFORE the clock. From the end of the
 *     player's voice (the last voiced mic frame) to the dispatch: the
 *     end-of-speech silence wait, STT and the echo gate. The player waits
 *     through this too, it just is not in `ms`.
 *   - llm_request_ms: main sent the LLM request (IPC, transcript write,
 *     prompt build, provider setup before it).
 *   - llm_first_token_ms: the first reply text token arrived in main.
 *   - line_queued_ms: the first companion line was handed to TTS (the
 *     first sentence finished generating, then the push to the renderer).
 *   - tts_first_chunk_ms: that line's first audio bytes reached the
 *     renderer (TTS request, provider time to first byte, the trip back).
 *   - `ms` (audible) minus that is decode and playback start.
 * The two llm_* stamps come from main as wall-clock times on the first
 * pushed line (SpokenLineContext.replyTiming), so they are converted with
 * the wall clock, not performance.now(). In-game turns have no llm_* (the
 * bot answers), and a Kokoro clip has no tts_first_chunk_ms.
 */

export type VoiceReplyOutcome = 'replied' | 'silent' | 'error' | 'aborted';
export type VoiceReplyPath = 'app' | 'in_game';

/** Phase offsets, integer ms from the dispatch (see the header). */
export interface VoiceReplyPhases {
  speech_end_to_final_ms?: number;
  llm_request_ms?: number;
  llm_first_token_ms?: number;
  line_queued_ms?: number;
  tts_first_chunk_ms?: number;
}

export interface VoiceReplySample extends VoiceReplyPhases {
  surface: 'voice';
  path: VoiceReplyPath;
  turn: number;
  ms: number;
  outcome: VoiceReplyOutcome;
}

/** Main's wall-clock stamps for the send that produced a line (SpokenLineContext.replyTiming). */
export interface VoiceLineTiming {
  llmStartAt?: number;
  firstTokenAt?: number;
}

/** No audible reply by now: the turn is over (in-game replies get up to ~22s). */
export const VOICE_REPLY_GIVE_UP_MS = 45_000;
/** After the sends return, a streamed line can still be in flight over IPC. */
export const VOICE_SETTLE_GRACE_MS = 1_500;

export interface VoiceReplyClockDeps {
  now: () => number;
  /** Wall clock (Date.now), for stamps taken in another process or by the mic. */
  wallNow?: () => number;
  report: (sample: VoiceReplySample) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  giveUpMs?: number;
  settleGraceMs?: number;
}

export interface VoiceReplyClock {
  /** A call opened: turn numbers restart. Drops a pending turn as aborted. */
  reset(): void;
  /** A player utterance was dispatched as turn `seq` (the director's token).
   * `speechEndAt`: wall-clock end of the player's voice, when the mic knows it. */
  utterance(seq: number, path: VoiceReplyPath, speechEndAt?: number): void;
  /** A companion line was queued for TTS. For the turn's FIRST line, returns
   * the callback to run when that line's first audio bytes arrive; else null. */
  lineQueued(timing?: VoiceLineTiming): (() => void) | null;
  /** A companion clip produced its first audible sample. */
  audible(): void;
  /** Every off-game send for turn `seq` returned. */
  settled(seq: number): void;
  /** The director gave up on a failed turn for `seq`. */
  failed(seq: number): void;
  /** The call ended. */
  end(): void;
}

interface Pending {
  seq: number;
  turn: number;
  path: VoiceReplyPath;
  t0: number;
  /** Wall-clock time of the dispatch, for the cross-process stamps. */
  wall0: number;
  queued: boolean;
  failed: boolean;
  timers: unknown[];
  phases: VoiceReplyPhases;
}

/** A non-negative integer offset, or undefined (a clock that stepped backwards
 * or a stamp from before this turn is dropped, never sent as 0). */
function offset(at: number | undefined, from: number): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  const d = Math.round(at - from);
  return d >= 0 ? d : undefined;
}

export function createVoiceReplyClock(deps: VoiceReplyClockDeps): VoiceReplyClock {
  const giveUpMs = deps.giveUpMs ?? VOICE_REPLY_GIVE_UP_MS;
  const graceMs = deps.settleGraceMs ?? VOICE_SETTLE_GRACE_MS;
  const wallNow = deps.wallNow ?? Date.now;
  let turn = 0;
  let pending: Pending | null = null;

  const resolve = (outcome: VoiceReplyOutcome): void => {
    const p = pending;
    if (!p) return;
    pending = null;
    for (const h of p.timers) deps.clearTimer(h);
    try {
      deps.report({
        surface: 'voice',
        path: p.path,
        turn: p.turn,
        ms: Math.max(0, Math.round(deps.now() - p.t0)),
        outcome,
        ...p.phases,
      });
    } catch {
      /* telemetry never breaks a call */
    }
  };

  /** Resolve only if `p` is still the pending turn when the timer fires. */
  const later = (p: Pending, ms: number, decide: () => VoiceReplyOutcome | null): void => {
    p.timers.push(
      deps.setTimer(() => {
        if (pending !== p) return;
        const outcome = decide();
        if (outcome) resolve(outcome);
      }, ms),
    );
  };

  return {
    reset() {
      resolve('aborted');
      turn = 0;
    },
    utterance(seq, path, speechEndAt) {
      resolve('aborted');
      turn += 1;
      const wall0 = wallNow();
      const phases: VoiceReplyPhases = {};
      // The mic's end of speech is before the dispatch: measured the other way.
      const heard = typeof speechEndAt === 'number' ? offset(wall0, speechEndAt) : undefined;
      if (heard !== undefined) phases.speech_end_to_final_ms = heard;
      const p: Pending = { seq, turn, path, t0: deps.now(), wall0, queued: false, failed: false, timers: [], phases };
      pending = p;
      later(p, giveUpMs, () => (p.queued || p.failed ? 'error' : 'silent'));
    },
    lineQueued(timing) {
      const p = pending;
      if (!p) return null;
      const first = !p.queued;
      p.queued = true;
      if (!first) return null;
      p.phases.line_queued_ms = Math.max(0, Math.round(deps.now() - p.t0));
      const llmRequest = offset(timing?.llmStartAt, p.wall0);
      const firstToken = offset(timing?.firstTokenAt, p.wall0);
      if (llmRequest !== undefined) p.phases.llm_request_ms = llmRequest;
      if (firstToken !== undefined) p.phases.llm_first_token_ms = firstToken;
      let fired = false;
      return () => {
        if (fired || pending !== p) return;
        fired = true;
        p.phases.tts_first_chunk_ms = Math.max(0, Math.round(deps.now() - p.t0));
      };
    },
    audible() {
      resolve('replied');
    },
    settled(seq) {
      const p = pending;
      if (!p || p.seq !== seq || p.queued) return;
      later(p, graceMs, () => (p.queued ? null : p.failed ? 'error' : 'silent'));
    },
    failed(seq) {
      if (pending && pending.seq === seq) pending.failed = true;
    },
    end() {
      resolve('aborted');
    },
  };
}
