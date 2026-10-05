/**
 * The seam between the credit-wall raisers and the refill notifier (261005).
 *
 * Every 'depleted' hard stop passes through one of two places: the bot
 * supervisor's emitHardStop (wired in index.ts) and raiseUsageLimitPopup
 * (chat/usageLimit.ts, for the chat, voice, chess, Draw! and backseat
 * surfaces). Both call noteCreditWallHit(); the tray controller registers the
 * listener at boot. Electron-free so usageLimit.ts and its tests never load
 * the tray module.
 */
let listener: (() => void) | null = null;

export function setCreditWallListener(fn: (() => void) | null): void {
  listener = fn;
}

/** A 'depleted' wall was just raised. Never throws. */
export function noteCreditWallHit(): void {
  try {
    listener?.();
  } catch {
    /* the notifier must never disturb the wall itself */
  }
}
