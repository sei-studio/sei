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
 */

export type VoiceReplyOutcome = 'replied' | 'silent' | 'error' | 'aborted';
export type VoiceReplyPath = 'app' | 'in_game';

export interface VoiceReplySample {
  surface: 'voice';
  path: VoiceReplyPath;
  turn: number;
  ms: number;
  outcome: VoiceReplyOutcome;
}

/** No audible reply by now: the turn is over (in-game replies get up to ~22s). */
export const VOICE_REPLY_GIVE_UP_MS = 45_000;
/** After the sends return, a streamed line can still be in flight over IPC. */
export const VOICE_SETTLE_GRACE_MS = 1_500;

export interface VoiceReplyClockDeps {
  now: () => number;
  report: (sample: VoiceReplySample) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  giveUpMs?: number;
  settleGraceMs?: number;
}

export interface VoiceReplyClock {
  /** A call opened: turn numbers restart. Drops a pending turn as aborted. */
  reset(): void;
  /** A player utterance was dispatched as turn `seq` (the director's token). */
  utterance(seq: number, path: VoiceReplyPath): void;
  /** A companion line was queued for TTS. */
  lineQueued(): void;
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
  queued: boolean;
  failed: boolean;
  timers: unknown[];
}

export function createVoiceReplyClock(deps: VoiceReplyClockDeps): VoiceReplyClock {
  const giveUpMs = deps.giveUpMs ?? VOICE_REPLY_GIVE_UP_MS;
  const graceMs = deps.settleGraceMs ?? VOICE_SETTLE_GRACE_MS;
  let turn = 0;
  let pending: Pending | null = null;

  const resolve = (outcome: VoiceReplyOutcome): void => {
    const p = pending;
    if (!p) return;
    pending = null;
    for (const h of p.timers) deps.clearTimer(h);
    try {
      deps.report({ surface: 'voice', path: p.path, turn: p.turn, ms: Math.max(0, Math.round(deps.now() - p.t0)), outcome });
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
    utterance(seq, path) {
      resolve('aborted');
      turn += 1;
      const p: Pending = { seq, turn, path, t0: deps.now(), queued: false, failed: false, timers: [] };
      pending = p;
      later(p, giveUpMs, () => (p.queued || p.failed ? 'error' : 'silent'));
    },
    lineQueued() {
      if (pending) pending.queued = true;
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
