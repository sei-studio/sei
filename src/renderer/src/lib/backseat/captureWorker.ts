/**
 * Backseat capture worker (260728) — the ring buffer, the frame heuristic, and
 * the image-grid compositor. Runs off the main thread because the capture loop
 * must survive the player being in a fullscreen game with Sei behind it:
 * a worker is never rAF-throttled, and MediaStreamTrackProcessor's readable is
 * transferable, so the frames come straight here.
 *
 * ── Why this does not hold 900 frames ────────────────────────────────────
 *
 * The contract is "15 s at 60 fps, pick one frame per second by loudest gain".
 * Read literally that is 900 retained 720p frames — several GB raw, or 60 JPEG
 * encodes a second, and neither is survivable on a machine that is also
 * running a game.
 *
 * It does not have to be. The selection rule is a running argmax: within a
 * one-second bucket the winner is whichever frame had the loudest audio, and
 * that is knowable incrementally. So the worker keeps exactly ONE frame per
 * bucket alive at a time (the best seen so far, as an ImageBitmap) and throws
 * every loser away the moment it loses. At the bucket boundary the winner is
 * encoded to JPEG once and appended to the ring.
 *
 * That is 1 encode/second instead of 60, and steady-state memory of
 * BUFFER_SECONDS JPEGs (~35 KB each) plus a single live bitmap — while still
 * examining all 60 frames per second and picking exactly the one the spec
 * asks for. The full-rate 60 fps video is not lost either: MediaRecorder in
 * the controller keeps it for clip export, which is the only thing that
 * actually needs every frame.
 *
 * Frames are examined at capture rate for two more signals, both cheap enough
 * to run on every single frame: the audio gain that drives selection, and a
 * 32x18 thumbnail whose frame-to-frame distance is the colour-jolt trigger.
 */

import {
  BUFFER_MS,
  CELL_W,
  CELL_H,
  GRID_W,
  GRID_H,
  GRID_COLS,
  GRID_FRAMES,
  JOLT_COLOR_DELTA,
  JOLT_GAIN_DB,
  JOLT_REFRACTORY_MS,
} from '../../../../shared/backseatIpc';

/** Closed one-second buckets kept in the ring. */
const BUFFER_SECONDS = Math.ceil(BUFFER_MS / 1000);
/** Thumbnail grid for the colour-jolt signal. Tiny on purpose: this is a
 *  "did the whole screen repaint" detector, not a motion estimator. */
const THUMB_W = 32;
const THUMB_H = 18;
/** How far back the colour comparison reaches. A second is long enough that
 *  ordinary panning cannot clear the threshold but a room change always does. */
const COLOR_LOOKBACK_MS = 1000;
/** Retained-frame JPEG quality. The model reads shapes and banners off these,
 *  not fine text, so this is well above what it needs. */
const CELL_QUALITY = 0.72;
const GRID_QUALITY = 0.82;

interface ClosedBucket {
  /** Bucket index (floor(t / 1000)), so gaps in capture are visible. */
  second: number;
  /** Capture time of the winning frame. */
  at: number;
  jpeg: Blob;
}

// ── Worker state ──────────────────────────────────────────────────────────

let cellCanvas: OffscreenCanvas | null = null;
let cellCtx: OffscreenCanvasRenderingContext2D | null = null;
/** Separate surface for the once-a-second JPEG encode. It has to be separate:
 *  convertToBlob is async, and the frame loop keeps drawing into cellCanvas
 *  while it is pending, so encoding through the live canvas would sometimes
 *  write a LATER frame into the closing bucket. */
let encodeCanvas: OffscreenCanvas | null = null;
let encodeCtx: OffscreenCanvasRenderingContext2D | null = null;
let thumbCanvas: OffscreenCanvas | null = null;
let thumbCtx: OffscreenCanvasRenderingContext2D | null = null;
let gridCanvas: OffscreenCanvas | null = null;
let gridCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Closed buckets, oldest first, capped at BUFFER_SECONDS. */
const ring: ClosedBucket[] = [];

/** The in-progress bucket's best frame so far, by audio gain. */
let liveSecond = -1;
let liveBest: ImageBitmap | null = null;
let liveBestGain = -Infinity;
let liveBestAt = 0;

/** Latest audio loudness, posted from the main thread (dBFS, -100..0). */
let currentGain = -100;
/** Trailing loudness samples for the jolt baseline: [t, db]. */
const gainTrace: Array<[number, number]> = [];
/** Trailing thumbnails for the colour comparison: [t, Uint8ClampedArray]. */
const thumbTrace: Array<[number, Uint8ClampedArray]> = [];

let lastJoltAt = 0;
let running = false;
/** Frames seen vs buckets closed, surfaced for diagnostics. */
let framesSeen = 0;

/**
 * Periodic signal report (260728), so "is the jolt arm alive" is answerable
 * from the dev console instead of by faith: the controller logs each one, and
 * the overlay's console is forwarded to the terminal in dev. Numbers only —
 * the controller owns the wording.
 */
const STATS_INTERVAL_MS = 10_000;
let lastStatsAt = 0;
let statsFramesSeen = 0;

// ── Setup ─────────────────────────────────────────────────────────────────

function ensureCanvases(): void {
  if (cellCanvas) return;
  cellCanvas = new OffscreenCanvas(CELL_W, CELL_H);
  cellCtx = cellCanvas.getContext('2d', { alpha: false });
  encodeCanvas = new OffscreenCanvas(CELL_W, CELL_H);
  encodeCtx = encodeCanvas.getContext('2d', { alpha: false });
  thumbCanvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  thumbCtx = thumbCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  gridCanvas = new OffscreenCanvas(GRID_W, GRID_H);
  gridCtx = gridCanvas.getContext('2d', { alpha: false });
}

/**
 * Draw a source into a cell, preserving aspect ratio with letterbox/pillarbox
 * bars rather than stretching. The cell is 602x336 (1.79:1) and a 16:9 source
 * is 1.78:1, so on a normal game window the bars are about two pixels — but
 * the player can share ANY window, including a portrait one, and a stretched
 * frame is a frame the model reads wrong.
 */
function drawFitted(
  ctx: OffscreenCanvasRenderingContext2D,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  if (!srcW || !srcH) return;
  const scale = Math.min(dw / srcW, dh / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

// ── Signals ───────────────────────────────────────────────────────────────

/** Median of the trailing loudness trace — the baseline a jolt is measured
 *  against. Median, not mean, so a single prior bang cannot raise the bar. */
function baselineGain(): number {
  if (gainTrace.length < 30) return -100;
  const vals = gainTrace.map((g) => g[1]).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

/** Mean absolute per-channel difference between two thumbnails, 0..1. */
function thumbDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  // Stride 4 skips alpha; the canvas is opaque so it is always 255.
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3 * 255);
}

/**
 * The local trigger: a discontinuity so large it needs no model to confirm.
 * Both arms are measured against a rolling baseline rather than an absolute,
 * so a loud game and a quiet game behave the same, and both are set high
 * enough (JOLT_GAIN_DB / JOLT_COLOR_DELTA) that ordinary play never fires
 * them. The refractory period is what keeps this from ever out-talking the
 * gate.
 */
function checkJolt(now: number, thumb: Uint8ClampedArray): 'gain' | 'color' | null {
  if (now - lastJoltAt < JOLT_REFRACTORY_MS) return null;
  // Needs a full lookback of history, or the first second of every session
  // reads as a jolt against an empty baseline.
  if (now - (gainTrace[0]?.[0] ?? now) < COLOR_LOOKBACK_MS * 2) return null;

  if (currentGain - baselineGain() >= JOLT_GAIN_DB) {
    lastJoltAt = now;
    return 'gain';
  }
  const past = thumbTrace.find(([t]) => now - t >= COLOR_LOOKBACK_MS);
  if (past && thumbDelta(thumb, past[1]) >= JOLT_COLOR_DELTA) {
    lastJoltAt = now;
    return 'color';
  }
  return null;
}

// ── Bucket lifecycle ──────────────────────────────────────────────────────

async function closeBucket(): Promise<void> {
  const best = liveBest;
  const second = liveSecond;
  const at = liveBestAt;
  liveBest = null;
  liveBestGain = -Infinity;
  if (!best || second < 0) return;
  try {
    // One encode per second of wall clock. The winner is drawn onto the
    // dedicated encode surface (an ImageBitmap has no encoder of its own) so
    // the concurrent frame loop cannot overwrite it mid-encode.
    encodeCtx!.drawImage(best, 0, 0);
    const jpeg = await encodeCanvas!.convertToBlob({ type: 'image/jpeg', quality: CELL_QUALITY });
    ring.push({ second, at, jpeg });
    while (ring.length > BUFFER_SECONDS) ring.shift();
  } catch {
    // A dropped bucket costs one grid cell, never the session.
  } finally {
    best.close();
  }
}

async function onFrame(frame: VideoFrame): Promise<void> {
  const now = Date.now();
  const srcW = frame.displayWidth;
  const srcH = frame.displayHeight;
  try {
    drawFitted(cellCtx!, frame, srcW, srcH, 0, 0, CELL_W, CELL_H);
    thumbCtx!.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
  } finally {
    // A VideoFrame holds a hardware buffer; not closing it stalls the whole
    // pipeline within a few dozen frames.
    frame.close();
  }
  framesSeen++;

  const thumb = thumbCtx!.getImageData(0, 0, THUMB_W, THUMB_H).data;
  gainTrace.push([now, currentGain]);
  while (gainTrace.length && now - gainTrace[0][0] > BUFFER_MS) gainTrace.shift();
  // Thumbnails only need to reach back far enough for the comparison, and at
  // capture rate that is still 60 a second — keep them at ~10 Hz instead.
  const lastThumbAt = thumbTrace.length ? thumbTrace[thumbTrace.length - 1][0] : 0;
  if (now - lastThumbAt >= 100) {
    thumbTrace.push([now, thumb]);
    while (thumbTrace.length && now - thumbTrace[0][0] > COLOR_LOOKBACK_MS * 3) thumbTrace.shift();
  }

  const second = Math.floor(now / 1000);
  if (second !== liveSecond) {
    // closeBucket() takes ownership of liveBest/liveSecond synchronously before
    // its first await, so it is safe to not await here — and it must not be
    // awaited, or a slow encode would stall the frame loop for a whole frame.
    void closeBucket();
    liveSecond = second;
  }
  // Running argmax over the bucket. `>=` rather than `>` so that in the very
  // common case of digital silence (every frame at the noise floor) the cell
  // ends up being the LAST frame of the second rather than the first, which is
  // the more useful one: it is closest to whatever happens next.
  if (currentGain >= liveBestGain) {
    liveBestGain = currentGain;
    liveBestAt = now;
    liveBest?.close();
    liveBest = cellCanvas!.transferToImageBitmap();
  }

  const jolt = checkJolt(now, thumb);
  if (jolt) {
    const past = thumbTrace.find(([t]) => now - t >= COLOR_LOOKBACK_MS);
    self.postMessage({
      type: 'jolt',
      reason: jolt,
      at: now,
      gainDb: round1(currentGain),
      baseDb: round1(baselineGain()),
      colorDelta: past ? round3(thumbDelta(thumb, past[1])) : null,
    });
  }

  if (now - lastStatsAt >= STATS_INTERVAL_MS) {
    const past = thumbTrace.find(([t]) => now - t >= COLOR_LOOKBACK_MS);
    self.postMessage({
      type: 'stats',
      // null on the first report: there is no previous window to rate against.
      fps: lastStatsAt ? Math.round(((framesSeen - statsFramesSeen) * 1000) / (now - lastStatsAt)) : null,
      gainDb: round1(currentGain),
      baseDb: round1(baselineGain()),
      colorDelta: past ? round3(thumbDelta(thumb, past[1])) : null,
      buckets: ring.length,
    });
    lastStatsAt = now;
    statsFramesSeen = framesSeen;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Grid compositing ──────────────────────────────────────────────────────

/**
 * Build the 3x2 grid from the most recent GRID_FRAMES buckets, oldest in the
 * top-left, filled row-first — the arrangement IG-VLM (arXiv 2403.18406)
 * found best, and the one the prompt describes to the model.
 *
 * Buckets that never closed (capture hiccup, or the session is younger than
 * six seconds) leave their cell black rather than shifting the others: a
 * missing cell is honest, a shifted one silently lies about the timeline.
 */
async function composite(): Promise<{ dataUrl: string; capturedAt: number } | null> {
  const picked = ring.slice(-GRID_FRAMES);
  if (!picked.length) return null;
  gridCtx!.fillStyle = '#000';
  gridCtx!.fillRect(0, 0, GRID_W, GRID_H);

  // Anchor on the newest bucket so a gap in the middle leaves a hole in the
  // right place instead of compacting the sequence.
  const newest = picked[picked.length - 1].second;
  const bySecond = new Map(picked.map((b) => [b.second, b]));
  for (let i = 0; i < GRID_FRAMES; i++) {
    const bucket = bySecond.get(newest - (GRID_FRAMES - 1 - i));
    if (!bucket) continue;
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(bucket.jpeg);
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      gridCtx!.drawImage(bmp, col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    } catch {
      /* leave the cell black */
    } finally {
      bmp?.close();
    }
  }

  const blob = await gridCanvas!.convertToBlob({ type: 'image/jpeg', quality: GRID_QUALITY });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return {
    dataUrl: `data:image/jpeg;base64,${btoa(bin)}`,
    capturedAt: picked[picked.length - 1].at,
  };
}

// ── Message plumbing ──────────────────────────────────────────────────────

async function consume(readable: ReadableStream<VideoFrame>): Promise<void> {
  const reader = readable.getReader();
  running = true;
  while (running) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (!running) {
      value.close();
      break;
    }
    try {
      await onFrame(value);
    } catch {
      // Never let one bad frame kill the loop; the frame is already closed.
    }
  }
  try {
    reader.releaseLock();
  } catch {
    /* already released */
  }
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as
    | { type: 'start'; readable: ReadableStream<VideoFrame> }
    | { type: 'gain'; db: number }
    | { type: 'composite'; requestId: string }
    | { type: 'stop' };

  if (msg.type === 'start') {
    ensureCanvases();
    void consume(msg.readable);
    return;
  }
  if (msg.type === 'gain') {
    currentGain = msg.db;
    return;
  }
  if (msg.type === 'composite') {
    let out: { dataUrl: string; capturedAt: number } | null = null;
    try {
      out = await composite();
    } catch {
      out = null;
    }
    self.postMessage({ type: 'grid', requestId: msg.requestId, grid: out, framesSeen });
    return;
  }
  if (msg.type === 'stop') {
    running = false;
    encodeCanvas = null;
    encodeCtx = null;
    liveBest?.close();
    liveBest = null;
    ring.length = 0;
    gainTrace.length = 0;
    thumbTrace.length = 0;
  }
};

export {};
