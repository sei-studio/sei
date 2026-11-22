/**
 * Call setup failure reasons (261023), for the `surface_error
 * {error_class: 'call_setup_failed'}` analytics event.
 *
 * Until this the event carried only the class token, so "1 in 15 Windows
 * callers cannot start a call" could not be split into a denied mic, a mic
 * another app holds, a missing mic, or a speech model that never loaded. Each
 * step of the call pipeline (dictation.ts) tags the error it throws with the
 * stage it failed in, and this module turns that into two coarse, fixed-vocab
 * properties:
 *
 *   stage       which step failed (CALL_SETUP_STAGES).
 *   error_name  the error's `name`, only when it is one of KNOWN_ERROR_NAMES
 *               (the DOMException names getUserMedia / Web Audio / workers
 *               throw, plus the few dictation.ts sets itself). Anything else
 *               reads 'other'.
 *
 * Never the error message, a device label or a device id: messages can carry
 * paths and driver strings, and labels name the player's hardware.
 */

export const CALL_SETUP_STAGES = [
  /** getUserMedia refused: OS privacy switch, or the permission handler. */
  'mic_permission',
  /** getUserMedia failed for any other reason: no mic, the mic is held by
   * another app, a driver that will not open. */
  'mic_capture',
  /** The mic opened, but the Web Audio graph around it did not
   * (AudioContext, the capture worklet). */
  'audio_graph',
  /** The local speech model (Whisper worker) failed to start or load. */
  'stt_boot',
  /** The voice/TTS upstream refused (ElevenLabs key, voice library). */
  'tts_or_voice_connect',
  /** The Sei session or plan refused (signed out, no credits, rate gate). */
  'proxy_session',
  'other',
] as const;

export type CallSetupStage = (typeof CALL_SETUP_STAGES)[number];

/** Error names safe to send as-is. Everything else becomes 'other'. */
export const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  // getUserMedia / DOMException
  'NotAllowedError',
  'SecurityError',
  'NotFoundError',
  'NotReadableError',
  'OverconstrainedError',
  'AbortError',
  'NotSupportedError',
  'InvalidStateError',
  'InvalidAccessError',
  'NetworkError',
  'TimeoutError',
  'UnknownError',
  'OperationError',
  'EncodingError',
  'QuotaExceededError',
  'DataError',
  // plain JS
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  // set by dictation.ts on its own errors
  'WorkerLoadError',
  'ModelLoadError',
]);

const STAGE_KEY = '__seiCallSetupStage';

/**
 * Mark `err` as having failed at `stage` and return it (rethrow the result).
 * DOMExceptions are ordinary extensible objects, so the original error keeps
 * its name and message for the copy and the mic card. A non-object thrown
 * value is wrapped. The first tag wins, so an inner, more specific stage is
 * not overwritten by an outer catch.
 */
export function tagCallSetupStage(err: unknown, stage: CallSetupStage): unknown {
  const target: object =
    err !== null && (typeof err === 'object' || typeof err === 'function')
      ? (err as object)
      : new Error(String(err));
  try {
    if (!(STAGE_KEY in target)) {
      Object.defineProperty(target, STAGE_KEY, { value: stage, enumerable: false, configurable: true });
    }
  } catch {
    /* frozen error object: the classifier falls back to its name rules */
  }
  return target;
}

/** The stage a tagged error carries, or null. */
export function taggedStage(err: unknown): CallSetupStage | null {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return null;
  const v = (err as Record<string, unknown>)[STAGE_KEY];
  return typeof v === 'string' && (CALL_SETUP_STAGES as readonly string[]).includes(v)
    ? (v as CallSetupStage)
    : null;
}

function errorName(err: unknown): string {
  const raw = (err as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && KNOWN_ERROR_NAMES.has(raw) ? raw : 'other';
}

function errorMessage(err: unknown): string {
  return String((err as { message?: unknown } | null)?.message ?? err ?? '');
}

/** A getUserMedia refusal: the same rule isPermissionRefusal applies. */
function looksLikeRefusal(name: string, msg: string): boolean {
  return name === 'NotAllowedError' || name === 'SecurityError' || /permission/i.test(msg);
}

/**
 * The analytics props for a failed call start. Pure; never throws.
 *
 * A tagged stage wins, with one refinement: dictation.ts tags every
 * getUserMedia failure mic_capture, and the ones that are refusals (the same
 * rule isPermissionRefusal applies, which decides the mic card) report
 * mic_permission instead. Untagged
 * errors are classified by the proxy/voice sentinels friendlyError already
 * knows, then by name.
 */
export function callSetupFailureProps(err: unknown): { stage: CallSetupStage; error_name: string } {
  const name = errorName(err);
  const rawName = String((err as { name?: unknown } | null)?.name ?? '');
  const msg = errorMessage(err);
  const tagged = taggedStage(err);
  if (tagged) {
    if (tagged === 'mic_capture' && looksLikeRefusal(rawName, msg)) {
      return { stage: 'mic_permission', error_name: name };
    }
    return { stage: tagged, error_name: name };
  }
  if (/VOICE_NO_SESSION|VOICE_NO_CREDITS|VOICE_RATE_LIMITED|VOICE_NOT_CONFIGURED|PROXY_/.test(msg)) {
    return { stage: 'proxy_session', error_name: name };
  }
  if (/VOICE_ELEVEN_|VOICE_NEEDS_PAID_PLAN|VOICE_NOT_IN_LIBRARY/.test(msg)) {
    return { stage: 'tts_or_voice_connect', error_name: name };
  }
  if (looksLikeRefusal(rawName, msg)) return { stage: 'mic_permission', error_name: name };
  if (rawName === 'NotFoundError' || rawName === 'NotReadableError' || rawName === 'OverconstrainedError') {
    return { stage: 'mic_capture', error_name: name };
  }
  return { stage: 'other', error_name: name };
}




