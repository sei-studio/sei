/**
 * Backseat capture worker — the ring buffer, the local signals, and the
 * image-grid compositor. Runs off the main thread because the capture loop must
 * survive the player being in a fullscreen game with Sei behind it: a worker is
 * never rAF-throttled, and MediaStreamTrackProcessor's readable is
 * transferable, so the frames come straight here.
 *
 * ── Why this does not hold 900 frames ────────────────────────────────────
 *
 * At 60 fps, BUFFER_MS of retained 720p video is several hundred raw frames —
 * several GB, or 60 JPEG encodes a second, and neither is survivable on a
 * machine that is also running a game.
 *
 * It does not have to be. The grid only ever reads six moments out of the
 * buffer, and GRID_OFFSETS_S says in advance roughly where they land, so the
 * ring only needs to be fine enough to resolve the tightest gap in that table
 * (187 ms). SAMPLE_INTERVAL_MS = 100 ms clears it with room to spare: one
 * cell-sized JPEG every tenth of a second, ~90 of them (~3 MB) covering
 * BUFFER_MS, at 10 encodes/second rather than 60.
 *
 * The full-rate 60 fps video is not lost either: MediaRecorder in the
 * controller keeps it for clip export, which is the only thing that actually
 * needs every frame.
 *
 * 260801: this used to keep ONE frame per one-second bucket, chosen by running
 * argmax over audio gain. That made the cell spacing depend on where the loud
 * moments fell — consecutive cells 40 ms to 1.9 s apart, under a prompt that
 * claimed "about a second apart" — which is why the companion could never read
 * a sequence off the grid. Uniform sampling plus a fixed offset table replaces
 * it, and the selection rule no longer depends on audio at all (which also
 * retires the video-only special case it used to need).
 *
 * Frames are still examined at capture rate for two signals, both cheap enough
 * to run on every single frame: the audio gain, and a 32x18 thumbnail whose
 * frame-to-frame distance is the colour-jolt trigger.
 */

import {
  BUFFER_MS,
  CELL_W,
  CELL_H,
  GRID_W,
  GRID_H,
  GRID_COLS,
  GRID_FRAMES,
  GRID_OFFSETS_S,
  SAMPLE_INTERVAL_MS,
  SAMPLE_TOLERANCE_MS,
  JOLT_COLOR_DELTA,
  JOLT_GAIN_DB,
  JOLT_REFRACTORY_MS,
} from '../../../../shared/backseatIpc';
import {
  baselineGain,
  colorDelta,
  createJoltState,
  decideJolt,
  pushGain,
  pushThumb,
  THUMB_H,
  THUMB_W,
} from './signals';

/** How often a thumbnail is retained for the colour comparison. At capture
 *  rate that would be 60 a second to answer a question about one second ago. */
const THUMB_INTERVAL_MS = 100;
/** Retained-frame JPEG quality. The model reads shapes and banners off these,
 *  not fine text, so this is well above what it needs. */
const CELL_QUALITY = 0.72;
const GRID_QUALITY = 0.82;

interface Sample {
  /** Capture time of the frame this was encoded from. */
  at: number;
  jpeg: Blob;
}

// ── Worker state ──────────────────────────────────────────────────────────

let cellCanvas: OffscreenCanvas | null = null;
let cellCtx: OffscreenCanvasRenderingContext2D | null = null;
/** Separate surface for the JPEG encode. It has to be separate: convertToBlob
 *  is async, and the frame loop keeps drawing into cellCanvas while it is
 *  pending, so encoding through the live canvas would sometimes write a LATER
 *  frame into the sample. The copy into it is synchronous, which is what pins
 *  the sample to the moment it claims. */
let encodeCanvas: OffscreenCanvas | null = null;
let encodeCtx: OffscreenCanvasRenderingContext2D | null = null;
let thumbCanvas: OffscreenCanvas | null = null;
let thumbCtx: OffscreenCanvasRenderingContext2D | null = null;
let gridCanvas: OffscreenCanvas | null = null;
let gridCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Samples, oldest first, spanning at most BUFFER_MS. */
const ring: Sample[] = [];
/** When the last sample was taken, so the 10 Hz cadence is independent of the
 *  capture rate (which varies with what the shared window is doing). */
let lastSampleAt = 0;
/** One encode in flight at a time. At 10 Hz with a ~2 ms encode this never
 *  actually skips; it exists so a stalled encode drops samples instead of
 *  queueing them and pushing them out of order. */
let encoding = false;

/** Latest audio loudness, posted from the main thread (dBFS, -100..0). It
 *  arrives on its own cadence, so it is held here and sampled per frame. */
let currentGain = -100;
/** Rolling state for both local signals. The arithmetic lives in signals.ts so
 *  the offline sim can run exactly this code over recorded footage. */
const jolt = createJoltState();

let running = false;
/** Frames seen vs samples encoded, surfaced for diagnostics. */
let framesSeen = 0;
let encodes = 0;

/**
 * Periodic signal report (260728), so "is the jolt arm alive" is answerable
 * from the dev console instead of by faith: the controller logs each one, and
 * the overlay's console is forwarded to the terminal in dev. Numbers only —
 * the controller owns the wording.
 */
const STATS_INTERVAL_MS = 10_000;
let lastStatsAt = 0;
let statsFramesSeen = 0;
let statsEncodes = 0;

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

/** The thresholds the app runs at. signals.ts takes them as an argument so the
 *  offline sim can sweep them without touching shipped constants. */
const JOLT_THRESHOLDS = {
  gainDb: JOLT_GAIN_DB,
  colorDelta: JOLT_COLOR_DELTA,
  refractoryMs: JOLT_REFRACTORY_MS,
};

// ── Sampling ──────────────────────────────────────────────────────────────

/**
 * Freeze the current frame into the ring. The copy onto the encode surface is
 * synchronous, so the JPEG is of the frame that was live at `at` even though
 * the encode itself finishes later and the frame loop has moved on.
 */
function sample(at: number): void {
  if (encoding) return;
  encoding = true;
  try {
    encodeCtx!.drawImage(cellCanvas!, 0, 0);
  } catch {
    encoding = false;
    return;
  }
  void encodeCanvas!
    .convertToBlob({ type: 'image/jpeg', quality: CELL_QUALITY })
    .then((jpeg) => {
      ring.push({ at, jpeg });
      while (ring.length && at - ring[0].at > BUFFER_MS) ring.shift();
      encodes++;
    })
    // A dropped sample costs at most one grid cell, never the session.
    .catch(() => {})
    .finally(() => {
      encoding = false;
    });
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
  pushGain(jolt, now, currentGain);
  const lastThumbAt = jolt.thumbTrace.length
    ? jolt.thumbTrace[jolt.thumbTrace.length - 1][0]
    : 0;
  if (now - lastThumbAt >= THUMB_INTERVAL_MS) pushThumb(jolt, now, thumb);

  // Uniform 10 Hz, independent of the capture rate. sample() returns
  // immediately; the encode finishes on a microtask so the frame loop is never
  // stalled by it.
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    sample(now);
  }

  const fired = decideJolt(jolt, now, thumb, JOLT_THRESHOLDS);
  if (fired) {
    self.postMessage({
      type: 'jolt',
      reason: fired,
      at: now,
      gainDb: round1(currentGain),
      baseDb: round1(baselineGain(jolt)),
      colorDelta: round3n(colorDelta(jolt, now, thumb)),
    });
  }

  if (now - lastStatsAt >= STATS_INTERVAL_MS) {
    const span = now - lastStatsAt;
    self.postMessage({
      type: 'stats',
      // null on the first report: there is no previous window to rate against.
      fps: lastStatsAt ? Math.round(((framesSeen - statsFramesSeen) * 1000) / span) : null,
      // Should sit at ~10/s. Below that means the encode is not keeping up and
      // the grid's recent cells are landing off their offsets.
      eps: lastStatsAt ? Math.round(((encodes - statsEncodes) * 1000) / span) : null,
      gainDb: round1(currentGain),
      baseDb: round1(baselineGain(jolt)),
      colorDelta: round3n(colorDelta(jolt, now, thumb)),
      samples: ring.length,
    });
    lastStatsAt = now;
    statsFramesSeen = framesSeen;
    statsEncodes = encodes;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round3n(n: number | null): number | null {
  return n === null ? null : Math.round(n * 1000) / 1000;
}

// ── Grid compositing ──────────────────────────────────────────────────────

/** The sample closest in time to `target`, or null if the ring is empty. */
function nearest(target: number): Sample | null {
  let best: Sample | null = null;
  let bestGap = Infinity;
  for (const s of ring) {
    const gap = Math.abs(s.at - target);
    // The ring is ordered, so once the gap starts growing again the best is
    // behind us.
    if (gap > bestGap) break;
    best = s;
    bestGap = gap;
  }
  return best;
}

/**
 * Build the 3x2 grid, one cell per entry in GRID_OFFSETS_S, oldest in the
 * top-left, filled row-first — the arrangement IG-VLM (arXiv 2403.18406) found
 * best, and the one the prompt describes to the model.
 *
 * Every cell is resolved independently against wall-clock time rather than by
 * position in the ring, so a capture hiccup shifts nothing: an offset with no
 * sample within SAMPLE_TOLERANCE_MS leaves its cell black. A missing cell is
 * honest; a shifted one silently lies about the timeline, which is the failure
 * this whole redesign exists to fix.
 *
 * `offsets` reports what was ACTUALLY achieved, in seconds before capturedAt,
 * with null for a black cell. Nothing downstream depends on it — it is there so
 * a session log can show whether the spacing held.
 */
async function composite(): Promise<{
  dataUrl: string;
  capturedAt: number;
  offsets: Array<number | null>;
} | null> {
  if (!ring.length) return null;
  const now = Date.now();
  gridCtx!.fillStyle = '#000';
  gridCtx!.fillRect(0, 0, GRID_W, GRID_H);

  const picked: Array<Sample | null> = [];
  for (const offsetS of GRID_OFFSETS_S) {
    const hit = nearest(now - offsetS * 1000);
    picked.push(hit && Math.abs(hit.at - (now - offsetS * 1000)) <= SAMPLE_TOLERANCE_MS ? hit : null);
  }
  const newestAt = picked.reduce((m, s) => (s && s.at > m ? s.at : m), 0);
  // Every offset missed: the ring holds only samples older than the whole
  // table, so there is no honest grid to build.
  if (!newestAt) return null;

  for (let i = 0; i < GRID_FRAMES; i++) {
    const hit = picked[i];
    if (!hit) continue;
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(hit.jpeg);
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
    capturedAt: newestAt,
    offsets: picked.map((s) => (s ? Math.round(newestAt - s.at) / 1000 : null)),
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
    let out: Awaited<ReturnType<typeof composite>> = null;
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
    ring.length = 0;
    jolt.gainTrace.length = 0;
    jolt.thumbTrace.length = 0;
  }
};

export {};
