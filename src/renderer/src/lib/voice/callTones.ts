/**
 * Call audio dressing (260705) — the two synthetic sounds around a voice call.
 *
 * Ringtone: a simple two-tone "da-ding" (G5 → D5 sines with a fast decay)
 * every 1.9s while the call is dialing. Distinctive but tiny — WebAudio
 * oscillators, no asset, no loop file.
 *
 * Ambience: the companion's TTS carries a faint encoder noise floor, so the
 * call alternated "static while talking / dead digital silence while not".
 * A constant, just-audible comfort-noise bed (looped brown-ish noise at
 * ~-45 dBFS) makes the line sound continuously "open" instead — the
 * transition disappears rather than the noise becoming noticeable.
 *
 * Both return a stop() that fully tears down their AudioContext; callers own
 * lifecycle (useVoiceStore: ring while 'connecting', ambience while 'live').
 */

export type StopFn = () => void;

const RING_GAIN = 0.055;
const RING_PERIOD_MS = 1900;

export function startRingtone(): StopFn {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  let timer: number | null = null;
  let stopped = false;

  const ding = (freq: number, at: number, dur: number): void => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(RING_GAIN, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  };

  const ring = (): void => {
    if (stopped) return;
    const t = ctx.currentTime + 0.02;
    ding(784, t, 0.28); // G5
    ding(587, t + 0.17, 0.42); // D5
    timer = window.setTimeout(ring, RING_PERIOD_MS);
  };
  ring();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    void ctx.close().catch(() => {});
  };
}

const AMBIENCE_GAIN = 0.0055;

export function startAmbience(): StopFn {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  // 2s of brown-ish noise (integrated white), looped. Loop-point click is
  // below audibility at this gain; the low-pass kills the hiss edge.
  const seconds = 2;
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const gain = ctx.createGain();
  // Fade in over ~0.4s so the bed slides under the call instead of clicking on.
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(AMBIENCE_GAIN, ctx.currentTime + 0.4);
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ctx.destination);
  src.start();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
    } catch {
      /* context already closing */
    }
    window.setTimeout(() => void ctx.close().catch(() => {}), 200);
  };
}
