/**
 * Backseat offline simulator (260801).
 *
 *   npx tsx scripts/backseat-sim.ts <video.mp4> --dry
 *   npx tsx scripts/backseat-sim.ts <video.mp4>
 *
 * Runs a recorded clip through the real backseat pipeline and produces the
 * voice-over it would have generated: every wake, why it fired, and what the
 * companion said (or that it stayed quiet).
 *
 * The point of this existing at all is that backseat cannot be tested any
 * other way. Launching Electron spams keychain prompts, and even when it does
 * not, a live session is unrepeatable: the thresholds cannot be swept, the
 * timeline cannot be replayed, and "did the colour arm fire on that room
 * change" is a question about a moment that has already gone. Here the same
 * three minutes can be run fifty times with different constants.
 *
 * ── What is real and what is not ─────────────────────────────────────────
 *
 * REAL, imported rather than reimplemented:
 *   • the signal detectors (src/renderer/.../signals.ts) and the RMS meter
 *     (pcm.ts), so a threshold tuned here is tuned against shipping code;
 *   • the frame offsets, the grid geometry, and the JPEG compositing;
 *   • the idle distribution (nextIdleDelayMs), the priority ladder, the
 *     speak-gap and refractory floors;
 *   • BACKSEAT_CONTRACT and tickNote(), verbatim;
 *   • the model, the token cap, and the tool list.
 *
 * NOT real, and deliberately so:
 *   • the persona. buildSystemBlocks needs a character, a config and Electron
 *     paths; a fixed stub replaces it. So this measures TIMING and what the
 *     grid supports, not how any particular companion sounds.
 *   • user ticks. There is no player to type anything, so the top of the
 *     priority ladder is exercised by unit tests rather than here.
 *   • turn latency. A real turn takes a second or two of wall clock during
 *     which a jolt can preempt it; here that window is TURN_MS of virtual
 *     time.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';

import {
  CELL_H,
  CELL_W,
  GRID_DUPLICATE_DELTA,
  GRID_OFFSETS_S,
  gridLayout,
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  JOLT_COLOR_FLOOR,
  PREV_GRID_MAX_AGE_MS,
  PREV_GRID_SCALE,
  JOLT_COLOR_MAD,
  JOLT_GAIN_DB,
  JOLT_REFRACTORY_MS,
  MIN_SPEAK_GAP_MS,
  START_LOOK_MS,
  nextIdleDelayMs,
  SAMPLE_INTERVAL_MS,
  SAMPLE_TOLERANCE_MS,
  STT_SAMPLE_RATE,
  type BackseatTickKind,
} from '../src/shared/backseatIpc';
import {
  baselineGain,
  blockMaxDelta,
  colorDelta,
  COLOR_LOOKBACKS_MS,
  COLOR_REFRACTORY_MS,
  colorThreshold,
  createJoltState,
  decideJolt,
  pushGain,
  pushThumb,
  thumbAt,
  THUMB_H,
  THUMB_W,
} from '../src/renderer/src/lib/backseat/signals';
import { rmsDb } from '../src/renderer/src/lib/backseat/pcm';
import {
  BACKSEAT_CONTRACT,
  SAVE_CLIP_TOOL,
  stripDashes,
  tickNote,
} from '../src/main/backseat/backseatPrompts';

// ── Simulation constants ──────────────────────────────────────────────────

/** Virtual duration of a companion turn: the window in which a higher-priority
 *  wake can preempt it. Measured live at roughly 1-2 s for Haiku on a
 *  1548-token image plus a short transcript. */
const TURN_MS = 2_000;
/** Audio window the gain meter runs on, matching GAIN_WINDOW_SAMPLES in
 *  captureController.ts (~32 ms at 16 kHz). */
const GAIN_WINDOW_SAMPLES = 512;
/** JPEG quality, matching CELL_QUALITY / GRID_QUALITY in captureWorker.ts. */
const CELL_QUALITY = 72;
const GRID_QUALITY = 82;

const MODEL = process.env.SEI_SIM_MODEL || 'claude-haiku-4-5-20251001';

/**
 * The persona stub. Short on purpose: a long one would dominate the register
 * and make the output a review of the persona rather than of the timing.
 */
const STUB_PERSONA =
  'You are Sui, a friend of the player who is hanging out and watching them play over a screen share. ' +
  'You are warm, blunt, and genuinely interested in the game. You have no other context about them.';

// ── CLI ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const VIDEO = path.resolve(
  positional[0] ?? path.join(os.homedir(), 'Downloads', 'valorant-clips.mp4'),
);
const DRY = flag('dry');
const SEED = Number(opt('seed', '7'));
const TH = {
  gainDb: Number(opt('gain', String(JOLT_GAIN_DB))),
  colorMad: Number(opt('colormad', String(JOLT_COLOR_MAD))),
  colorFloor: Number(opt('colorfloor', String(JOLT_COLOR_FLOOR))),
  refractoryMs: Number(opt('refractory', String(JOLT_REFRACTORY_MS))),
  colorRefractoryMs: Number(opt('colorrefractory', String(COLOR_REFRACTORY_MS))),
};
/**
 * Ground-truth event times in seconds, `--marks 0,14,28,34,50,53,64`.
 *
 * A colour or gain distribution says whether the arm CAN fire; it does not say
 * whether it fired on the thing a human would have looked up at. Supplying the
 * moments by hand and scoring against them is the only way to tell a detector
 * that found the events from one that produced the same count of jolts
 * somewhere else in the clip.
 */
const MARKS = opt('marks', '')
  .split(',')
  .filter((s) => s.trim() !== '')
  .map((s) => Number(s.trim()) * 1000)
  .filter((n) => Number.isFinite(n));
/** How late a jolt may be and still count as that mark. A transition takes a
 *  few hundred ms and the 2.5 s lookback only reaches full size once the whole
 *  slide is behind it, so a hit is legitimately late; the window is one-sided
 *  for that reason (a jolt BEFORE the mark cannot have been caused by it). */
const MARK_LATE_MS = Number(opt('marktol', '3500'));
const MARK_EARLY_MS = 700;

/** What the tick claims is being shared (260804). Live this is the window
 *  title; here the clip's filename is the closest honest stand-in, and --label
 *  overrides it for testing how much the label actually steers a run. */
const SHARE_LABEL = opt('label', path.parse(VIDEO).name);
const OUT = path.resolve(opt('out', path.join('.backseat-sim', path.parse(VIDEO).name)));
const PREP = path.join(OUT, 'prep');

/** Deterministic uniforms, so a run is reproducible and two threshold sweeps
 *  see the same idle schedule. mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const ff = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
};

// ── Stage A: pull the clip apart ──────────────────────────────────────────

/**
 * Three extractions, all at the rates the app actually runs at:
 *
 *   frames  cell-sized JPEGs at SAMPLE_INTERVAL_MS, the ring buffer.
 *   thumbs  32x18 RGBA at the same rate, what the colour arm reads. RGBA
 *           rather than RGB so the bytes are stride-4 exactly like
 *           getImageData's, and thumbDelta needs no adapter.
 *   pcm     16 kHz mono f32, what the gain meter reads.
 *
 * The `scale ... force_original_aspect_ratio=decrease` + `pad` pair is the
 * ffmpeg spelling of drawFitted() in captureWorker.ts: letterbox, never
 * stretch. A stretched cell is a cell the model reads wrong.
 */
function prepare(): { fps: number; durationMs: number } {
  const fps = 1000 / SAMPLE_INTERVAL_MS;
  const marker = path.join(PREP, `.done-${fps}`);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', VIDEO,
    ]).toString(),
  ) as { format: { duration: string } };
  const durationMs = Math.floor(Number(probe.format.duration) * 1000);

  if (existsSync(marker)) return { fps, durationMs };
  mkdirSync(path.join(PREP, 'frames'), { recursive: true });

  const fit =
    `scale=${CELL_W}:${CELL_H}:force_original_aspect_ratio=decrease,` +
    `pad=${CELL_W}:${CELL_H}:(ow-iw)/2:(oh-ih)/2:black`;

  console.log(`[sim] extracting frames at ${fps} Hz (this takes a minute)`);
  ff(['-i', VIDEO, '-vf', `fps=${fps},${fit}`, '-q:v', '4',
      path.join(PREP, 'frames', '%06d.jpg')]);

  console.log('[sim] extracting thumbnails');
  ff(['-i', VIDEO, '-vf', `fps=${fps},scale=${THUMB_W}:${THUMB_H}`,
      '-pix_fmt', 'rgba', '-f', 'rawvideo', path.join(PREP, 'thumbs.raw')]);

  console.log('[sim] extracting audio');
  try {
    ff(['-i', VIDEO, '-vn', '-ac', '1', '-ar', String(STT_SAMPLE_RATE),
        '-f', 'f32le', path.join(PREP, 'audio.f32')]);
  } catch {
    // Video-only is a supported session shape; the colour arm still works.
    console.warn('[sim] no audio track: the gain arm cannot fire');
    writeFileSync(path.join(PREP, 'audio.f32'), Buffer.alloc(0));
  }
  writeFileSync(marker, '');
  return { fps, durationMs };
}

// ── Stage B: the signal timeline ──────────────────────────────────────────

interface Step {
  t: number;
  gainDb: number;
  baseDb: number;
  colorDelta: number | null;
  /** The bar the colour arm had to clear at this instant. It moves with the
   *  screen (signals.colorThreshold), so the delta alone means nothing. */
  colorThr: number;
  /**
   * The same block-max distance against EACH lookback separately, in
   * COLOR_LOOKBACKS_MS order (260803). colorDelta is their max, which hides
   * which window actually saw the change, and that is the question every
   * lookback-table decision turns on: a hard cut is equal in both, a slide
   * transition is carried by the long one alone.
   */
  perLookback: Array<number | null>;
}
interface JoltEvent {
  t: number;
  reason: 'gain' | 'color';
  gainDb: number;
  baseDb: number;
  colorDelta: number | null;
  colorThr: number;
}

/**
 * Walk the clip at SAMPLE_INTERVAL_MS through the REAL detector and record
 * both the per-step signal values and every jolt it raises.
 *
 * The jolt timeline is precomputable in one pass because nothing downstream
 * feeds back into it: the refractory period depends only on previous jolts,
 * never on whether a turn ran or what the model said. The idle schedule is the
 * opposite (it resets whenever the companion speaks) which is why that one is
 * walked sequentially in stage C.
 */
/** The 32x18 RGBA thumbnails, loaded once. Shared between the signal timeline
 *  and the compositor, which needs them to drop duplicate cells exactly the way
 *  captureWorker does (it keeps one alongside every ring sample). */
let thumbBytes: Buffer | null = null;
const THUMB_STRIDE = THUMB_W * THUMB_H * 4;
function thumbAtIndex(i: number): Uint8ClampedArray | null {
  if (!thumbBytes) thumbBytes = readFileSync(path.join(PREP, 'thumbs.raw'));
  if (i < 0 || (i + 1) * THUMB_STRIDE > thumbBytes.length) return null;
  return new Uint8ClampedArray(
    thumbBytes.buffer.slice(
      thumbBytes.byteOffset + i * THUMB_STRIDE,
      thumbBytes.byteOffset + (i + 1) * THUMB_STRIDE,
    ),
  );
}

function signalTimeline(durationMs: number): { steps: Step[]; jolts: JoltEvent[] } {
  if (!thumbBytes) thumbBytes = readFileSync(path.join(PREP, 'thumbs.raw'));
  const stride = THUMB_STRIDE;
  const pcmBuf = readFileSync(path.join(PREP, 'audio.f32'));
  const pcm = new Float32Array(
    pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength),
  );

  const st = createJoltState();
  const steps: Step[] = [];
  const jolts: JoltEvent[] = [];
  let gainCursor = 0; // samples of PCM already metered

  const nThumbs = Math.floor(thumbBytes.length / stride);
  for (let i = 0; i < nThumbs; i++) {
    const t = i * SAMPLE_INTERVAL_MS;
    if (t > durationMs) break;

    // Push every 32 ms audio window up to now, not one per video step. The app
    // meters audio on its own clock and the frame loop just reads the latest
    // value, so metering at the video rate here would drop two thirds of the
    // windows — and a gunshot is exactly the kind of short transient that
    // would fall in a gap.
    const upTo = Math.min(pcm.length, Math.floor((t / 1000) * STT_SAMPLE_RATE));
    while (gainCursor + GAIN_WINDOW_SAMPLES <= upTo) {
      const win = pcm.subarray(gainCursor, gainCursor + GAIN_WINDOW_SAMPLES);
      const at = ((gainCursor + GAIN_WINDOW_SAMPLES) / STT_SAMPLE_RATE) * 1000;
      pushGain(st, at, rmsDb(win));
      gainCursor += GAIN_WINDOW_SAMPLES;
    }

    const thumb = new Uint8ClampedArray(
      thumbBytes.buffer.slice(
        thumbBytes.byteOffset + i * stride,
        thumbBytes.byteOffset + (i + 1) * stride,
      ),
    );

    const delta = colorDelta(st, t, thumb);
    const base = baselineGain(st);
    // Read before decideJolt, which is what folds this sample into the colour
    // baseline; reading after would report a bar the decision never saw.
    const bar = colorThreshold(st, TH);
    // Recomputed rather than returned by colorDelta: this is a reporting-only
    // breakdown and signals.ts has no use for it, so it stays out of the
    // shipping path.
    const perLookback = COLOR_LOOKBACKS_MS.map((ageMs) => {
      const past = thumbAt(st, t, ageMs);
      return past ? Math.round(blockMaxDelta(thumb, past) * 1000) / 1000 : null;
    });
    steps.push({
      t,
      gainDb: Math.round(st.currentGain * 10) / 10,
      baseDb: Math.round(base * 10) / 10,
      colorDelta: delta === null ? null : Math.round(delta * 1000) / 1000,
      colorThr: Math.round(bar * 1000) / 1000,
      perLookback,
    });

    const fired = decideJolt(st, t, thumb, TH);
    if (fired) {
      jolts.push({
        t,
        reason: fired,
        gainDb: steps[steps.length - 1].gainDb,
        baseDb: steps[steps.length - 1].baseDb,
        colorDelta: steps[steps.length - 1].colorDelta,
        colorThr: steps[steps.length - 1].colorThr,
      });
    }
    pushThumb(st, t, thumb);
  }
  return { steps, jolts };
}

// ── Grid compositing ──────────────────────────────────────────────────────

let frameFiles: string[] = [];
function frameIndexAt(t: number): number | null {
  // ffmpeg numbers from 1, and frame N covers [(N-1)*interval, N*interval).
  const idx = Math.round(t / SAMPLE_INTERVAL_MS);
  if (!frameFiles[idx]) return null;
  // The nearest available frame is at most half an interval away by
  // construction, so the tolerance only ever rejects times outside the clip.
  return Math.abs(idx * SAMPLE_INTERVAL_MS - t) <= SAMPLE_TOLERANCE_MS ? idx : null;
}

/**
 * The same grid captureWorker.composite() builds: one cell per offset,
 * row-first, with consecutive duplicates dropped and the canvas sized to the
 * survivors (260804).
 *
 * The duplicate test is the shipped one, blockMaxDelta over the same 32x18
 * thumbnails against the same GRID_DUPLICATE_DELTA, which is the whole point of
 * the sim: what it drops here is what the app drops.
 */
async function buildGrid(
  now: number,
): Promise<{ jpeg: Buffer; small: Buffer; ages: number[]; offsets: number[]; dropped: number } | null> {
  const picked: Array<{ file: string; at: number; offset: number }> = [];
  for (const o of GRID_OFFSETS_S) {
    const target = now - o * 1000;
    if (target < 0) continue;
    const idx = frameIndexAt(target);
    if (idx === null) continue;
    const at = idx * SAMPLE_INTERVAL_MS;
    if (picked.length && picked[picked.length - 1].at === at) continue;
    const prev = thumbAtIndex(Math.round(picked[picked.length - 1]?.at / SAMPLE_INTERVAL_MS));
    const cur = thumbAtIndex(idx);
    if (picked.length && prev && cur && blockMaxDelta(prev, cur) <= GRID_DUPLICATE_DELTA) continue;
    picked.push({ file: frameFiles[idx], at, offset: o });
  }
  if (!picked.length) return null;

  const { cols, w, h } = gridLayout(picked.length);
  const jpeg = await sharp({ create: { width: w, height: h, channels: 3, background: '#000' } })
    .composite(
      picked.map((p, i) => ({
        input: p.file,
        left: (i % cols) * CELL_W,
        top: Math.floor(i / cols) * CELL_H,
      })),
    )
    .jpeg({ quality: GRID_QUALITY })
    .toBuffer();

  // The half-size copy the app's worker also produces, which rides along with
  // the NEXT turn as the companion's memory of what it last looked at.
  const small = await sharp(jpeg)
    .resize(Math.round(w * PREV_GRID_SCALE), Math.round(h * PREV_GRID_SCALE))
    .jpeg({ quality: GRID_QUALITY })
    .toBuffer();

  const newest = picked[picked.length - 1].at;
  return {
    jpeg,
    small,
    ages: picked.map((p) => Math.round(newest - p.at) / 1000),
    // Which entries of the offset table survived, for the render's strip.
    offsets: picked.map((p) => p.offset),
    dropped: GRID_OFFSETS_S.length - picked.length,
  };
}

// ── Stage C: the wake schedule and the turns ──────────────────────────────

interface Turn {
  t: number;
  kind: BackseatTickKind;
  joltReason?: 'gain' | 'color';
  signal?: { gainDb: number; baseDb: number; colorDelta: number | null; colorThr: number };
  ages: number[];
  offsets: number[];
  dropped: number;
  /** Filename of this turn's grid under <out>/grids. Recorded rather than left
   *  to position, because the render used to index a sorted readdir and a
   *  leftover file from an earlier run silently shifted every grid it drew. */
  grid?: string;
  reply: string;
  spoke: boolean;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

const PRIORITY: Record<BackseatTickKind, number> = { user: 4, start: 3, jolt: 2, idle: 1 };

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { durationMs } = prepare();
  frameFiles = ['', ...readdirSync(path.join(PREP, 'frames')).sort().map((f) =>
    path.join(PREP, 'frames', f),
  )];

  console.log(
    `[sim] ${path.basename(VIDEO)}, ${clock(durationMs)}, ` +
      `thresholds gain +${TH.gainDb}dB / color median+${TH.colorMad}*MAD ` +
      `(floor ${TH.colorFloor}), seed ${SEED}`,
  );

  const { steps, jolts } = signalTimeline(durationMs);
  writeFileSync(
    path.join(OUT, 'signals.csv'),
    `ms,gain_db,base_db,jump_db,color_delta,color_thr,` +
      COLOR_LOOKBACKS_MS.map((ms) => `d_${ms}`).join(',') +
      '\n' +
      steps
        .map((s) =>
          [
            s.t, s.gainDb, s.baseDb, Math.round((s.gainDb - s.baseDb) * 10) / 10,
            s.colorDelta ?? '', s.colorThr,
            ...s.perLookback.map((d) => d ?? ''),
          ].join(','),
        )
        .join('\n'),
  );

  reportSignals(steps, jolts);
  if (DRY) {
    console.log(`\n[sim] dry run, no model calls. signals.csv -> ${OUT}`);
    return;
  }

  // ── The wake schedule ───────────────────────────────────────────────────
  clearGrids();
  const rand = rng(SEED);
  const turns: Turn[] = [];
  let lastSpokeAt = -Infinity;
  /** The half-size grid from the last turn that produced a line. */
  let prevGrid: { small: Buffer; at: number } | null = null;
  let nextIdleAt = nextIdleDelayMs(rand);
  let joltIdx = 0;
  const client = new Anthropic({ apiKey: requireKey() });
  /** The session transcript: companion lines only, since nobody types. */
  const spokenLines: string[] = [];

  // The opening look (260803). The app fires this START_LOOK_MS after the share
  // opens; here the clip's t=0 IS the share opening, so it lands at the same
  // offset off the same ring. Straight through, with no speak-gap or preemption
  // check: it is the first tick of the session, so there is nothing to gate it
  // against and nothing in flight.
  {
    const grid = await buildGrid(START_LOOK_MS);
    if (grid) {
      const turn = await runTurn(
        client, spokenLines, START_LOOK_MS, lastSpokeAt, 'start', undefined, grid, prevGrid,
      );
      if (turn.spoke) {
        prevGrid = { small: grid.small, at: START_LOOK_MS };
        lastSpokeAt = START_LOOK_MS + TURN_MS;
      }
      turns.push(turn);
      turn.grid = `${turns.length.toString().padStart(3, '0')}-start.jpg`;
      writeFileSync(path.join(gridsDir(), turn.grid), grid.jpeg);
    } else {
      console.log(`[${clock(START_LOOK_MS)}] start skipped (ring too short)`);
    }
  }

  let t = START_LOOK_MS;
  while (t <= durationMs) {
    // Whichever comes first: the next scheduled look or the next jolt.
    while (joltIdx < jolts.length && jolts[joltIdx].t < t) joltIdx++;
    const nextJolt = jolts[joltIdx];
    const useJolt = nextJolt && (nextJolt.t <= nextIdleAt || nextIdleAt > durationMs);
    const at = useJolt ? nextJolt.t : nextIdleAt;
    if (at > durationMs) break;

    const kind: BackseatTickKind = useJolt ? 'jolt' : 'idle';
    if (useJolt) joltIdx++;
    else nextIdleAt = at + nextIdleDelayMs(rand);

    if (at - lastSpokeAt < MIN_SPEAK_GAP_MS) {
      console.log(`[${clock(at)}] ${kind} dropped (spoke ${((at - lastSpokeAt) / 1000).toFixed(1)}s ago)`);
      t = at;
      continue;
    }
    // Preemption. Only jolt-over-idle is reachable offline (there is no player
    // to raise a user tick), so rather than model an in-flight turn, look ahead
    // one turn's worth: an idle look that a jolt would have interrupted never
    // gets to speak, so it is not worth a model call.
    if (kind === 'idle') {
      const interrupter = jolts.find((j) => j.t > at && j.t < at + TURN_MS);
      if (interrupter && PRIORITY.jolt > PRIORITY.idle) {
        console.log(`[${clock(at)}] idle preempted by ${interrupter.reason} at ${clock(interrupter.t)}`);
        t = at;
        continue;
      }
    }

    const grid = await buildGrid(at);
    if (!grid) {
      t = at;
      continue;
    }
    const turn = await runTurn(
      client, spokenLines, at, lastSpokeAt, kind, useJolt ? nextJolt : undefined, grid, prevGrid,
    );
    // Only a turn that produced a line updates the memory, matching the
    // service: the prompt calls it "what you were looking at when you last
    // spoke", and that has to stay true.
    if (turn.spoke) prevGrid = { small: grid.small, at };
    turns.push(turn);
    turn.grid = `${turns.length.toString().padStart(3, '0')}-${kind}.jpg`;
    writeFileSync(path.join(gridsDir(), turn.grid), grid.jpeg);
    if (turn.spoke) {
      lastSpokeAt = at + TURN_MS;
      // The companion just spoke, so the scheduled look is pushed back a full
      // fresh interval — CaptureHandle.noteSpoke().
      nextIdleAt = lastSpokeAt + nextIdleDelayMs(rand);
    }
    t = at;
  }

  writeReports(turns, durationMs);
}

function gridsDir(): string {
  const d = path.join(OUT, 'grids');
  mkdirSync(d, { recursive: true });
  return d;
}

/** Clear the grid dumps from any previous run. They are keyed by turn number
 *  and wake kind, so a run with a different wake sequence leaves orphans behind
 *  that nothing overwrites. */
function clearGrids(): void {
  const d = gridsDir();
  for (const f of readdirSync(d)) if (f.endsWith('.jpg')) rmSync(path.join(d, f));
}

/**
 * The key, from the environment or from the nearest .env walking upward.
 *
 * Upward, not just cwd: this repo is worked on in git worktrees under
 * .claude/worktrees/, and .env is gitignored so it exists only in the primary
 * checkout. Looking in cwd alone means the sim never runs from a worktree,
 * which is where it will usually be run from.
 */
function requireKey(): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    let dir = process.cwd();
    for (;;) {
      const env = path.join(dir, '.env');
      if (existsSync(env)) {
        for (const line of readFileSync(env, 'utf8').split('\n')) {
          const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
          if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, '');
        }
        if (process.env.ANTHROPIC_API_KEY) break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set, and no .env holding one found above cwd');
  return key;
}

/**
 * One companion turn, with the real contract, the real note, and the real
 * cache layout: the breakpoint goes on the last stable message, never on the
 * one carrying the grid.
 *
 * The transcript shape mirrors toMessages() (chatService.ts:248) for the case
 * backseat actually hits. With no player typing, the chat history holds nothing
 * but companion lines, and toMessages MERGES consecutive same-role turns and
 * seats a neutral marker user turn in front, because Anthropic wants strict
 * alternation starting from the user. So the whole session collapses to two
 * messages that only ever grow at the end, which is what makes the breakpoint
 * below worth having: the prefix is byte-identical between ticks.
 *
 * Crucially the history is TEXT ONLY. Past grids do not accumulate — the real
 * service rebuilds from the chat store, which never held an image.
 */
async function runTurn(
  client: Anthropic,
  spokenLines: string[],
  at: number,
  lastSpokeAt: number,
  kind: BackseatTickKind,
  jolt: JoltEvent | undefined,
  grid: { jpeg: Buffer; small: Buffer; ages: number[]; offsets: number[]; dropped: number },
  prevGrid: { small: Buffer; at: number } | null,
): Promise<Turn> {
  const prevAge = prevGrid ? at - prevGrid.at : Infinity;
  const prev = prevAge <= PREV_GRID_MAX_AGE_MS ? prevGrid : null;
  const note = tickNote({
    kind,
    joltReason: jolt?.reason,
    secondsSinceLastLine: Number.isFinite(lastSpokeAt) ? (at - lastSpokeAt) / 1000 : null,
    sourceName: SHARE_LABEL,
    shareLabel: SHARE_LABEL,
    frameAges: grid.ages,
    secondsSincePrevGrid: prev ? prevAge / 1000 : undefined,
  });

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  if (spokenLines.length) {
    messages.push({ role: 'user', content: '[Session transcript begins here.]' });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: spokenLines.join('\n') }] });
    // The fourth breakpoint, on the last STABLE message. Never on the message
    // below: it carries a freshly composited ~1548-token grid and a note unique
    // to this tick, so a breakpoint there would pay the write multiplier every
    // turn and read back nothing. markMessageCached(), inlined because the sim
    // cannot import a main-process module without dragging Electron in.
    (messages[1].content as Array<{ cache_control?: unknown }>)[0].cache_control = {
      type: 'ephemeral',
    };
  }
  const image = (buf: Buffer): unknown => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
  });
  messages.push({
    role: 'user',
    // Previous grid first, current second, note last — the same order and the
    // same side of the cache breakpoint as backseatService.runTurn.
    content: [...(prev ? [image(prev.small)] : []), image(grid.jpeg), { type: 'text', text: note }],
  });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 160,
    system: [
      { type: 'text', text: STUB_PERSONA },
      { type: 'text', text: BACKSEAT_CONTRACT, cache_control: { type: 'ephemeral' } },
    ] as never,
    tools: [SAVE_CLIP_TOOL] as never,
    messages: messages as never,
  });

  // Through stripDashes, the same post-process the service runs, so the
  // voice-over reads exactly what a live session would say.
  const reply = stripDashes(
    res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
  );
  // 260802: silence is no longer offered, so this is an instruction being
  // ignored rather than a normal outcome. Still parsed, because the service
  // still parses it (a stray "(silence)" must never reach a voice call), and
  // still counted, because the count is the measurement of whether the
  // always-speak contract actually lands.
  const spoke = !!reply && !/^\(?silence\)?\.?$/i.test(reply);
  if (spoke) spokenLines.push(reply);

  const u = res.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const label = kind === 'jolt' ? `jolt:${jolt?.reason}` : kind;
  console.log(`[${clock(at)}] ${label} -> ${spoke ? `"${reply.replace(/\n/g, ' ')}"` : '(NO LINE)'}`);

  return {
    t: at,
    kind,
    joltReason: jolt?.reason,
    signal: jolt
      ? { gainDb: jolt.gainDb, baseDb: jolt.baseDb, colorDelta: jolt.colorDelta, colorThr: jolt.colorThr }
      : undefined,
    ages: grid.ages,
    offsets: grid.offsets,
    dropped: grid.dropped,
    reply,
    spoke,
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * p))];
}

/**
 * What the detectors saw, before any model is involved. This is the output
 * that matters for tuning: if the distributions never approach the thresholds,
 * no amount of prompt work will make the jolt arms useful.
 */
function reportSignals(steps: Step[], jolts: JoltEvent[]): void {
  const jumps = steps.map((s) => s.gainDb - s.baseDb).filter((n) => Number.isFinite(n));
  const deltas = steps.map((s) => s.colorDelta).filter((n): n is number => n !== null);

  const row = (name: string, xs: number[], th: number): void => {
    console.log(
      `  ${name.padEnd(12)} p50 ${pct(xs, 0.5).toFixed(3).padStart(8)}  ` +
        `p95 ${pct(xs, 0.95).toFixed(3).padStart(8)}  ` +
        `p99 ${pct(xs, 0.99).toFixed(3).padStart(8)}  ` +
        `max ${Math.max(...xs).toFixed(3).padStart(8)}  ` +
        `threshold ${th}  ` +
        `over ${xs.filter((x) => x >= th).length}/${xs.length}`,
    );
  };
  console.log('\n[sim] signal distributions over the whole clip');
  row('gain jump', jumps, TH.gainDb);
  // The colour row's "over" count is against the MOVING bar, one comparison per
  // step, which is the only meaningful version of that number now.
  const overColor = steps.filter(
    (s) => s.colorDelta !== null && s.colorDelta >= s.colorThr,
  ).length;
  const bars = steps.map((s) => s.colorThr);
  console.log(
    `  ${'color delta'.padEnd(12)} p50 ${pct(deltas, 0.5).toFixed(3).padStart(8)}  ` +
      `p95 ${pct(deltas, 0.95).toFixed(3).padStart(8)}  ` +
      `p99 ${pct(deltas, 0.99).toFixed(3).padStart(8)}  ` +
      `max ${Math.max(...deltas).toFixed(3).padStart(8)}  ` +
      `bar p50 ${pct(bars, 0.5).toFixed(3)}  over ${overColor}/${deltas.length}`,
  );

  console.log(
    `\n[sim] ${jolts.length} jolt(s) raised ` +
      `(refractory gain ${TH.refractoryMs / 1000}s, color ${TH.colorRefractoryMs / 1000}s)`,
  );
  for (const j of jolts) {
    console.log(
      `  [${clock(j.t)}] ${j.reason.padEnd(5)} ` +
        `gain ${j.gainDb} vs base ${j.baseDb} (jump ${(j.gainDb - j.baseDb).toFixed(1)}), ` +
        `colorDelta ${j.colorDelta ?? 'n/a'} vs bar ${j.colorThr}`,
    );
  }
  if (!jolts.length) {
    console.log('  none. Both arms are dead at these thresholds on this footage.');
  }
  if (MARKS.length) reportMarks(steps, jolts);
}

/**
 * Score the run against hand-marked event times (260803).
 *
 * Two separate questions, and they are worth keeping apart because a dial can
 * fix one without touching the other:
 *
 *   PEAK   what the colour delta actually reached around the mark, and how that
 *          compares to the bar in force there. A miss with peak < bar is a
 *          threshold problem; a miss with peak >= bar is a refractory problem,
 *          because the sample cleared the bar and was suppressed anyway.
 *   FIRED  whether a jolt was raised in the window. This is the outcome; the
 *          peak is the diagnosis.
 */
function reportMarks(steps: Step[], jolts: JoltEvent[]): void {
  console.log(`\n[sim] ground truth: ${MARKS.length} mark(s), window -${MARK_EARLY_MS / 1000}s / +${MARK_LATE_MS / 1000}s`);
  const matched = new Set<number>();
  let hits = 0;
  for (const m of MARKS) {
    const win = steps.filter((s) => s.t >= m - MARK_EARLY_MS && s.t <= m + MARK_LATE_MS);
    const peak = win.reduce<Step | null>(
      (a, s) => (s.colorDelta !== null && (!a || s.colorDelta > (a.colorDelta ?? -1)) ? s : a),
      null,
    );
    const j = jolts.find((x) => x.t >= m - MARK_EARLY_MS && x.t <= m + MARK_LATE_MS);
    if (j) {
      matched.add(j.t);
      hits++;
    }
    const clears = peak?.colorDelta != null && peak.colorDelta >= peak.colorThr;
    const why = j ? '' : clears ? '  (peak CLEARED the bar: suppressed)' : '  (peak below the bar)';
    console.log(
      `  [${clock(m)}] ${j ? `HIT  ${j.reason} at ${clock(j.t)} (+${((j.t - m) / 1000).toFixed(1)}s)` : 'MISS'.padEnd(24)}` +
        `  peak ${peak?.colorDelta ?? 'n/a'} at ${peak ? clock(peak.t) : '--:--'}` +
        ` vs bar ${peak?.colorThr ?? 'n/a'}` +
        ` [${peak?.perLookback.map((d) => (d === null ? '-' : d.toFixed(3))).join(' / ') ?? ''}]` +
        why,
    );
  }
  const extra = jolts.filter((j) => !matched.has(j.t));
  console.log(
    `  ${hits}/${MARKS.length} marks hit, ${extra.length} jolt(s) unmatched` +
      (extra.length ? `: ${extra.map((j) => `${clock(j.t)} ${j.reason}`).join(', ')}` : ''),
  );
}

function writeReports(turns: Turn[], durationMs: number): void {
  const spoken = turns.filter((t) => t.spoke);
  const mute = turns.length - spoken.length;
  const lines = [
    `# Backseat voice-over: ${path.basename(VIDEO)}`,
    '',
    `Clip ${clock(durationMs)}. ${turns.length} looks, ${spoken.length} lines` +
      // Not "silent": the prompts no longer offer silence, so a look with no
      // line is an instruction being ignored and should read as one.
      (mute ? `, ${mute} produced NO LINE despite the always-speak contract.` : '.'),
    `Thresholds: gain +${TH.gainDb} dB, colour median+${TH.colorMad}*MAD (floor ${TH.colorFloor}). ` +
      `Seed ${SEED}. Model ${MODEL}.`,
    '',
  ];
  for (const t of turns) {
    const label = t.kind === 'jolt' ? `jolt:${t.joltReason}` : t.kind;
    lines.push(`**[${clock(t.t)}] ${label}** ${t.spoke ? `"${t.reply}"` : '_(NO LINE)_'}`);
    lines.push(
      `> ${t.ages.length} frame(s) at -${t.ages.map((a) => a.toFixed(2)).join('/')}s` +
        (t.dropped ? `, ${t.dropped} dropped as duplicates` : ''),
    );
    lines.push('');
  }

  const totals = turns.reduce(
    (a, t) => ({
      input: a.input + (t.usage?.input ?? 0),
      cacheRead: a.cacheRead + (t.usage?.cacheRead ?? 0),
      cacheWrite: a.cacheWrite + (t.usage?.cacheWrite ?? 0),
      output: a.output + (t.usage?.output ?? 0),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
  lines.push('## Tokens', '');
  lines.push(`| | total | per look |`, `|---|---|---|`);
  for (const [k, v] of Object.entries(totals)) {
    lines.push(`| ${k} | ${v} | ${Math.round(v / Math.max(1, turns.length))} |`);
  }
  if (!totals.cacheRead && !totals.cacheWrite) {
    // Worth saying out loud rather than leaving as two zeros that read like a
    // regression. The cached prefix here is the stub persona plus the contract
    // plus the tools, around 1.1k tokens, and Haiku will not cache a prefix
    // below 2048. The app's prefix is buildSystemBlocks output — persona,
    // memory, knowledge, rolling summary — and clears that easily, so the
    // breakpoint placement has to be checked on a real session's
    // cacheRead/cacheWrite log lines, not here.
    lines.push(
      '',
      'No caching happened: the stub prefix is ~1.1k tokens and Haiku will not cache below 2048. ' +
        'The app prefix (buildSystemBlocks) is several times that, so the breakpoint placement has ' +
        'to be verified from a live session log instead.',
    );
  }

  writeFileSync(path.join(OUT, 'voiceover.md'), lines.join('\n'));
  writeFileSync(
    path.join(OUT, 'voiceover.json'),
    JSON.stringify({ video: VIDEO, TH, seed: SEED, shareLabel: SHARE_LABEL, turns }, null, 2),
  );
  console.log(
    `\n[sim] ${turns.length} looks, ${spoken.length} spoke, ${mute} did not. ` +
      `tokens: in ${totals.input}, cacheRead ${totals.cacheRead}, cacheWrite ${totals.cacheWrite}`,
  );
  console.log(`[sim] -> ${OUT}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
