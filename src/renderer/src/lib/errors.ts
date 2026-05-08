/**
 * Plain-English error narration surface (GUI-05).
 *
 * Sources:
 *   - 04-UI-SPEC.md §"Plain-English error copy" — verbatim copy table
 *   - 04-RESEARCH.md §"Pitfall 3" — KEYCHAIN_FALLBACK_PLAINTEXT (Linux fallback)
 *   - 04-09 PLAN — classifyRendererError heuristic table
 *
 * Renderer-side ONLY. Adding a new ErrorClass requires:
 *   1. update src/shared/errorClasses.ts (the union)
 *   2. add a row to ERROR_COPY here
 *   3. (optional) extend classifyRendererError if the classifier should
 *      detect the shape from raw error messages.
 */
import type { ErrorClass } from '@shared/errorClasses';

/**
 * Plain-English error copy. Verbatim from UI-SPEC §"Plain-English error copy".
 * Adding a new ErrorClass requires adding a row here AND updating
 * src/shared/errorClasses.ts.
 */
export const ERROR_COPY: Record<ErrorClass, string> = {
  BOT_START_TIMEOUT: "Couldn't start the bot in 30s. Make sure your LAN world is still open and try again.",
  LAN_NOT_OPEN: "We can't see an open LAN world. Press ESC in Minecraft and choose Open to LAN.",
  INVALID_API_KEY: "Your Anthropic API key was rejected. Open Settings → re-run onboarding to paste a fresh key.",
  RATE_LIMITED: "Anthropic is throttling requests. Wait a minute and try again.",
  NETWORK_OFFLINE: "No internet connection. Reconnect and try again.",
  BOT_CRASH: "Sei stopped unexpectedly. Press Summon to restart.",
  LAN_UNAVAILABLE: "LAN auto-detect is blocked on this network. Try a home Wi-Fi network.",
  KEYCHAIN_LOCKED: "Couldn't read your saved API key from the system keychain. Re-run onboarding to re-save it.",
  KEYCHAIN_FALLBACK_PLAINTEXT: "Your system has no secret store. Sei will save your API key but it won't be hardware-protected.",
  NATIVE_MODULE_MISMATCH: "A bundled module didn't load. Reinstall Sei from the .dmg / .exe.",
};

/**
 * Best-effort classification of an arbitrary error into an ErrorClass + copy.
 *
 * Uses keyword heuristics on the error message — falls back to BOT_CRASH-shaped
 * generic narration if nothing matches. The renderer uses this for ad-hoc IPC
 * failures (saveConfig, saveApiKey, etc.); structured BotStatus from main
 * already comes pre-classified — those should NOT be re-run through this
 * helper, just look up `ERROR_COPY[status.error]` directly.
 */
export function classifyRendererError(err: unknown): { class: ErrorClass; copy: string } {
  const msg = (err && typeof err === 'object' && 'message' in err)
    ? String((err as { message: unknown }).message)
    : String(err);
  const lower = msg.toLowerCase();

  if (/keychain|safestorage|encryption.*unavailable|decrypt/i.test(lower)) {
    return { class: 'KEYCHAIN_LOCKED', copy: ERROR_COPY.KEYCHAIN_LOCKED };
  }
  if (/invalid.*api.*key|401|unauthorized|x-api-key/i.test(lower)) {
    return { class: 'INVALID_API_KEY', copy: ERROR_COPY.INVALID_API_KEY };
  }
  if (/429|rate.?limit|throttl/i.test(lower)) {
    return { class: 'RATE_LIMITED', copy: ERROR_COPY.RATE_LIMITED };
  }
  if (/enotfound|enetunreach|getaddrinfo|dns|offline|fetch failed/i.test(lower)) {
    return { class: 'NETWORK_OFFLINE', copy: ERROR_COPY.NETWORK_OFFLINE };
  }
  if (/lan|multicast|no minecraft lan|open to lan/i.test(lower)) {
    return { class: 'LAN_NOT_OPEN', copy: ERROR_COPY.LAN_NOT_OPEN };
  }
  if (/timeout|did not signal ready/i.test(lower)) {
    return { class: 'BOT_START_TIMEOUT', copy: ERROR_COPY.BOT_START_TIMEOUT };
  }
  // Generic fallback
  return {
    class: 'BOT_CRASH',
    copy: `Something went wrong. ${msg ? msg + '.' : ''} Try again.`,
  };
}
