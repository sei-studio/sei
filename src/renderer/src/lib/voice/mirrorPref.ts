/**
 * 260816 (china-compat): should model downloads try the dl.sei.gg mirror
 * BEFORE Hugging Face? HF is hard-blocked in mainland China, and the region
 * verdict main already caches for the auth gate (region:status) is the same
 * signal — a blocked-region user is exactly the user whose HF fetch will
 * hang or die.
 *
 * The answer is served SYNCHRONOUSLY from a cache primed at module import,
 * because the whisper-worker init sites are synchronous setup code. Until
 * the async prime resolves the answer is false (HF first), which is always
 * SAFE: the worker falls back to the other host on failure either way —
 * mirror-first is a latency optimization for blocked regions, never a
 * correctness requirement.
 */

let mirrorFirstCached = false;

function prime(): void {
  try {
    void window.sei
      ?.regionStatus?.()
      .then((r: { blocked?: boolean } | null | undefined) => {
        mirrorFirstCached = r?.blocked === true;
      })
      .catch(() => {});
  } catch {
    /* preload bridge absent (tests) — HF-first stands */
  }
}
prime();

/** Sync verdict for worker init messages ({ mirrorFirst }). */
export function whisperMirrorFirst(): boolean {
  return mirrorFirstCached;
}
