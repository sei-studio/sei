/**
 * World thumbnail hit / fallback counters (261111). Cards count a thumbnail
 * that loaded and a thumbnail that failed (so the full portrait was loaded
 * instead); the counts ride on the next `world_page_loaded` event (no new
 * event) and reset there. A steady fallback share means thumbnails are missing
 * (backfill not run, proxy route down) and the grid is paying full price.
 */

let loads = 0;
let fallbacks = 0;

export function noteThumbLoaded(): void {
  loads += 1;
}

export function noteThumbFallback(): void {
  fallbacks += 1;
}

/** Counts since the previous call, then reset. */
export function takeThumbStats(): { loads: number; fallbacks: number } {
  const out = { loads, fallbacks };
  loads = 0;
  fallbacks = 0;
  return out;
}
