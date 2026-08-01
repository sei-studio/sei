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
 * Both return a stop() that drops their own nodes; callers own lifecycle
 * (useVoiceStore: ring while 'connecting', ambience while 'live'). Neither
 * closes the AudioContext, which is shared and long-lived — see voiceAudio.ts.
 *
 * 260731: the context, its scheduling leads and the whenSteady gate moved to
 * voiceAudio.ts when the TTS pitch shifter needed all three. Nothing about them
 * changed; this file just stopped being their only user.
 */
import { sharedContext as audio, startTime, whenSteady } from './voiceAudio';

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
function ding(
  ctx: AudioContext,
  freq: number,
  at: number,
  dur: number,
  gain = RING_GAIN,
  out: AudioNode = ctx.destination,
): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
  osc.connect(g);
  g.connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/**
 * Play a one-shot on the shared context (which stays open — see audio()),
 * once the output is genuinely rendering. The connected chime fires moments
 * after the ring stops, still inside the window where a device switch can be
 * settling, so it gets the same gate; on a healthy context whenSteady costs
 * ~100ms, which nothing here is tight enough to notice.
 */
function oneShot(build: (ctx: AudioContext, t: number) => void): void {
  const ctx = audio();
  if (!ctx) return;
  whenSteady(ctx, () => build(ctx, startTime(ctx)));
}

/** Connected: one quick rising eighth-note pair, D → A — the line opening. */
export function playConnectedChime(): void {
  oneShot((ctx, t) => {
    ding(ctx, D5, t, 0.16);
    ding(ctx, A5, t + 0.13, 0.32);
  });
}

/** Hang-up chime: the pickup figure mirrored — A → D falling. Plays for BOTH
 * hang-up paths (player button and the companion's end_call); it outlives call
 * teardown because the shared context is never closed with the call. */
export function playHangupChime(): void {
  oneShot((ctx, t) => {
    ding(ctx, A5, t, 0.16);
    ding(ctx, D5, t + 0.13, 0.36);
  });
}

/** Mute/unmute: kept simple — one short noise tick (a mechanical click),
 * filtered darker for mute and brighter for unmute so the direction is felt
 * without any melodic content competing with the call chimes. */
export function playMuteClick(muted: boolean): void {
  oneShot((ctx, t) => {
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
  });
}

export function startRingtone(): StopFn {
  const ctx = audio();
  if (!ctx) return () => {};
  let timer: number | null = null;
  let stopped = false;
  // The ring's own bus: stopping used to close the context, which is no longer
  // ours to close (it is shared and stays open). Muting the bus silences the
  // notes already scheduled for the rest of the bar just as abruptly, and each
  // oscillator stops itself.
  const bus = ctx.createGain();
  bus.connect(ctx.destination);

  // One 4/4 bar per loop: D, F#, D, rest — quarter notes.
  const ring = (): void => {
    if (stopped) return;
    const t = startTime(ctx);
    ding(ctx, D5, t, 0.45, RING_GAIN, bus);
    ding(ctx, FSHARP5, t + QUARTER_MS / 1000, 0.45, RING_GAIN, bus);
    ding(ctx, D5, t + (2 * QUARTER_MS) / 1000, 0.45, RING_GAIN, bus);
    timer = window.setTimeout(ring, RING_PERIOD_MS);
  };
  // The FIRST bar waits for the output to be real (see whenSteady) — it is the
  // one that lands in the mic's echo-cancellation reroute and gets eaten.
  // Later bars are already past it and schedule straight off the loop timer.
  whenSteady(ctx, () => {
    if (!stopped) ring();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    try {
      bus.gain.setValueAtTime(0, ctx.currentTime);
    } catch {
      /* context gone */
    }
    // Outlive the longest scheduled note, then drop the node.
    window.setTimeout(() => bus.disconnect(), RING_PERIOD_MS + 500);
  };
}

const AMBIENCE_GAIN = 0.0055;

export function startAmbience(): StopFn {
  const ctx = audio();
  if (!ctx) return () => {};
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
    // The context is shared and outlives the call: stop the source and drop the
    // nodes instead of closing it (closing would take the next call's chime
    // back to a cold device — the bug voiceAudio.ts's shared context avoids).
    window.setTimeout(() => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      gain.disconnect();
      lp.disconnect();
      src.disconnect();
    }, 200);
  };
}
