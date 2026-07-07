// Demo stub for src/renderer/src/lib/voice/modelPrefetch.ts.
//
// The real module downloads a ~40 MB Whisper model into the Cache API via a
// web worker. In the scripted demo we don't want a real download (slow, network
// dependent, pulls the 2 MB worker into the bundle) — but we DO want the flow to
// look real: `isVoiceModelReady()` returns false so the "Set up voice calls"
// consent gate shows, and `prefetchVoiceModel()` animates a quick fake progress
// bar to 100% so clicking Install lands the caller in a live call.
let inflight = null;
let lastPct = 0;

export function prefetchInProgress() {
  return inflight !== null;
}

export function prefetchPct() {
  return lastPct;
}

export async function isVoiceModelReady() {
  return false; // always show the consent gate in the demo
}

export function prefetchVoiceModel(onProgress) {
  if (onProgress && lastPct > 0) onProgress(lastPct);
  if (inflight) return inflight;
  lastPct = 0;
  inflight = new Promise((resolve) => {
    const t0 = performance.now();
    const DURATION_MS = 1400;
    const tick = () => {
      const pct = Math.min(100, Math.round(((performance.now() - t0) / DURATION_MS) * 100));
      lastPct = pct;
      if (onProgress) onProgress(pct);
      if (pct < 100) requestAnimationFrame(tick);
      else {
        inflight = null;
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
  return inflight;
}
