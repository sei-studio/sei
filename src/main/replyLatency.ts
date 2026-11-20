/**
 * Reply latency telemetry (261106, retention O2 item 6: "first_reply_ms on
 * chat and voice turns. No latency telemetry exists.").
 *
 * One `reply_latency` event per SAMPLED player turn: how long the player
 * waited from sending a message (or finishing an utterance) to the
 * companion's first visible or audible reply. Props, shape only:
 *   - `surface`  chat | voice | minecraft
 *   - `path`     app (the app's own chat brain) | in_game (a live game session
 *                answered: a chat routed into the bot, or a call with a
 *                companion who is in a world)
 *   - `ms`       raw integer milliseconds, like every other duration we send
 *                (`duration_ms`, `prev_uptime_ms`, app_hang)
 *   - `outcome`  replied | silent | error | aborted
 *   - `turn_index_bucket`  first | 2-5 | 6+ (turn number within the session)
 *   - `sample_rate` 1 or 10: how many turns this event stands for
 *   - `via`      minecraft only: say | action (what answered the line)
 * `backend` / `ai_provider` / `model_family` ride on every event already
 * (commonProps). No text, no character id.
 *
 * WHY SAMPLED PER-TURN EVENTS AND NOT A PER-SESSION ROLL-UP. Percentiles do not
 * merge: a session-level p50 averaged across sessions is not the p50 of
 * turns, and the question we need answered ("is the first reply of a new
 * user's session slow, on which backend?") is a per-turn percentile sliced by
 * bucket. A roll-up would also be lost whenever a session never closes
 * cleanly (crash, force quit), which is exactly when latency is suspect. So
 * every turn is sent while it is one of the session's first five (the
 * `first` and `2-5` buckets are complete, no weighting needed) and after that
 * only every tenth turn (10, 20, 30...), tagged `sample_rate: 10`. That caps a
 * session at 5 + n/10 events.
 *
 * Who measures what (the clock always runs where the player's wait is seen):
 *   - chat: main, the `chat:send` handler (ipc.ts). Starts on handler entry,
 *     stops at the first companion bubble handed to the renderer (the
 *     early "lemme check" line before a web lookup, or the returned reply).
 *     "Realistic typing" pacing is the player's chosen theater and is not
 *     included. A chat routed into a live game is timed by the bot instead.
 *   - voice: the renderer (lib/voice/replyClock.ts), from a dispatched STT
 *     final to the first audible TTS sample; sent through analytics:track and
 *     re-validated + sampled here.
 *   - minecraft (and any bot game): the bot (brain/actionStats.js), from a
 *     player chat line to the companion's say() (or a started world action);
 *     sent up the port as {type:'reply-latency'}.
 *
 * No model call, no added tokens. Dev launches send nothing: initAnalytics
 * creates no client off the stable/beta channels, so capture() is a no-op.
 */
import { z } from 'zod';
import { loadAnalytics } from './lazyAnalytics';

export const REPLY_LATENCY_EVENT = 'reply_latency';

export const REPLY_SURFACES = ['chat', 'voice', 'minecraft'] as const;
export const REPLY_OUTCOMES = ['replied', 'silent', 'error', 'aborted'] as const;
export const REPLY_PATHS = ['app', 'in_game'] as const;
export const REPLY_VIAS = ['say', 'action'] as const;

export type ReplySurface = (typeof REPLY_SURFACES)[number];
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];
export type ReplyPath = (typeof REPLY_PATHS)[number];
export type ReplyVia = (typeof REPLY_VIAS)[number];
export type TurnIndexBucket = 'first' | '2-5' | '6+';

/** Anything longer is a stuck clock, not a reply; clamped so one cannot skew a mean. */
export const REPLY_MS_MAX = 10 * 60_000;
/** Every turn up to this one is sent. */
export const FULL_SAMPLE_TURNS = 5;
/** After that, one turn in this many. */
export const LATE_SAMPLE_EVERY = 10;

export interface ReplyLatencySample {
  surface: ReplySurface;
  path: ReplyPath;
  /** 1-based turn number within the surface's session. */
  turn: number;
  ms: number;
  outcome: ReplyOutcome;
  via?: ReplyVia;
}

export function turnIndexBucket(turn: number): TurnIndexBucket {
  if (turn <= 1) return 'first';
  if (turn <= FULL_SAMPLE_TURNS) return '2-5';
  return '6+';
}

/** How many turns one sent event for this turn stands for; 0 = not sent. */
export function sampleRate(turn: number): 0 | 1 | 10 {
  if (!Number.isInteger(turn) || turn < 1) return 0;
  if (turn <= FULL_SAMPLE_TURNS) return 1;
  return turn % LATE_SAMPLE_EVERY === 0 ? LATE_SAMPLE_EVERY : 0;
}

/** The event props for a sample, or null when this turn is not sampled. */
export function replyLatencyProps(s: ReplyLatencySample): Record<string, string | number> | null {
  const rate = sampleRate(s.turn);
  if (rate === 0) return null;
  const ms = Math.min(REPLY_MS_MAX, Math.max(0, Math.round(Number.isFinite(s.ms) ? s.ms : 0)));
  return {
    surface: s.surface,
    path: s.path,
    ms,
    outcome: s.outcome,
    turn_index_bucket: turnIndexBucket(s.turn),
    sample_rate: rate,
    ...(s.surface === 'minecraft' && s.via ? { via: s.via } : {}),
  };
}

type CaptureFn = (event: string, props: Record<string, unknown>) => void;

/**
 * Send one sample if its turn is sampled. Fire-and-forget, never throws.
 * `capture` is a test seam; production uses the shared lazy analytics import.
 */
export function recordReplyLatency(s: ReplyLatencySample, capture?: CaptureFn): void {
  try {
    const props = replyLatencyProps(s);
    if (!props) return;
    if (capture) {
      capture(REPLY_LATENCY_EVENT, props);
      return;
    }
    void loadAnalytics()
      .then((a) => a.capture(REPLY_LATENCY_EVENT, props))
      .catch(() => {});
  } catch {
    /* analytics is never load-bearing */
  }
}

const TurnSchema = z.number().int().min(1).max(100_000);
const MsSchema = z.number().finite().min(0);

/**
 * The renderer's voice sample (analytics:track, event `reply_latency`). Only
 * the voice surface is measured there, so anything else is dropped; the props
 * are rebuilt from closed enums so nothing free-form can ride along.
 */
const RendererSampleSchema = z.object({
  surface: z.literal('voice'),
  path: z.enum(REPLY_PATHS),
  turn: TurnSchema,
  ms: MsSchema,
  outcome: z.enum(REPLY_OUTCOMES),
});

export function sanitizeRendererReplyLatency(raw: unknown): ReplyLatencySample | null {
  const r = RendererSampleSchema.safeParse(raw);
  return r.success ? { ...r.data } : null;
}

/** The bot's {type:'reply-latency'} port message (a separate process: re-validated). */
const BotSampleSchema = z.object({
  type: z.literal('reply-latency'),
  /** 'game' = a line typed in the game's own chat; 'app' = a Sei chat message routed in. */
  origin: z.enum(['game', 'app']),
  turn: TurnSchema,
  ms: MsSchema,
  outcome: z.enum(REPLY_OUTCOMES),
  via: z.enum(REPLY_VIAS).optional(),
});

export function parseBotReplyLatency(raw: unknown): ReplyLatencySample | null {
  const r = BotSampleSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  // A chat typed in the app and answered by the live game session is still a
  // chat-surface wait (the reply shows in the chat window); its path says who
  // answered it.
  return d.origin === 'app'
    ? { surface: 'chat', path: 'in_game', turn: d.turn, ms: d.ms, outcome: d.outcome }
    : { surface: 'minecraft', path: 'in_game', turn: d.turn, ms: d.ms, outcome: d.outcome, ...(d.via ? { via: d.via } : {}) };
}

/** One chat turn's clock (main side). Every method after the first that resolves is a no-op. */
export interface ChatReplyClock {
  /** A companion bubble reached the renderer. */
  replied(): void;
  /** The turn ended: the send's result or rejection. */
  settle(result: { replies: unknown[]; routed?: boolean } | null, err?: unknown): void;
}

export function isChatAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string } | null;
  return e?.code === 'CHAT_ABORTED' || e?.message === 'CHAT_ABORTED' || e?.name === 'AbortError';
}

export function startChatReplyClock(opts: {
  turn: number;
  startedAt: number;
  now?: () => number;
  record?: (s: ReplyLatencySample) => void;
}): ChatReplyClock {
  const now = opts.now ?? Date.now;
  const record = opts.record ?? ((s: ReplyLatencySample) => recordReplyLatency(s));
  let done = false;
  const finish = (outcome: ReplyOutcome): void => {
    if (done) return;
    done = true;
    record({ surface: 'chat', path: 'app', turn: opts.turn, ms: now() - opts.startedAt, outcome });
  };
  return {
    replied: () => finish('replied'),
    settle: (result, err) => {
      if (done) return;
      if (result) {
        // Routed into a live game: the bot times that wait (origin 'app').
        if (result.routed) {
          done = true;
          return;
        }
        finish(result.replies.length > 0 ? 'replied' : 'silent');
        return;
      }
      finish(isChatAbortError(err) ? 'aborted' : 'error');
    },
  };
}
