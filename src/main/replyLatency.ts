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
 *   - voice only (261123, O5), integer ms from the dispatched utterance, each
 *     absent when the turn never got there (see lib/voice/replyClock.ts):
 *     `speech_end_to_final_ms` (player's last voiced frame -> dispatch, i.e.
 *     end-of-speech wait + STT + echo gate; BEFORE `ms` starts),
 *     `llm_request_ms` (LLM request sent), `llm_first_token_ms` (first reply
 *     text token), `line_queued_ms` (first line handed to TTS),
 *     `tts_first_chunk_ms` (its first audio bytes in the renderer). `ms`
 *     minus tts_first_chunk_ms is decode and playback start.
 *   - minecraft, and chat on the in_game path (261126, O5): BOT_PHASE_KEYS +
 *     `busy_at_line`, timed in the bot from the player line (see below).
 *   - chat, app path only (261125, O5): CHAT_PHASE_KEYS, ms from the
 *     chat:send handler entry. NOTE the endpoints differ from voice: chat
 *     `ms` ends when the WHOLE reply is back (typed chat never streams its
 *     bubbles), voice `ms` at the first audible sample of the first streamed
 *     sentence. Compare llm_* phases across surfaces, not `ms`.
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

/** Voice-turn phase offsets (261123), ms from the dispatched utterance. */
export const VOICE_PHASE_KEYS = [
  'speech_end_to_final_ms',
  'llm_request_ms',
  'llm_first_token_ms',
  'line_queued_ms',
  'tts_first_chunk_ms',
] as const;
export type VoicePhaseKey = (typeof VOICE_PHASE_KEYS)[number];
export type VoicePhases = Partial<Record<VoicePhaseKey, number>>;

/**
 * Typed-chat phase offsets (261125, O5), ms from the chat:send handler entry
 * (the same start as `ms`), each absent when the turn never got there. The
 * llm_* keys mean what they mean on voice. Typed chat does not stream on
 * Anthropic (cloud, BYOK), so there `llm_first_token_ms` is absent and
 * `llm_response_ms - llm_request_ms` is the whole model round trip; the
 * ChatGPT plan streams, so it has both.
 *   - `prompt_start_ms`   prompt assembly begins (routing checks, character +
 *                         config read, the player's row written)
 *   - `lan_check_ms`      the fresh world-detection pass finished (it runs
 *                         alongside the prompt build since 261125)
 *   - `prompt_built_ms`   the prompt is ready (reads, system blocks, notes)
 *   - `provider_ready_ms` the LLM provider is built (session read, SDK client,
 *                         the ChatGPT plan's model lookup)
 *   - `llm_request_ms`    the first LLM request went out
 *   - `llm_first_token_ms` first reply text token (streaming transports only)
 *   - `llm_response_ms`   the response that carried the first shown bubble
 *   - `llm_calls`         LLM round trips before it (a COUNT, not ms: tool hops)
 * `ms - llm_response_ms` is our post-processing (split, persist, stamp).
 */
export const CHAT_PHASE_KEYS = [
  'prompt_start_ms',
  'lan_check_ms',
  'prompt_built_ms',
  'provider_ready_ms',
  'llm_request_ms',
  'llm_first_token_ms',
  'llm_response_ms',
  'llm_calls',
] as const;
export type ChatPhaseKey = (typeof CHAT_PHASE_KEYS)[number];
export type ChatPhases = Partial<Record<ChatPhaseKey, number>>;

/**
 * Bot-timed turn phases (261126, O5, T554): a minecraft sample, or a Sei chat
 * routed into a live game (surface chat, path in_game). Measured in the bot
 * (brain/actionStats.js), integer ms from the player line's arrival (the same
 * start as `ms`), each absent when the turn never got there:
 *   - `dispatch_ms`          the brain picked the line up (FSM dispatch, or a
 *                            preempt folding it into a parked call)
 *   - `llm_request_ms`       the first LLM request after the line went out
 *   - `llm_last_request_ms`  the request whose response carried the reply
 *   - `llm_response_ms`      that response arrived (absent when the reply went
 *                            out mid-stream: a voice-call early say())
 *   - `llm_model_ms`         total time an LLM call was in flight inside the
 *                            wait. `ms - llm_model_ms` is client time:
 *                            queueing, turn builds, inline tools (web search
 *                            included), emit
 *   - `llm_calls`            COUNT of LLM requests after the line, the reply's
 *                            own included (tool rounds, retries)
 *   - `llm_aborted`          COUNT of calls in the wait that were aborted or
 *                            timed out (preempt restarts, timeout retries)
 *   - `llm_rate_limited`     COUNT of calls the bot's client-side rate limit
 *                            dropped in the wait (no request went out)
 * plus `busy_at_line` (BOT_BUSY_AT_LINE): what the brain was doing when the
 * line came in.
 */
export const BOT_PHASE_KEYS = [
  'dispatch_ms',
  'llm_request_ms',
  'llm_last_request_ms',
  'llm_response_ms',
  'llm_model_ms',
  'llm_calls',
  'llm_aborted',
  'llm_rate_limited',
] as const;
export type BotPhaseKey = (typeof BOT_PHASE_KEYS)[number];
export type BotPhases = Partial<Record<BotPhaseKey, number>>;
export const BOT_BUSY_AT_LINE = ['idle', 'llm', 'action', 'turn'] as const;
export type BotBusyAtLine = (typeof BOT_BUSY_AT_LINE)[number];

export interface ReplyLatencySample {
  surface: ReplySurface;
  path: ReplyPath;
  /** 1-based turn number within the surface's session. */
  turn: number;
  ms: number;
  outcome: ReplyOutcome;
  via?: ReplyVia;
  /**
   * Where the turn's time went: voice (VOICE_PHASE_KEYS), app-path chat
   * (CHAT_PHASE_KEYS) or a bot-timed turn (BOT_PHASE_KEYS).
   */
  phases?: VoicePhases | ChatPhases | BotPhases;
  /** Bot-timed turns only: what the brain was doing when the line came in. */
  busyAtLine?: BotBusyAtLine;
}

function clampMs(v: number): number {
  return Math.min(REPLY_MS_MAX, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));
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
  const props: Record<string, string | number> = {
    surface: s.surface,
    path: s.path,
    ms: clampMs(s.ms),
    outcome: s.outcome,
    turn_index_bucket: turnIndexBucket(s.turn),
    sample_rate: rate,
    ...(s.surface === 'minecraft' && s.via ? { via: s.via } : {}),
  };
  const botTimed = s.surface === 'minecraft' || (s.surface === 'chat' && s.path === 'in_game');
  const keys: readonly string[] | null =
    s.surface === 'voice'
      ? VOICE_PHASE_KEYS
      : s.surface === 'chat' && s.path === 'app'
        ? CHAT_PHASE_KEYS
        : botTimed
          ? BOT_PHASE_KEYS
          : null;
  if (keys && s.phases) {
    const phases = s.phases as Record<string, number | undefined>;
    for (const k of keys) {
      const v = phases[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) props[k] = clampMs(v);
    }
  }
  if (botTimed && s.busyAtLine && (BOT_BUSY_AT_LINE as readonly string[]).includes(s.busyAtLine)) {
    props.busy_at_line = s.busyAtLine;
  }
  return props;
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
/** A bad phase drops only that phase, never the sample it rides on. */
const PhaseSchema = z.number().finite().min(0).optional().catch(undefined);

const RendererSampleSchema = z.object({
  surface: z.literal('voice'),
  path: z.enum(REPLY_PATHS),
  turn: TurnSchema,
  ms: MsSchema,
  outcome: z.enum(REPLY_OUTCOMES),
  speech_end_to_final_ms: PhaseSchema,
  llm_request_ms: PhaseSchema,
  llm_first_token_ms: PhaseSchema,
  line_queued_ms: PhaseSchema,
  tts_first_chunk_ms: PhaseSchema,
});

export function sanitizeRendererReplyLatency(raw: unknown): ReplyLatencySample | null {
  const r = RendererSampleSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const phases: VoicePhases = {};
  for (const k of VOICE_PHASE_KEYS) {
    const v = d[k];
    if (v !== undefined) phases[k] = v;
  }
  return {
    surface: d.surface,
    path: d.path,
    turn: d.turn,
    ms: d.ms,
    outcome: d.outcome,
    ...(Object.keys(phases).length ? { phases } : {}),
  };
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
  // 261126: phases (BOT_PHASE_KEYS). A bad one drops alone, never the sample.
  dispatch_ms: PhaseSchema,
  llm_request_ms: PhaseSchema,
  llm_last_request_ms: PhaseSchema,
  llm_response_ms: PhaseSchema,
  llm_model_ms: PhaseSchema,
  llm_calls: z.number().int().min(0).max(10_000).optional().catch(undefined),
  llm_aborted: z.number().int().min(0).max(10_000).optional().catch(undefined),
  llm_rate_limited: z.number().int().min(0).max(10_000).optional().catch(undefined),
  busy_at_line: z.enum(BOT_BUSY_AT_LINE).optional().catch(undefined),
});

export function parseBotReplyLatency(raw: unknown): ReplyLatencySample | null {
  const r = BotSampleSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const phases: BotPhases = {};
  for (const k of BOT_PHASE_KEYS) {
    const v = d[k];
    if (v !== undefined) phases[k] = v;
  }
  const extra = {
    ...(Object.keys(phases).length ? { phases } : {}),
    ...(d.busy_at_line ? { busyAtLine: d.busy_at_line } : {}),
  };
  // A chat typed in the app and answered by the live game session is still a
  // chat-surface wait (the reply shows in the chat window); its path says who
  // answered it.
  return d.origin === 'app'
    ? { surface: 'chat', path: 'in_game', turn: d.turn, ms: d.ms, outcome: d.outcome, ...extra }
    : { surface: 'minecraft', path: 'in_game', turn: d.turn, ms: d.ms, outcome: d.outcome, ...(d.via ? { via: d.via } : {}), ...extra };
}

/** One chat turn's clock (main side). Every method after the first that resolves is a no-op. */
export interface ChatReplyClock {
  /** A companion bubble reached the renderer. */
  replied(): void;
  /**
   * Stamp a phase (CHAT_PHASE_KEYS). `at` is a Date.now() wall-clock time
   * (default now), stored as ms since the clock started; `llm_calls` takes
   * the count itself. A later mark of the same key overwrites; marks after
   * the turn finished are ignored, so a phase always describes the wait the
   * player saw.
   */
  mark(key: ChatPhaseKey, at?: number): void;
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
  const phases: ChatPhases = {};
  const finish = (outcome: ReplyOutcome): void => {
    if (done) return;
    done = true;
    record({
      surface: 'chat',
      path: 'app',
      turn: opts.turn,
      ms: now() - opts.startedAt,
      outcome,
      ...(Object.keys(phases).length ? { phases: { ...phases } } : {}),
    });
  };
  return {
    replied: () => finish('replied'),
    mark: (key, at) => {
      if (done) return;
      if (key === 'llm_calls') {
        if (typeof at === 'number' && Number.isInteger(at) && at >= 0) phases.llm_calls = at;
        return;
      }
      const t = at ?? now();
      if (Number.isFinite(t)) phases[key] = Math.max(0, t - opts.startedAt);
    },
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
