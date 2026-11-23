/**
 * Opening the shared stream, with one retry and a whole-screen fallback
 * (261123). Pure orchestration over injected openers so it runs in vitest.
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
 *      and rate are capped afterwards on the track where that is allowed;
 *   3. for a window only: the whole screen, relaxed. A minimized game is
 *      captured as soon as the player switches back to it, and the call
 *      window says "Sharing <screen>" so the wider share is visible.
 */

import { captureErrorClass, type CaptureErrorClass } from '../../../../shared/callEndReasons';

export type CaptureSourceKind = 'window' | 'screen';
/** How the start went: no retry needed, recovered by one of the two steps, or not. */
export type CaptureRetryOutcome = 'none' | 'relaxed_ok' | 'screen_ok' | 'failed';

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
  /** The source actually captured (the screen, after a fallback). */
  source: CaptureSourceRef;
  retry: CaptureRetryOutcome;
  /** Set when a retry happened: the class of the first failure. */
  firstClass?: CaptureErrorClass;
}

/**
 * Open `source`, retrying once relaxed and then (window only) falling back to
 * a screen. `onRetry` fires once, at the first busy failure, so the caller can
 * start looking at the window (is it minimized?) in parallel.
 */
export async function openWithRetry<T>(
  source: CaptureSourceRef,
  open: (sourceId: string, relaxed: boolean) => Promise<T>,
  findScreen: () => Promise<CaptureSourceRef | null>,
  onRetry?: (firstClass: CaptureErrorClass) => void,
): Promise<OpenedCapture<T>> {
  const kind = captureSourceKind(source.id);
  let firstErr: unknown;
  try {
    return { value: await open(source.id, false), source, retry: 'none' };
  } catch (err) {
    firstErr = err;
  }
  const firstClass = captureErrorClass(firstErr);
  if (firstClass !== 'busy') throw new CaptureStartError(firstErr, kind, firstClass, 'none');
  onRetry?.(firstClass);

  let lastErr: unknown = firstErr;
  try {
    return { value: await open(source.id, true), source, retry: 'relaxed_ok', firstClass };
  } catch (err) {
    lastErr = err;
  }
  if (kind === 'window' && captureErrorClass(lastErr) === 'busy') {
    const screen = await findScreen().catch(() => null);
    if (screen) {
      try {
        return { value: await open(screen.id, true), source: screen, retry: 'screen_ok', firstClass };
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new CaptureStartError(lastErr, kind, firstClass, 'failed');
}

/** The first whole-screen source in a list (the primary display comes first). */
export function pickScreenSource<S extends CaptureSourceRef>(list: S[]): S | null {
  return list.find((s) => s.id.startsWith('screen:')) ?? null;
}
