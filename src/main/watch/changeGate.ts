/**
 * Screen-share change gate — the pure math that decides which captured frames
 * are worth an LLM look (260720).
 *
 * Every 3s poll produces a tiny grayscale downscale (64x36 by default) of the
 * shared source. The gate compares it against the LAST FRAME SENT to the LLM
 * (not the last polled frame, so slow cumulative change still registers) with
 * a mean-absolute-difference:
 *
 *   - delta > HIGH  → send immediately (subject only to the hard floor);
 *   - delta > LOW   → send when enough time has passed since the last send
 *                     (base LOW interval, stretched by the quiet backoff);
 *   - otherwise     → nothing; consecutive quiet polls stretch the LOW
 *                     cadence toward the quiet ceiling (20-30s), so a static
 *                     menu screen costs almost nothing.
 *
 * A hard floor (8s) sits under everything: no two LLM sends can ever be closer
 * than the floor, whatever the deltas say.
 *
 * All functions here are pure (no Electron, no timers) so the math is unit-
 * testable; src/main/watch/capture.ts owns the actual pixel plumbing.
 */

/** Gate downscale size — small enough that the diff is O(nothing). */
export const GRAY_W = 64;
export const GRAY_H = 36;

/** One captured frame, in memory only. Produced by capture.ts (or tests). */
export interface CapturedFrame {
  /** JPEG bytes for the LLM turn (base64). Never written to disk. */
  jpegBase64: string;
  /** Tiny grayscale for the change gate. */
  gray: Uint8Array;
  /** Small JPEG data URL for the renderer preview. */
  previewDataUrl: string;
  capturedAt: number;
}

export interface GateConfig {
  /** Mean-abs-diff (0-255) above which a frame sends immediately. */
  highDelta: number;
  /** Mean-abs-diff above which a frame sends on the slow cadence. */
  lowDelta: number;
  /** Base interval for LOW-delta sends. */
  lowIntervalMs: number;
  /** Hard floor between any two LLM sends. */
  floorMs: number;
  /** Each consecutive quiet poll stretches the LOW cadence by this much. */
  quietStepMs: number;
  /** Ceiling of the stretched LOW cadence (the "20-30s when quiet" band). */
  quietMaxIntervalMs: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  highDelta: 28,
  lowDelta: 8,
  lowIntervalMs: 10_000,
  floorMs: 8_000,
  quietStepMs: 2_500,
  quietMaxIntervalMs: 30_000,
};

export interface GateState {
  /** Wall-clock of the last frame actually sent to the LLM (0 = never). */
  lastSentAt: number;
  /** Consecutive polls whose delta stayed at/below lowDelta. */
  quietPolls: number;
}

export function initialGateState(): GateState {
  return { lastSentAt: 0, quietPolls: 0 };
}

/** The stretched LOW-cadence interval for the current quiet streak. */
export function effectiveLowIntervalMs(state: GateState, cfg: GateConfig): number {
  return Math.min(
    cfg.quietMaxIntervalMs,
    cfg.lowIntervalMs + state.quietPolls * cfg.quietStepMs,
  );
}

export interface GateDecision {
  send: boolean;
  next: GateState;
}

/**
 * Decide whether the current poll's frame goes to the LLM. `delta` is the
 * mean-abs-diff of the current tiny grayscale vs the LAST SENT one; the very
 * first frame of a session (lastSentAt === 0) always sends so the character
 * opens with something to react to.
 */
export function decideSend(
  state: GateState,
  cfg: GateConfig,
  delta: number,
  nowMs: number,
): GateDecision {
  const sinceSend = state.lastSentAt === 0 ? Infinity : nowMs - state.lastSentAt;
  const quiet = delta <= cfg.lowDelta;
  const quietPolls = quiet ? state.quietPolls + 1 : 0;

  // Hard floor: nothing sends inside it, however big the delta.
  if (sinceSend < cfg.floorMs) {
    return { send: false, next: { ...state, quietPolls } };
  }
  if (state.lastSentAt === 0) {
    return { send: true, next: { lastSentAt: nowMs, quietPolls: 0 } };
  }
  if (delta > cfg.highDelta) {
    return { send: true, next: { lastSentAt: nowMs, quietPolls: 0 } };
  }
  if (delta > cfg.lowDelta && sinceSend >= effectiveLowIntervalMs(state, cfg)) {
    return { send: true, next: { lastSentAt: nowMs, quietPolls: 0 } };
  }
  return { send: false, next: { ...state, quietPolls } };
}

// ── pixel math ───────────────────────────────────────────────────────────────

/**
 * Collapse a 4-bytes-per-pixel bitmap (Electron toBitmap: BGRA/RGBA — the
 * channel order does not matter for an equal-weight average) into one gray
 * byte per pixel. Alpha is ignored.
 */
export function grayFromBitmap(bitmap: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    out[i] = (bitmap[o] + bitmap[o + 1] + bitmap[o + 2]) / 3;
  }
  return out;
}

/**
 * Mean absolute difference (0-255) between two equal-length gray buffers.
 * Length mismatch (source resized, window reshaped) reads as maximal change.
 */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * All-black frame detection: on macOS a capture without Screen Recording
 * permission silently returns black frames. Mean near zero AND no bright
 * pixel at all = blank (a genuinely dark game scene keeps some highlights).
 */
export function isBlankFrame(gray: Uint8Array): boolean {
  if (gray.length === 0) return true;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    if (gray[i] > max) max = gray[i];
  }
  return sum / gray.length < 4 && max < 12;
}

// ── speech pacing ────────────────────────────────────────────────────────────

/** Minimum gap between unprompted say() lines (frame + idle turns). */
export const UNPROMPTED_SAY_COOLDOWN_MS = 20_000;

/** True when an unprompted line is allowed now (chat replies are exempt). */
export function unpromptedSayAllowed(lastUnpromptedSayAt: number, nowMs: number): boolean {
  return lastUnpromptedSayAt === 0 || nowMs - lastUnpromptedSayAt >= UNPROMPTED_SAY_COOLDOWN_MS;
}

/** How old a reaction's source frame may be before divergence can void it. */
export const STALE_FRAME_MS = 10_000;

/**
 * Drop a generated reaction when its source frame is older than STALE_FRAME_MS
 * and the screen has since diverged hard (the moment it reacts to is gone).
 * `divergence` is meanAbsDiff(latest gray, the turn frame's gray).
 */
export function reactionIsStale(
  frameCapturedAt: number,
  nowMs: number,
  divergence: number,
  cfg: GateConfig,
): boolean {
  return nowMs - frameCapturedAt > STALE_FRAME_MS && divergence > cfg.highDelta;
}
