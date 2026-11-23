/**
 * Opening the shared stream, with one relaxed retry (261123). Pure
 * orchestration over an injected opener so it runs in vitest.
 *
 * Why: `capture_failed:busy` (a NotReadableError from getUserMedia, "Could not
 * start video source") hit 18 Windows users in 30 days, 92 failed starts. The
 * telemetry says how it fails: every one rejected within a second of the
 * start (a fast refusal, not a timeout), and the same player then failed again
 * and again, up to 22 times in two minutes. 78% were WINDOW sources. Chromium's
 * Windows window capturer refuses a window it cannot capture right now, and
 * the common case is a game that is minimized: a fullscreen game minimizes
 * itself the moment the player alt-tabs to Sei to press Share, so every retry
 * from inside Sei fails the same way. The other 22% were whole screens, a
 * smaller set of machines where the capturer refuses the requested shape.
 *
 * So, in order, and only for the busy class (a permission refusal or a gone
 * source is not helped by asking again):
 *   1. the normal request (720p cap, CAPTURE_FPS cap);
 *   2. the same source with RELAXED constraints: no max size or rate in the
 *      request, so the capturer starts in whatever shape it can, and the size
 *      and rate are capped afterwards on the track where that is allowed.
 * If that fails too, the player gets one hint line (un-minimize the game, or
 * share the whole screen) and decides. There is deliberately NO automatic
 * whole-screen fallback: the player chose one window, and widening the share
 * on their behalf would send everything else on the screen (other apps,
 * notifications, DMs) to the vision model (product call 261123).
 */

import { captureErrorClass, type CaptureErrorClass } from '../../../../shared/callEndReasons';

export type CaptureSourceKind = 'window' | 'screen';
/** How the start went: no retry needed, recovered by the relaxed retry, or not. */
export type CaptureRetryOutcome = 'none' | 'relaxed_ok' | 'failed';

export interface CaptureSourceRef {
  id: string;
  name: string;
}

export function captureSourceKind(sourceId: string): CaptureSourceKind {
  return sourceId.startsWith('screen:') ? 'screen' : 'window';
}

/**
 * The legacy Chromium desktop constraints. `relaxed` drops every max: some
 * capturers refuse a size or rate they cannot produce rather than scaling.
 */
export function desktopVideoConstraints(
  sourceId: string,
  relaxed: boolean,
  cap: { width: number; height: number; fps: number },
): MediaTrackConstraints {
  const mandatory: Record<string, unknown> = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
  };
  if (!relaxed) {
    mandatory.maxWidth = cap.width;
    mandatory.maxHeight = cap.height;
    mandatory.maxFrameRate = cap.fps;
  }
  return { mandatory } as unknown as MediaTrackConstraints;
}

/** A start that failed after every step. Carries the shape for analytics. */
export class CaptureStartError extends Error {
  readonly name: string;
  constructor(
    readonly cause: unknown,
    readonly sourceKind: CaptureSourceKind,
    /** The class of the FIRST failure, which is the one that says why. */
    readonly firstClass: CaptureErrorClass,
    readonly retry: CaptureRetryOutcome,
  ) {
    super(String((cause as { message?: unknown } | null)?.message ?? 'capture failed'));
    // Keep the DOMException name, so captureErrorClass(err) reads the same.
    this.name = String((cause as { name?: unknown } | null)?.name ?? 'Error');
  }
}

export interface OpenedCapture<T> {
  value: T;
  retry: CaptureRetryOutcome;
  /** Set when a retry happened: the class of the first failure. */
  firstClass?: CaptureErrorClass;
}

/**
 * Open `source`, retrying a busy refusal once with relaxed constraints. Only
 * ever the source the player picked. `onRetry` fires once, at the first busy
 * failure, so the caller can start looking at the window (is it minimized?)
 * in parallel.
 */
export async function openWithRetry<T>(
  source: CaptureSourceRef,
  open: (sourceId: string, relaxed: boolean) => Promise<T>,
  onRetry?: (firstClass: CaptureErrorClass) => void,
): Promise<OpenedCapture<T>> {
  const kind = captureSourceKind(source.id);
  let firstErr: unknown;
  try {
    return { value: await open(source.id, false), retry: 'none' };
  } catch (err) {
    firstErr = err;
  }
  const firstClass = captureErrorClass(firstErr);
  if (firstClass !== 'busy') throw new CaptureStartError(firstErr, kind, firstClass, 'none');
  onRetry?.(firstClass);

  try {
    return { value: await open(source.id, true), retry: 'relaxed_ok', firstClass };
  } catch (err) {
    throw new CaptureStartError(err, kind, firstClass, 'failed');
  }
}
