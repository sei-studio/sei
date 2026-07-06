/**
 * Call audio dressing (260705) — the two synthetic sounds around a voice call.
 *
 * Ringtone: a 4/4 bar of quarter-note sine dings — D, F#, D, rest — looping
 * while the call is dialing (D major, 120 BPM). Pickup answers with a quick
 * rising D→A eighth-note figure; hang-up mirrors it falling A→D. Distinctive
 * but tiny — WebAudio oscillators, no asset, no loop file.
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
// The call's sounds live in D major (260705 spec): the ring walks D–F#–D,
// pickup answers with D→A rising, hang-up closes with A→D falling.
const D5 = 587.33;
const FSHARP5 = 739.99;
const A5 = 880;
// 4/4 at 120 BPM: quarter = 500ms → one bar (D, F#, D, rest) = 2s loop.
const QUARTER_MS = 500;
const RING_PERIOD_MS = QUARTER_MS * 4;

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

/** Connected: one quick rising eighth-note pair, D → A — the line opening. */
export function playConnectedChime(): void {
  oneShot((ctx) => {
    const t = ctx.currentTime + 0.02;
    ding(ctx, D5, t, 0.16);
    ding(ctx, A5, t + 0.13, 0.32);
    return 550;
  });
}

/** Hang-up chime: the pickup figure mirrored — A → D falling. Plays for BOTH
 * hang-up paths (player button and the companion's end_call), from its own
 * context so call teardown can't clip it. */
export function playHangupChime(): void {
  oneShot((ctx) => {
    const t = ctx.currentTime + 0.02;
    ding(ctx, A5, t, 0.16);
    ding(ctx, D5, t + 0.13, 0.36);
    return 600;
  });
}

/** Mute/unmute: kept simple — one short noise tick (a mechanical click),
 * filtered darker for mute and brighter for unmute so the direction is felt
 * without any melodic content competing with the call chimes. */
export function playMuteClick(muted: boolean): void {
  oneShot((ctx) => {
    const t = ctx.currentTime + 0.01;
    const len = Math.floor(ctx.sampleRate * 0.014);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = muted ? 900 : 2200;
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0.14;
    src.connect(bp);
    bp.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    return 120;
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

  // One 4/4 bar per loop: D, F#, D, rest — quarter notes.
  const ring = (): void => {
    if (stopped) return;
    const t = ctx.currentTime + 0.02;
    ding(ctx, D5, t, 0.45);
    ding(ctx, FSHARP5, t + QUARTER_MS / 1000, 0.45);
    ding(ctx, D5, t + (2 * QUARTER_MS) / 1000, 0.45);
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
