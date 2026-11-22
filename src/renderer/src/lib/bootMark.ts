/**
 * When the Sei mark on the boot wait fades in (261123, product call: keep the
 * logo, and show it as early as possible on a slow launch).
 *
 * The clock is the launch, not the moment the splash appeared: the mark fades
 * in at BOOT_MARK_AT_MS after the process started. A launch that reaches its
 * first view sooner never shows it; a window that only appears after that
 * (a slow PC, Windows Defender scanning a cold start) shows the mark at once.
 * The window's first paint is a static copy of the splash in index.html, and
 * React's BootSplash takes over on the same clock (a negative delay picks the
 * fade up where the static copy is), so the swap never restarts the fade.
 *
 * index.html carries the same rule as an inline script (it runs before any
 * bundle); bootMark.test.ts runs that script against this function.
 */
export const BOOT_MARK_AT_MS = 1200;
export const BOOT_MARK_FADE_MS = 800;
/** A start further back than this is not this launch's (a reopened window). */
const MAX_LAUNCH_AGE_MS = 10 * 60_000;

/** The CSS animation-delay (ms, may be negative) for the mark, given the process start (epoch ms). */
export function bootMarkDelayMs(startedAt: unknown, now: number): number {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return BOOT_MARK_AT_MS;
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed > MAX_LAUNCH_AGE_MS) return BOOT_MARK_AT_MS;
  return Math.max(-BOOT_MARK_FADE_MS, Math.min(BOOT_MARK_AT_MS, Math.round(BOOT_MARK_AT_MS - elapsed)));
}
