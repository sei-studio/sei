/**
 * voice_tts_failed (261121, T507): a companion line that could not be voiced.
 *
 * Before this, only a failure INSIDE an open stream reported anything
 * (surface_error tts_stream_*). A line whose request failed before any audio
 * arrived (fetch error, upstream status, connect timeout) or whose whole-clip
 * fetch failed was invisible, which is how a user whose connection cut off
 * every TTS transfer looked like a healthy call in analytics.
 *
 * Shape only: phase, provider and a short error class. Never the text, the
 * voice, or the raw error message.
 */
import { surfaceErrorClass } from '../surfaceErrorClass';
import { loadAnalytics } from '../lazyAnalytics';

/** Which synthesis path the failed line was on. */
export type TtsProvider =
  /** Sei's cloud voices through the proxy (api.sei.gg/tts/speech). */
  | 'sei_cloud'
  /** "Sei voices" on the ChatGPT plan (proxy, on-device fallback). */
  | 'sei_voices'
  /** ElevenLabs direct with the user's (or the dev) key. */
  | 'elevenlabs_key'
  /** Fish Audio as the local engine (user's key). */
  | 'fish'
  /** Fish Audio picked on a cloud account. */
  | 'fish_cloud'
  /** On-device voice packs (Fast / Kokoro). */
  | 'local'
  /** BYOK on the ElevenLabs engine with no key and no local pack. */
  | 'unconfigured'
  | 'unknown';

/**
 * pre_audio: the request failed before the first audio byte (stream path).
 * mid_stream: the stream failed after some audio had arrived.
 * clip: a whole-clip fetch failed (short lines, local voices).
 */
export type TtsFailurePhase = 'pre_audio' | 'mid_stream' | 'clip';

/** Mutable trace a synthesis call fills in as it picks its route, so the
 * failure report names the provider that actually failed. */
export interface TtsTrace {
  provider: TtsProvider;
}

export function newTtsTrace(): TtsTrace {
  return { provider: 'unknown' };
}

/**
 * The error_class for a failed line, or null when the "failure" is not one
 * (a companion with no voice). Our own sentinels first, then an upstream
 * status, then the shared transport classifier. An abort is the stall
 * watchdog inside a stream, and the connect / first-byte deadline before one;
 * nothing else aborts a TTS request.
 */
export function ttsFailureClass(err: unknown, inBody: boolean): string | null {
  const msg = String((err as Error)?.message ?? err ?? '');
  if (msg.startsWith('VOICE_DISABLED')) return null;
  if (msg.startsWith('VOICE_NO_CREDITS')) return 'no_credits';
  if (msg.startsWith('VOICE_RATE_LIMITED')) return 'rate_limited';
  if (msg.startsWith('VOICE_NO_SESSION')) return 'no_session';
  if (msg.startsWith('VOICE_NOT_CONFIGURED')) return 'not_configured';
  if (msg.startsWith('VOICE_PACK_MISSING')) return 'pack_missing';
  if (msg.startsWith('SPEECH_RUNTIME_FAILED')) return 'speech_runtime';
  if (msg.startsWith('VOICE_NOT_IN_LIBRARY') || msg.startsWith('VOICE_LIBRARY_UNAVAILABLE')) {
    return 'voice_unavailable';
  }
  if (msg.startsWith('VOICE_NEEDS_PAID_PLAN')) return 'needs_paid_plan';
  if (msg.startsWith('VOICE_ELEVEN_QUOTA')) return 'payment_required';
  if (msg.startsWith('VOICE_ELEVEN_KEY_INVALID')) return 'auth';
  const status = /\bstatus (\d{3})\b/.exec(msg)?.[1];
  if (status) {
    const n = Number(status);
    if (n >= 500) return 'server_error';
    if (n === 401 || n === 403) return 'auth';
    if (n === 408 || n === 504) return 'timeout';
    if (n === 413) return 'request_too_large';
    return 'http_4xx';
  }
  const cls = surfaceErrorClass(err);
  if (cls === 'aborted') return inBody ? 'stall' : 'timeout';
  return cls;
}

/** Repeats of the same (phase, provider, class) within this window ship as
 * one event with `repeat_count`: a broken connection fails every line of a
 * call, and one event per line would bury everything else. */
const TTS_FAIL_THROTTLE_MS = 5 * 60_000;

/** Fire-and-forget report of one failed line. `inBody`: the failure came
 * from reading an open stream's body (an abort there is the stall watchdog).
 * Never throws. */
export function reportTtsFailure(
  phase: TtsFailurePhase,
  provider: TtsProvider,
  err: unknown,
  inBody = false,
): void {
  const errorClass = ttsFailureClass(err, inBody);
  if (!errorClass) return;
  void (async () => {
    try {
      const { captureDiagnosticThrottled } = await loadAnalytics();
      captureDiagnosticThrottled(
        'voice_tts_failed',
        `${phase}|${provider}|${errorClass}`,
        { phase, provider, error_class: errorClass },
        TTS_FAIL_THROTTLE_MS,
      );
    } catch {
      /* analytics is never load-bearing */
    }
  })();
}




