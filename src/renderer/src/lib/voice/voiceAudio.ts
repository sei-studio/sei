/**
 * The call's shared AudioContext (260731) — extracted from callTones.ts, which
 * owned it alone until the pitch shifter needed the same context and the same
 * "is the output actually rendering?" gate.
 *
 * ONE AudioContext for every call sound (260729). Each sound used to build its
 * own and close it after, which cost the output device's open latency EVERY
 * time: a fresh context's clock sits at 0 while CoreAudio spins the device up,
 * so anything scheduled at `currentTime + 0.02` is rendered before audio
 * actually flows and is simply not heard. Symptom: the ring's first ding (and
 * often the second) missing, the chime "only audible after a second". Kept
 * alive, the device stays open and every later sound starts when it says it
 * does. Created lazily, so an app that never places a call never opens it.
 *
 * A SECOND context would undo that on its own — two device opens, two clocks,
 * and the newer one is the one a mic reroute lands on (see whenSteady). So the
 * pitch bus takes this one rather than making its own.
 */

/** Never closed while the app runs (see the file header). */
let shared: AudioContext | null = null;

export function sharedContext(): AudioContext | null {
  if (shared && shared.state !== 'closed') {
    // Autoplay policy can park it; every call sound follows a user gesture.
    if (shared.state === 'suspended') void shared.resume().catch(() => {});
    return shared;
  }
  try {
    shared = new AudioContext();
  } catch {
    return null;
  }
  return shared;
}

/**
 * How far ahead to schedule the FIRST sound through a context that has not
 * rendered yet — enough for the device to open (macOS CoreAudio is the slow
 * one) so the attack is not swallowed. A warm context uses the short lead: its
 * clock is already running, so 20 ms is just anti-glitch headroom.
 */
const WARMUP_LEAD_S = 0.2;
const WARM_LEAD_S = 0.02;
/** A clock this near zero means the context has not started rendering yet. */
const COLD_CLOCK_S = 0.25;

/**
 * `currentTime` is the end of the last render quantum, and Chromium renders
 * AHEAD of it by roughly `baseLatency`. A note scheduled inside that window
 * lands in audio already committed, so its attack is silently clipped or lost
 * outright — the flat 20 ms lead was under the render-ahead on any device with
 * a larger buffer. Ask the context how far ahead it is working instead of
 * guessing; baseLatency is absent on some builds, hence the fallback.
 */
function warmLead(ctx: AudioContext): number {
  const ahead =
    typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  return Math.max(WARM_LEAD_S, ahead * 2);
}

export function startTime(ctx: AudioContext): number {
  return ctx.currentTime + (ctx.currentTime < COLD_CLOCK_S ? WARMUP_LEAD_S : warmLead(ctx));
}

/**
 * Wait until the context's clock is genuinely keeping up with the wall clock,
 * then fire (260730).
 *
 * The ring kept losing its first bar, and lead time was never the answer. A
 * voice call opens the mic with echoCancellation, which makes Chromium reroute
 * the page's whole audio OUTPUT through the echo canceller; across that switch
 * the render thread stops, and anything scheduled into it is dropped. Two
 * attempts to schedule AROUND that failed, because there is no timing you can
 * pick from outside it: a longer lead does not help when the switch lands
 * inside the lead, and getUserMedia's promise resolves BEFORE the reroute has
 * finished.
 *
 * The switch is observable, though. `currentTime` advances only while the
 * device is actually rendering, so a stalled clock IS the reroute, and a clock
 * tracking real time for several polls in a row means audio is flowing again.
 * That is a measurement instead of a guess, and it subsumes the cold-device
 * start this file was originally written for: a context whose device has not
 * opened yet also has a clock going nowhere.
 *
 * Capped, so on anything unexpected the sound plays late rather than never.
 *
 * 260731: the pitch bus builds its AudioWorklet behind this same gate, for the
 * same reason — a node created across the reroute comes up attached to an
 * output that is being torn down.
 */
const STEADY_POLL_MS = 25;
/** Consecutive healthy polls before the output is trusted (~100ms rendered). */
const STEADY_POLLS = 4;
const STEADY_MAX_WAIT_MS = 1500;
/**
 * Clock-vs-wall ratio that counts as "rendering". Loose on purpose: timer
 * jitter and a busy main thread both drag it under 1 without audio having
 * stopped, while a reroute or an unopened device pins it near 0.
 */
const STEADY_RATIO = 0.5;

export function whenSteady(ctx: AudioContext, cb: () => void): void {
  const startedAt = performance.now();
  let lastCtx = ctx.currentTime;
  let lastWall = startedAt;
  let healthy = 0;
  const tick = (): void => {
    const wall = performance.now();
    const dCtx = ctx.currentTime - lastCtx;
    const dWall = (wall - lastWall) / 1000;
    lastCtx = ctx.currentTime;
    lastWall = wall;
    healthy = dWall > 0 && dCtx / dWall > STEADY_RATIO ? healthy + 1 : 0;
    if (healthy >= STEADY_POLLS || wall - startedAt > STEADY_MAX_WAIT_MS) {
      cb();
      return;
    }
    window.setTimeout(tick, STEADY_POLL_MS);
  };
  window.setTimeout(tick, STEADY_POLL_MS);
}
