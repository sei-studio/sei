/**
 * Local pitch shifting for companion speech (260731).
 *
 * WHY THIS EXISTS. ElevenLabs has no pitch parameter, so a "high, clearly AI"
 * voice used to be built from two halves that had to cancel: synthesis asked
 * for `voice_settings.speed = 1/rate` (main) and playback ran the clip at
 * `playbackRate = rate` with preservesPitch OFF (renderer), which raises pitch
 * and pace together. The resample is exact arithmetic. The speed compensation
 * is a MODEL CONDITIONING HINT, and a short utterance gives the model almost no
 * room to express it — so on "oh." or "yeah?" the compensation under-delivered
 * while the resample applied at full strength, and the line came out fast. That
 * was structural, not a glitch, and no tuning fixes it.
 *
 * So the shift happens here instead: one AudioWorklet, duration-preserving, on
 * clips synthesized at their natural pace. Nothing about pitch reaches the TTS
 * request any more.
 *
 * WHAT IT SOUNDS LIKE. Formant compensation is deliberately OFF. A phase
 * vocoder with formants left alone moves them WITH the pitch, which is exactly
 * what the old resample did, so every existing character sounds identical to
 * before — same timbre, same stored voicePitch, just the right pace now. Turning
 * it on would give "same person, higher voice", a real option worth having, but
 * not one to slip in under a migration whose whole point is that nothing
 * audible changes except the bug.
 *
 * THE CONTEXT IS SHARED AND THE NODE IS WARMED LATE. Opening the mic with
 * echoCancellation makes Chromium reroute the page's whole audio output, and a
 * node built across that switch comes up attached to an output being torn down
 * (see voiceAudio.ts whenSteady, and the ring bug it was written for). So the
 * bus takes the same context every call sound uses, and builds behind the same
 * gate — warmed from the ring, which fires after the mic is up, not from dial.
 *
 * READINESS IS SYNCHRONOUS ON PURPOSE. The audio queue starts clips from
 * synchronous code paths, and threading a promise through them would put an
 * await in front of every reply. warm() is fire-and-forget at call start and
 * the WASM is ready long before the first TTS lands; attach() simply reports
 * null when it is not, and the caller plays unshifted.
 */
import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';
import { sharedContext, whenSteady } from './voiceAudio';

/**
 * STFT block length, which IS the added latency: measured in Chromium, the
 * node reports latency() == blockMs exactly, at every size tried.
 *
 * That latency lands between the element's 'playing' event and the first sample
 * the player hears, so it offsets everything downstream of onAudible — the
 * avatar ring, the caption, a call scene's talking animation, the barge-in
 * grace window (260730 tuned all of those). The library's 120ms default is more
 * than that budget wants.
 *
 * Shorter is not free, though. Measured against a 220 Hz tone, the delivered
 * shift drifts SHARP as the block shrinks: at rate 1.4 the error is +22 cents
 * at 40-50ms, +11 at 80ms, +3 at 90ms.
 *
 * 50ms, because those two costs are not comparable. A quarter semitone against
 * a shift of nearly six is inaudible, and no listener has a reference for what
 * a synthetic voice "should" be tuned to. The delay is not inaudible: measured
 * end to end on the real graph (<audio> -> source -> shifter -> output, first
 * sample over the noise floor), time to first sound goes 38ms -> 116ms at
 * blockMs 80. This one constant is the whole of it, so 50ms buys 30ms back
 * against an error nobody can hear.
 *
 * Re-measure both before moving it; the tuning curve is not monotonic.
 */
const BLOCK_MS = 50;

/** rate 1.224 (Sui) = +3.5 semitones. Storage stays a playback-rate multiplier
 * so no character metadata has to migrate; the conversion lives here, at the
 * one boundary that cares. */
export function semitonesFromRate(rate: number): number {
  return 12 * Math.log2(rate);
}

let node: StretchNode | null = null;
let building = false;
/**
 * The rate currently scheduled on the node, so back-to-back clips at the same
 * pitch (every clip of a one-companion call) do not re-schedule for nothing.
 *
 * ONE node serves every speaker, which is fine because the queue plays clips
 * strictly in sequence. The seam is a group call where two companions have
 * different pitches: the change is scheduled the moment the next clip attaches,
 * so up to BLOCK_MS of the previous speaker's tail is still in the node and
 * comes out at the new pitch. 80ms of one trailing syllable, at a hand-off the
 * player is already hearing as a hand-off.
 */
let scheduledRate = 1;

/** Sources are per-clip and must be disconnected with their element, or the
 * graph accumulates a dead MediaElementAudioSourceNode per line spoken. */
const attached = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

/**
 * Build the shifter, once, when the output is genuinely rendering. Safe to call
 * repeatedly (every dial does). Failure is silent and permanent for the
 * session: attach() keeps returning null and speech plays unshifted, which is
 * the honest degradation — see attach().
 */
export function warm(): void {
  if (node || building) return;
  const ctx = sharedContext();
  if (!ctx) return;
  building = true;
  whenSteady(ctx, () => {
    void SignalsmithStretch(ctx)
      .then((n: StretchNode) => {
        n.configure({ blockMs: BLOCK_MS });
        n.connect(ctx.destination);
        n.start();
        node = n;
      })
      .catch((err: unknown) => {
        console.warn('[sei/voice] pitch shifter unavailable, speech plays unshifted', err);
      })
      .finally(() => {
        building = false;
      });
  });
}

/** Whether attach() can shift right now (the queue asks before it plays). */
export function ready(): boolean {
  return node !== null;
}

/**
 * Warm, then resolve when the shifter is usable — or false if it is not within
 * `timeoutMs`. For callers that CAN wait a moment and would rather not play the
 * wrong thing: the voice picker, where an unshifted sample is not a slightly
 * flat call, it is the slider appearing to do nothing. The audio queue must not
 * use this; a reply that waits on a worklet is worse than a reply in the
 * character's own pitch.
 */
export function whenReady(timeoutMs = 1500): Promise<boolean> {
  warm();
  if (node) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (node) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

/**
 * Route `el` through the shifter at `rate` (1 = as recorded). Returns a detach
 * to call when the clip is torn down, or null when the shift cannot be applied
 * — the caller then plays the element normally, at its natural pitch AND pace.
 *
 * Unshifted is the right fallback rather than the old resample: with no pace
 * compensation left in the synthesis request, resampling would play the clip
 * `rate` times too fast, which is the exact bug this file removes, at full
 * strength. A companion in their own voice is a smaller wrong than a companion
 * talking too fast.
 */
export function attach(el: HTMLAudioElement, rate: number): (() => void) | null {
  const ctx = sharedContext();
  if (!ctx || !node || rate === 1) return null;
  // An element can only ever be the source of ONE MediaElementAudioSourceNode;
  // a second createMediaElementSource on it throws. The queue builds a fresh
  // element per clip, so this is a guard rather than a path we expect to take.
  if (attached.has(el)) return null;
  let src: MediaElementAudioSourceNode;
  try {
    src = ctx.createMediaElementSource(el);
  } catch (err) {
    console.warn('[sei/voice] could not route clip through the pitch shifter', err);
    return null;
  }
  attached.set(el, src);
  if (rate !== scheduledRate) {
    scheduledRate = rate;
    // formantCompensation stays off — see the file header.
    node.schedule({ semitones: semitonesFromRate(rate), formantCompensation: false });
  }
  src.connect(node);
  return () => {
    try {
      src.disconnect();
    } catch {
      /* context torn down under us */
    }
    attached.delete(el);
  };
}
