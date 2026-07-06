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

/** Schedule one soft sine "ding" — THE call instrument (ring + hang-up share
 * it so the call's sounds feel like one device). */
function ding(ctx: AudioContext, freq: number, at: number, dur: number, gain = RING_GAIN): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** Play a one-shot through a throwaway AudioContext that closes itself. */
function oneShot(build: (ctx: AudioContext) => number): void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  const totalMs = build(ctx);
  window.setTimeout(() => void ctx.close().catch(() => {}), totalMs + 150);
}

/** Hang-up chime: the ringtone's instrument, inverted and settled — D5 → G4,
 * a closing "dun-dun". Plays for BOTH hang-up paths (player button and the
 * companion's end_call), from its own context so call teardown can't clip it. */
export function playHangupChime(): void {
  oneShot((ctx) => {
    const t = ctx.currentTime + 0.02;
    ding(ctx, 587, t, 0.26); // D5
    ding(ctx, 392, t + 0.16, 0.5); // G4
    return 750;
  });
}

/** Mute/unmute click: a tiny noise tick plus a pitch blip — down for muted,
 * up for live again — so the state change is felt without looking. */
export function playMuteClick(muted: boolean): void {
  oneShot((ctx) => {
    const t = ctx.currentTime + 0.01;
    // 12ms noise tick (the mechanical "click").
    const len = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.value = 0.09;
    src.connect(hp);
    hp.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    // Pitch blip under it: direction encodes the new state.
    ding(ctx, muted ? 620 : 980, t + 0.004, 0.09, 0.05);
    return 200;
  });
}

export function startRingtone(): StopFn {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => {};
  }
  let timer: number | null = null;
  let stopped = false;

  const ring = (): void => {
    if (stopped) return;
    const t = ctx.currentTime + 0.02;
    ding(ctx, 784, t, 0.28); // G5
    ding(ctx, 587, t + 0.17, 0.42); // D5
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
