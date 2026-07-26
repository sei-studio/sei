/**
 * Cloud/local STT arbitration (260724) — pure policy, no transport.
 *
 * Dictation runs BOTH transcribers on every utterance: the local Whisper
 * worker (tiny.en — fast, free, offline, weak) and cloud ElevenLabs Scribe
 * (accurate, needs network + session). The race policy keeps latency honest:
 *
 *   - Cloud finishes first → use it. (Common when tiny is chewing a long
 *     clip; cloud can be a net latency WIN.)
 *   - Local finishes first → give cloud one bounded grace window
 *     (graceMs), then stop waiting and use local. Cloud can never add more
 *     than graceMs over today's local-only latency.
 *   - Cloud errors or is unavailable (resolves null) → local, immediately if
 *     local already finished, else as soon as it does.
 *
 * A cloud result that arrives after local was delivered is discarded — a
 * spoken turn cannot be retracted. Cloud '' is trusted (Scribe judged the
 * clip non-speech); local tiny hallucinates on noise far more than Scribe
 * misses real words.
 *
 * 260725 cloud-only mode (`local: null`): the 'none' local-model policy —
 * no Whisper worker exists, so there is no fallback. Each cloud pass gets a
 * hard timeout (cloudTimeoutMs); a null/rejected/timed-out pass resolves ''
 * (the utterance is dropped upstream) and reports via onCloudFailure. A
 * cloud '' stays trusted non-speech and is NOT a failure.
 */

export type LocalTranscribe = (audio: Float32Array) => Promise<string>;
/** Resolves transcript text, or null when cloud could not produce one
 * (unavailable, transport error, timeout). Must not reject. */
export type CloudTranscribe = (audio: Float32Array) => Promise<string | null>;

/** Local finished; not a transcript. */
const LOCAL_DONE = Symbol('local-done');

/** cloud-only mode: default hard bound on a cloud pass before the utterance
 * is dropped. Generous — there is no local result waiting behind it. */
const DEFAULT_CLOUD_TIMEOUT_MS = 8_000;

export function createSttArbiter(opts: {
  /** null = cloud-only mode (the 'none' local-model policy). */
  local: LocalTranscribe | null;
  cloud: CloudTranscribe | null;
  graceMs: number;
  /** cloud-only mode: hard timeout per cloud pass. */
  cloudTimeoutMs?: number;
  /** cloud-only mode: the cloud pass produced no transcript (null, rejection,
   * or timeout) so the utterance was dropped. Fired per failed utterance —
   * the caller owns any once-per-call gating. */
  onCloudFailure?: () => void;
}): (audio: Float32Array) => Promise<string> {
  const cloudTimeoutMs = opts.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
  return async (audio: Float32Array): Promise<string> => {
    const { local, cloud } = opts;
    if (!local) {
      // Cloud-only: no worker, no fallback. '' (dropped upstream) is the only
      // graceful degradation; report the failure so the surface can offer the
      // local backup install.
      if (!cloud) {
        opts.onCloudFailure?.();
        return '';
      }
      const cloudP = cloud(audio).then(
        (t) => t,
        () => null,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), cloudTimeoutMs);
      });
      const outcome = await Promise.race([cloudP, timeout]);
      clearTimeout(timer);
      if (typeof outcome === 'string') return outcome; // '' stays trusted non-speech
      opts.onCloudFailure?.();
      return '';
    }
    const localP = local(audio);
    if (!cloud) return localP;
    // Never reject: a cloud transport bug must degrade to local, not break
    // the utterance.
    const cloudP = cloud(audio).then(
      (t) => t,
      () => null,
    );
    let outcome = await Promise.race([cloudP, localP.then(() => LOCAL_DONE)]);
    if (outcome === LOCAL_DONE) {
      // 260725: an EMPTY local result is worth nothing — delivering '' just
      // drops the utterance — so there is no latency to protect and the grace
      // window doesn't apply: wait for cloud outright. This is the laughter
      // path: tiny's noise filter eats a laugh ('' in well under the grace
      // window) while Scribe is still coming back with "(laughs)" → "haha".
      if ((await localP) === '') {
        const late = await cloudP;
        return typeof late === 'string' ? late : '';
      }
      // Local has real words — cloud gets graceMs more, not a moment longer.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<typeof LOCAL_DONE>((resolve) => {
        timer = setTimeout(() => resolve(LOCAL_DONE), opts.graceMs);
      });
      outcome = await Promise.race([cloudP, grace]);
      clearTimeout(timer);
    }
    return typeof outcome === 'string' ? outcome : localP;
  };
}
