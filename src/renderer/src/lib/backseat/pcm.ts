/**
 * Backseat PCM math (260728) — pure functions, no audio APIs, fully testable.
 *
 * Both audio sources (the Windows loopback track read through
 * MediaStreamTrackProcessor, and the macOS ScreenCaptureKit tap relayed over
 * IPC) are normalized here into the ONE format everything downstream consumes:
 * mono Float32 at STT_SAMPLE_RATE. The gain meter, the jolt trigger's gain arm,
 * and the Whisper chunker all read that stream and nothing else, which is what
 * keeps the platform difference contained to the source.
 */

/**
 * Downmix interleaved multi-channel PCM to mono by averaging channels.
 * A no-op copy when channels === 1.
 */
export function downmixInterleaved(input: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return input.slice();
  const frames = Math.floor(input.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += input[f * channels + c];
    out[f] = sum / channels;
  }
  return out;
}

/**
 * Resample mono PCM by linear interpolation, with a boxcar pre-average when
 * downsampling by 2x or more (48k -> 16k is the common case) as a crude
 * anti-alias filter. Not audiophile resampling and does not need to be:
 * Whisper is robust to it, and the gain meter only wants energy.
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  let src = input;
  let rate = fromRate;
  // Halve with a 2-sample average while still at least 2x over the target;
  // 48k -> 24k, then interpolate 24k -> 16k.
  while (rate >= toRate * 2) {
    const half = new Float32Array(Math.floor(src.length / 2));
    for (let i = 0; i < half.length; i++) half[i] = (src[i * 2] + src[i * 2 + 1]) / 2;
    src = half;
    rate = rate / 2;
  }
  const outLen = Math.max(1, Math.round((src.length * toRate) / rate));
  const out = new Float32Array(outLen);
  const step = src.length / outLen;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

/** RMS of a PCM window in dBFS (-100..0), the unit the jolt trigger uses. */
export function rmsDb(samples: Float32Array): number {
  if (!samples.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}
