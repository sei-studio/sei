/**
 * Voice-module (Whisper model) prefetch + readiness (260705).
 *
 * The dictation model (~40 MB, whisper-tiny.en via transformers.js) downloads
 * on first use and lands in the browser Cache API — profile-local, survives
 * restarts. Two flows want to know/control that:
 *
 *   - Onboarding (SkinSetupScreen "Voice calls" opt-in): start the download in
 *     the background so the first call is instant.
 *   - Dialing without the module installed (VoiceCallScreen): ask first
 *     ("Install the voice module?"), then show a progress bar.
 *
 * Readiness is the truth on disk: a localStorage flag as the fast path,
 * verified against the Cache API (covers a cleared cache with a stale flag,
 * and a user who already called before the flag existed).
 *
 * prefetchVoiceModel() single-flights: the onboarding kick and a concurrent
 * dial share one worker; progress callbacks multiplex.
 */

const READY_FLAG = 'sei-voice-model-ready';
const MODEL_MARKER = 'whisper-tiny.en';
const PREFETCH_TIMEOUT_MS = 180_000;

let inflight: Promise<void> | null = null;
let lastPct = 0;
const progressCbs = new Set<(pct: number) => void>();

/** True while a prefetch download is running (dial flow skips the consent
 * modal and goes straight to the progress view). */
export function prefetchInProgress(): boolean {
  return inflight !== null;
}

/** Latest known download percentage of the in-flight prefetch. */
export function prefetchPct(): number {
  return lastPct;
}

export async function isVoiceModelReady(): Promise<boolean> {
  try {
    if (localStorage.getItem(READY_FLAG) === '1') {
      // Verify the cache actually still holds the model files.
      if (await cacheHasModel()) return true;
      localStorage.removeItem(READY_FLAG);
      return false;
    }
    if (await cacheHasModel()) {
      localStorage.setItem(READY_FLAG, '1');
      return true;
    }
    return false;
  } catch {
    // Cache API unavailable → claim not-ready; the install flow still works
    // (the download just hits whatever HTTP cache exists).
    return false;
  }
}

async function cacheHasModel(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.some((req) => req.url.includes(MODEL_MARKER) && req.url.endsWith('.onnx'))) {
      return true;
    }
  }
  return false;
}

/**
 * Download + warm the model via the same worker dictation uses (so the bytes
 * land in the same cache), then terminate it. Resolves when ready; rejects on
 * a failed/stalled download. Concurrent callers share one attempt.
 */
export function prefetchVoiceModel(onProgress?: (pct: number) => void): Promise<void> {
  if (onProgress) {
    progressCbs.add(onProgress);
    if (lastPct > 0) onProgress(lastPct);
  }
  if (inflight) return inflight;
  lastPct = 0;

  inflight = new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
    const finish = (err?: Error): void => {
      worker.terminate();
      inflight = null;
      progressCbs.clear();
      if (err) reject(err);
      else {
        try {
          localStorage.setItem(READY_FLAG, '1');
        } catch {
          /* flag is an optimization; cache check still passes */
        }
        resolve();
      }
    };
    const watchdog = setTimeout(
      () => finish(new Error('voice module download took too long — check your connection and retry')),
      PREFETCH_TIMEOUT_MS,
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; pct?: number; message?: string };
      if (msg.type === 'progress' && typeof msg.pct === 'number') {
        lastPct = Math.min(99, msg.pct);
        for (const cb of progressCbs) cb(lastPct);
      } else if (msg.type === 'ready') {
        clearTimeout(watchdog);
        lastPct = 100;
        for (const cb of progressCbs) cb(100);
        finish();
      } else if (msg.type === 'init-error') {
        clearTimeout(watchdog);
        finish(new Error(msg.message ?? 'voice module download failed'));
      }
    };
    worker.postMessage({ type: 'init' });
  });
  return inflight;
}
