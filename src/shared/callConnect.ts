/**
 * Call connect timing for `voice_call_ended` (261127, O5 speed, T563).
 *
 * reply_latency times every turn of a call, but nothing timed the CONNECT:
 * from the Call press to the line going live, and on to the companion's first
 * audible word. These are that answer. Integer ms from the press (the
 * renderer's dialStart), each absent when the call never got there, so a
 * missing phase is never sent as 0:
 *
 *   mic_permission_ms  the mic permission preflight answered
 *   setup_reads_ms     the call-start reads finished (config, ElevenLabs key
 *                      status, speech pack status: they pick the STT and TTS
 *                      routes)
 *   mic_open_ms        the mic stream opened (getUserMedia; the ring starts here)
 *   stt_ready_ms       speech recognition is up (the local model loaded when the
 *                      policy boots one, and the capture graph built)
 *   greet_request_ms   main sent the greeting's LLM request (app greetings only:
 *                      plan read, prompt build, provider setup before it)
 *   greet_ready_ms     the greeting's first line reached the renderer (the
 *                      dialed companion's first line before the player spoke;
 *                      after a greeting_timeout connect it lands after connect_ms)
 *   connect_ms         the call went live (stopwatch start, connected chime)
 *   opener_tts_ms      the opener's TTS was requested. Since 261128 (T571) a
 *                      greeting buffered by connect is requested AT connect
 *                      and synthesizes during the pickup beat, so this equals
 *                      connect_ms; a line that lands later is requested when
 *                      it is queued (equal to opener_queued_ms)
 *   opener_queued_ms   the buffered opener was handed to the audio queue
 *                      (connect plus the pickup beat, or a call scene's
 *                      walk-on); before T571 its TTS request went out here
 *   first_line_ms      the companion's first clip became audible, before the
 *                      player said anything (so it is the opener)
 *
 * Plus three small enums:
 *   gate       what the connect waited on last: 'ring' (the minimum ring),
 *              'setup' (mic + speech recognition), 'greeting' (the opener
 *              arrived last) or 'greeting_timeout' (no line by the cap, so it
 *              connected on silence)
 *   greet_path 'app' (a standalone greeting turn in main) or 'in_game' (the
 *              live bot greets over its port)
 *   stt_local  the STT policy's local model ('none' = cloud only, 'eager' =
 *              a local model boots at dial)
 *
 * Only the companion that was DIALED carries them (a group joiner is live the
 * moment it lands, there is nothing to time), and only on the renderer's
 * hang-up report, like the interrupt counts: a call main closes itself (quit,
 * account switch) has none. Shape only: numbers and the enums above.
 */

export const CALL_CONNECT_PHASES = [
  'mic_permission_ms',
  'setup_reads_ms',
  'mic_open_ms',
  'stt_ready_ms',
  'greet_request_ms',
  'greet_ready_ms',
  'connect_ms',
  'opener_tts_ms',
  'opener_queued_ms',
  'first_line_ms',
] as const;

export type CallConnectPhase = (typeof CALL_CONNECT_PHASES)[number];

export const CALL_CONNECT_GATES = ['ring', 'setup', 'greeting', 'greeting_timeout'] as const;
export type CallConnectGate = (typeof CALL_CONNECT_GATES)[number];

export const CALL_GREET_PATHS = ['app', 'in_game'] as const;
export type CallGreetPath = (typeof CALL_GREET_PATHS)[number];

export const CALL_STT_LOCAL = ['none', 'eager'] as const;
export type CallSttLocal = (typeof CALL_STT_LOCAL)[number];

/** Longest phase that is still a real measurement (10 min); longer is dropped. */
export const CALL_CONNECT_MAX_MS = 600_000;

export type CallConnectTiming = Partial<Record<CallConnectPhase, number>> & {
  gate?: CallConnectGate;
  greet_path?: CallGreetPath;
  stt_local?: CallSttLocal;
};

function validMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CALL_CONNECT_MAX_MS;
}

/**
 * Main's read of the renderer's report: unknown keys, wrong types and
 * out-of-range values are dropped one by one, so a bad field can never fail
 * the hang-up report (which also posts the call row). undefined = nothing valid.
 */
export function sanitizeCallConnect(raw: unknown): CallConnectTiming | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: CallConnectTiming = {};
  for (const k of CALL_CONNECT_PHASES) {
    const v = r[k];
    if (validMs(v)) out[k] = v;
  }
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  const gate = pick(r.gate, CALL_CONNECT_GATES);
  const greetPath = pick(r.greet_path, CALL_GREET_PATHS);
  const sttLocal = pick(r.stt_local, CALL_STT_LOCAL);
  if (gate) out.gate = gate;
  if (greetPath) out.greet_path = greetPath;
  if (sttLocal) out.stt_local = sttLocal;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The `voice_call_ended` props. `connect_ms` and `first_line_ms` keep their
 * own names (the two headline numbers); every other phase and enum is
 * prefixed `connect_` so they group in the dashboard. Anything missing or out
 * of range is left out, never sent as 0.
 */
export function callConnectProps(t: CallConnectTiming | undefined): Record<string, number | string> {
  const c = sanitizeCallConnect(t);
  if (!c) return {};
  const out: Record<string, number | string> = {};
  for (const k of CALL_CONNECT_PHASES) {
    const v = c[k];
    if (v === undefined) continue;
    out[k === 'connect_ms' || k === 'first_line_ms' ? k : `connect_${k}`] = v;
  }
  if (c.gate) out.connect_gate = c.gate;
  if (c.greet_path) out.connect_greet_path = c.greet_path;
  if (c.stt_local) out.connect_stt_local = c.stt_local;
  return out;
}
