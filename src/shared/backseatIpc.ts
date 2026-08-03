/**
 * Backseat: shared renderer <-> main contract (260728).
 *
 * The companion watches a window the player shares (video + audio) and talks
 * about it: reacting to what just happened, and — true to the name — pushing
 * for what it wants to see next. It can also save the last 15 seconds as a clip
 * and drop it into the normal chat thread.
 *
 * Authority split, mirroring chess/Draw!:
 *
 *   renderer  owns PIXELS AND SOUND. It runs getDisplayMedia, keeps the ring
 *             buffer, scores every frame, composites the image grid, records
 *             the rolling clip, runs local STT over the game audio, and raises
 *             every wake. It decides nothing about what the companion says.
 *   main      owns the SESSION AND THE MODEL CALL: the companion turn (Haiku),
 *             clip files, analytics, and the continuity rows. It never sees a
 *             raw frame, only finished grids. (On macOS it also SUPPLIES the
 *             sound: it spawns the bundled ScreenCaptureKit tap and relays raw
 *             PCM to the overlay renderer — see `backseat:pcm` below — because
 *             Chromium loopback is Windows-only.)
 *
 * Audio never reaches the big model as audio (260728). Screen sound exists for
 * exactly two consumers, both local: the GAIN signal (the jolt trigger) and the
 * STT TRANSCRIPT (the same packaged Whisper model voice calls use). The
 * transcript of the grid's window rides each tick as text.
 *
 * The unit of work is a TICK: one image grid plus the reason it fired. Ticks
 * are raised three ways, in descending priority (see BackseatTickKind):
 *
 *   1. 'user'     the player said or typed something. Always answered.
 *   2. 'jolt'     a large local audio/colour discontinuity. No model in the
 *                 loop — see JOLT_* below.
 *   3. 'idle'     the scheduled look: a randomised IDLE_* timer, nothing more.
 *
 * 260801: there used to be a fourth source, a small VLM on DeepInfra asked
 * every 6 s whether the grid was interesting. It is gone. Measured on real
 * footage it had a strong yes-bias, and the narration-novelty scheme meant to
 * replace it carried 0.037 of real signal against 0.25 of resampling noise
 * (.planning/backseat-v2-260801.md). A dice roll is cheaper and no worse, and
 * unlike a gate it cannot be wrong in a way that is invisible.
 *
 * Both text mode and voice mode use the SAME chat thread and the same
 * per-character memory as every other surface; backseat is a lens on the
 * existing conversation, not a second one.
 */

// ── Ring buffer ───────────────────────────────────────────────────────────
//
// There are TWO independent buffers, and conflating them was the first design's
// mistake. The frame ring only ever needs to reach back far enough to build a
// grid, plus slack for the latency between a trigger firing and the composite
// being requested. That is GRID_OFFSETS_S[0] + a few seconds, NOT 15.
//
// The 15 seconds belongs solely to CLIP capture (the Outplayed-style "save that
// bit" feature), which is served by MediaRecorder and nothing else. So clipping
// can be switched off independently, and when it is, the whole MediaRecorder
// path disappears and the retained window shrinks to BUFFER_MS.

/**
 * How far back the frame ring reaches: one grid's span (6 s) plus 3 s of slack,
 * so a tick that fires and then waits on a composite still finds its own moment
 * in the buffer rather than a window that has already rolled past it.
 */
export const BUFFER_MS = 9_000;
/** Length of a saved clip. Only meaningful when clipping is enabled. */
export const CLIP_MS = 15_000;
/**
 * Whether the rolling clip recorders run at all.
 *
 * They are the single most expensive thing in the pipeline: two MediaRecorders
 * continuously encoding 720p60 for the whole session, purely so that a rare
 * save_clip call has something to harvest. Everything else backseat does (the
 * grid, both local triggers, the schedule) is unaffected by turning this off, so
 * this is the first dial to reach for if capture is costing too much.
 */
export const CLIPS_ENABLED = true;
/** Frame retention target. The capture loop degrades gracefully below this. */
export const CAPTURE_FPS = 60;
/** Capture resolution requested from getDisplayMedia (downscaled per cell). */
export const CAPTURE_W = 1280;
export const CAPTURE_H = 720;

// ── Image grid (IG-VLM, arXiv 2403.18406) ─────────────────────────────────
//
// The paper's finding, reproduced here exactly: SIX frames, composited into a
// single image on a 3-row x 2-column grid, filled row-first (left to right,
// then down). N=6 beat 4/9/12/16/20, and near-square grids beat wide ones —
// which is why 3x2 (not 2x3) is right for 16:9 cells: 2 cells across by 3 down
// gives a 32:27 canvas, close to square, where 2 rows of 3 would be 32:9.
//
// Sizing is pinned to what Haiku 4.5 can actually see. It is a STANDARD-tier
// vision model: long edge <= 1568 px AND <= 1568 visual tokens, where an image
// costs ceil(w/28) * ceil(h/28) tokens. Anything larger is downscaled server
// side, so sending more pixels than this buys nothing and just costs upload.
//
// Maximising ceil(w/28)*ceil(h/28) <= 1568 at a 32:27 aspect gives 43x36
// patches = 1204x1008 px = 1548 tokens, the largest legal grid that still
// looks like the source. (44x35=1540 and 42x37=1554 both fit the token cap but
// distort the aspect ratio further.) Each cell is then 602x336.
//
// If this is ever pointed at a high-resolution-tier model (4.7+, 2576 px /
// 4784 tokens) these four numbers are the only thing that needs to change.

export const GRID_COLS = 2;
export const GRID_ROWS = 3;
export const GRID_FRAMES = GRID_COLS * GRID_ROWS; // 6
export const CELL_W = 602;
export const CELL_H = 336;
export const GRID_W = CELL_W * GRID_COLS; // 1204
export const GRID_H = CELL_H * GRID_ROWS; // 1008
/** What the above costs Haiku, asserted in tests so a resize cannot silently
 *  blow the cap and get the grid downscaled behind our back. */
export const GRID_VISUAL_TOKENS = Math.ceil(GRID_W / 28) * Math.ceil(GRID_H / 28); // 1548

// ── Dropping duplicate frames (260804) ────────────────────────────────────
//
// The grid was always six cells, so a screen that had not moved was sent as six
// copies of one picture. The companion noticed and said so, which is the
// clearest possible signal that it was reading the repetition as meaningful:
// asked what was happening it wanted to know why it had been shown "six
// identical YouTube frames". It was a fair question. Six identical cells claim
// six sampled moments and carry the information of one, at 1548 tokens.
//
// So consecutive cells that are the same picture collapse to one, and the grid
// is built at whatever size the survivors need. A paused video costs 264 tokens
// instead of 1548; a firefight still costs the full six.
//
// The comparison is deliberately conservative: it is the LARGEST change over a
// 4x3 split of the 32x18 thumbnail (signals.blockMaxDelta, the same measure the
// colour jolt arm uses), so a change that covers only a corner of the screen
// still counts as a difference. Anything at or under this is JPEG noise on a
// still image. Erring toward keeping a frame is right — a redundant cell costs
// tokens, a dropped one costs the sequence.

/** At or below this largest-block distance two frames are the same picture. */
export const GRID_DUPLICATE_DELTA = 0.02;

/**
 * Rows and columns for a grid of `n` frames, and what it costs.
 *
 * Near-square wherever there is a choice, for the reason the six-cell layout is
 * 2x3 and not 3x2: a wide canvas of 16:9 cells is mostly cell and barely grid,
 * and the vision model reads a squarer arrangement more reliably. Three across
 * is not an option at any count, because 3 * 602 = 1806 px is past Haiku's
 * 1568 px long edge and would be downscaled server side.
 */
export function gridLayout(n: number): { cols: number; rows: number; w: number; h: number } {
  const count = Math.max(1, Math.min(GRID_FRAMES, Math.round(n)));
  const cols = count <= 3 ? 1 : 2;
  const rows = Math.ceil(count / cols);
  return { cols, rows, w: CELL_W * cols, h: CELL_H * rows };
}

/** Visual-token cost of a layout, by Anthropic's ceil(w/28)*ceil(h/28). */
export function gridVisualTokens(n: number): number {
  const { w, h } = gridLayout(n);
  return Math.ceil(w / 28) * Math.ceil(h / 28);
}

// ── The previous grid, carried as memory (260802) ─────────────────────────
//
// Chat history is text, and the service rebuilds every turn's messages from the
// chat store, which has never held an image. So until now each look was the
// companion's entire visual world: it could read its own last LINE but had no
// idea what it had been looking at when it wrote it. With silence removed and
// every look producing a line, that gap becomes the main failure mode, because
// the only way to avoid repeating yourself about an unchanged screen is to know
// what the screen looked like last time.
//
// The previous grid therefore rides along with the current one, at HALF linear
// size: 602x504 is 396 visual tokens against the full grid's 1548, all six
// cells still present, and unmistakably the older and smaller of the two images
// so it cannot be confused for now. The renderer produces it at composite time,
// so the main process never has to touch pixels to build a prompt.
//
// It sits AFTER the cache breakpoint, as plain input. Putting it in the history
// to earn a cache read would change the message array's shape on every tick and
// invalidate the whole prefix, which costs far more than the 396 tokens it
// would save.

export const PREV_GRID_SCALE = 0.5;
export const PREV_GRID_W = GRID_W * PREV_GRID_SCALE; // 602
export const PREV_GRID_H = GRID_H * PREV_GRID_SCALE; // 504
export const PREV_GRID_VISUAL_TOKENS =
  Math.ceil(PREV_GRID_W / 28) * Math.ceil(PREV_GRID_H / 28); // 396
/**
 * Past this age the previous grid is dropped rather than sent. The scheduled
 * look tops out at IDLE_MAX_MS, so anything older than a few minutes means the
 * session was paused, and a picture from before a pause is a picture of a
 * different moment entirely.
 */
export const PREV_GRID_MAX_AGE_MS = 180_000;

// ── Frame spacing: logarithmic, not uniform (260801) ──────────────────────
//
// Six frames at 1 Hz cannot show a sequence. A dodge-then-fire is roughly
// 600 ms end to end, so at one sample a second it is either one frame or none,
// and the companion's "you dodged then fired" was never recoverable from the
// pixels it was given. Worse, the frames were not even at 1 Hz: the old worker
// picked each cell by running argmax over audio gain inside a one-second
// bucket, so consecutive cells landed 40 ms to 1.9 s apart while the prompt
// claimed "about a second apart". Every temporal inference sat on a false clock.
//
// The offsets below are geometric, ratio 2, measured back from the moment the
// grid is composited. Three consequences, all wanted:
//
//   • the same six-second reach as before, so context is not lost;
//   • the last three cells are all inside the final second, which is where an
//     action-then-consequence pair actually lives;
//   • the gaps halve toward the present, which the prompt states, and which is
//     itself a hint that the bottom of the grid is where to look.
//
// Verified on real footage before it was built: on a Valorant grid the HUD
// round timer reads 1:13 / 1:10 / 1:08 / 1:07 / 1:07 / 1:07 across the cells —
// exactly the 3.0 / 1.5 / 0.75 / sub-second deltas — and the ammo counter reads
// 5 / 1 / 6 / 6 / 5 / 4, resolving fire-through-cover, reload, emerge, aim,
// fire into three distinct states inside the last 600 ms.
export const GRID_OFFSETS_S = [6.0, 3.0, 1.5, 0.75, 0.375, 0.1875];

/**
 * Ring sample rate. Uniform 10 Hz: the tightest gap in the table above is
 * 187 ms (0.375 -> 0.1875), so 100 ms sampling resolves every cell with at most
 * 50 ms of placement error. One cell-sized JPEG per sample, ~90 resident over
 * BUFFER_MS (~3 MB) at 10 encodes/second, replacing the old 1/second.
 *
 * A tiered scheme (ImageBitmaps for the recent cells, JPEGs for the old) was
 * considered and rejected: ~18 MB of bitmaps to save 9 encodes/second of a
 * 602x336 JPEG, and two retention paths where one will do.
 */
export const SAMPLE_INTERVAL_MS = 100;

/**
 * How far a sample may sit from its target offset before the cell is left
 * black instead. At 10 Hz nothing inside the buffer ever exceeds 50 ms, so in
 * practice this only fires for cells older than the session itself.
 */
export const SAMPLE_TOLERANCE_MS = 500;

/** The window a grid spans: its oldest cell. */
export const GRID_SPAN_MS = GRID_OFFSETS_S[0] * 1000; // 6000

// ── Audio: gain + transcript, never the model's ears ──────────────────────
//
// One normalized pipeline on both platforms: whatever the source, the renderer
// ends up holding mono Float32 PCM at STT_SAMPLE_RATE and feeds it to the gain
// meter and to a continuously running Whisper worker (the exact
// voice/whisperWorker.ts voice calls ship, same model cache, no new download).
//
//   Windows  the desktop-loopback audio track, read via
//            MediaStreamTrackProcessor exactly like the video track.
//   macOS    the bundled ScreenCaptureKit tap (native/mac-audio-tap): main
//            spawns it, relays 48 kHz stereo f32le over `backseat:pcm`, and the
//            renderer downmixes/resamples. Falls back to a virtual output
//            device (BlackHole et al.), else video-only.
//
// The transcript is a RING of timed segments, not per-tick transcription:
// Whisper chews CHUNK-sized pieces continuously, so at tick time nearly the
// whole window is already text and the tick only waits for a bounded FLUSH of
// the in-progress tail. Transcribing 6 s on demand would put 1-2 s of Whisper
// latency in front of every tick; the flush wait is a few hundred ms.

/** The tap helper's fixed wire format (48 kHz stereo Float32 LE). */
export const TAP_SAMPLE_RATE = 48_000;
export const TAP_CHANNELS = 2;
/** What Whisper wants, and what the whole renderer pipeline normalizes to. */
export const STT_SAMPLE_RATE = 16_000;
/** Steady-state transcription chunk. Short enough that the flush tail is
 *  cheap, long enough that Whisper has context to segment words. */
export const STT_CHUNK_MS = 3_000;
/** A flush tail shorter than this is dropped rather than transcribed: Whisper
 *  on a fraction of a word only hallucinates. */
export const STT_MIN_FLUSH_MS = 400;
/** Hard bound on how long a tick waits for the flush before shipping with
 *  whatever transcript exists (the spec's "wait a few milliseconds longer"). */
export const STT_FLUSH_WAIT_MS = 1_200;
/** Segment retention. Longer than any tick window so a slow user tick still
 *  finds the words that were said when they started typing. */
export const TRANSCRIPT_KEEP_MS = 30_000;
/** The transcript window a tick carries: the grid span plus lead-in, so a
 *  line that STARTED just before the oldest frame is not cut mid-sentence. */
export const TICK_TRANSCRIPT_MS = GRID_SPAN_MS + 2_000;
/** Cap on the transcript text a tick ships. A dialogue-heavy video can emit a
 *  lot of words in 8 s; past this the OLDEST text is dropped, keeping the tail
 *  (closest to the moment the tick is about). */
export const TICK_TRANSCRIPT_MAX_CHARS = 600;

// ── What is being shared (260804) ─────────────────────────────────────────
//
// One short line naming the surface: the shared window's current title, or on a
// whole-screen share the title of whatever is frontmost. Read in main (see
// backseat/shareLabel.ts) because only main can see the window list.
//
// This replaces SCREEN TEXT, and the trade is worth writing down. Screen text
// was a full OCR pass over every frame — a bundled Swift Vision helper on
// macOS, tesseract.js everywhere else — and it worked: whole phrases at ~72 ms,
// 94 of 94 frames. What it did not do was answer the question that was actually
// hurting, which is "what am I even looking at". A HUD full of numbers does not
// tell you the difference between a game and a stream of that game, and the
// title does, in four words, for no per-frame cost at all. So the OCR path is
// gone (260804) rather than kept alongside: it was the most expensive local
// work in the pipeline, and the cheap string was the one carrying the meaning.

/** How often the label is re-read. Titles change on human timescales (a tab
 *  switch, a new video), and this crosses an IPC boundary into a window
 *  enumeration, so it is deliberately far slower than anything else here. */
export const SHARE_LABEL_INTERVAL_MS = 5_000;

// ── Cadence ───────────────────────────────────────────────────────────────

// ── The scheduled look ────────────────────────────────────────────────────
//
// The steady-state wake. No model decides this and nothing about the screen
// feeds into it: the companion simply glances up every so often, sees whatever
// is there, and stays quiet if nothing happened. Its opening line (tickNote's
// 'idle' branch) is what sets the bar for speaking, not the schedule.

/** Never sooner than this after the last look. */
export const IDLE_MIN_MS = 12_000;
/** Mean of the exponential tail ADDED to the floor. */
export const IDLE_MEAN_EXTRA_MS = 16_000;
/** Never later than this. ~5% of draws land exactly here. */
export const IDLE_MAX_MS = 60_000;

/**
 * How long to wait before the next scheduled look: a shifted exponential,
 * clamped to [IDLE_MIN_MS, IDLE_MAX_MS], mean ~28 s.
 *
 * The distribution matters more than the numbers. Past the floor an
 * exponential has a CONSTANT hazard rate, which is the formal way of saying
 * the wait is memoryless: however long it has already been quiet, the next
 * look is no more imminent than it was a moment ago, so the player cannot
 * learn the rhythm. A uniform draw over the same range has exactly the
 * opposite property — the longer the silence runs, the more overdue the next
 * line becomes — which is the metronome feel this is avoiding.
 *
 * `rand` is injected so tests and the offline sim can seed it.
 */
export function nextIdleDelayMs(rand: () => number = Math.random): number {
  // -ln(1-u) is the inverse CDF of Exp(1); scaling gives the mean we want.
  const extra = -Math.log(1 - rand()) * IDLE_MEAN_EXTRA_MS;
  return Math.min(IDLE_MIN_MS + extra, IDLE_MAX_MS);
}

/**
 * Floor between two companion lines, whatever raised them. Backseat is a
 * commentator, not a stream of consciousness: without this a jolt landing on
 * the heels of an idle tick produces two lines about the same moment.
 * A 'user' tick ignores it — being talked to always earns an answer.
 */
export const MIN_SPEAK_GAP_MS = 8_000;

/**
 * Refractory period for the GAIN arm of the local jolt trigger. The idle
 * schedule covers the steady state; a jolt exists to put a look ON the moment
 * that matters rather than up to a minute later, so it needs to be rare enough
 * that it never becomes the dominant source of ticks.
 *
 * 260803: this used to be both arms. The colour arm now has its own and much
 * shorter one, signals.COLOR_REFRACTORY_MS, which is where that reasoning is.
 * The short version: scene changes come in runs (six swipes through Reels,
 * every gap under 20 s) and each one is a different subject, while loudness
 * spikes come in runs inside ONE scene and are the same subject.
 */
export const JOLT_REFRACTORY_MS = 20_000;

/**
 * Jolt thresholds. Both arms are measured against a rolling baseline rather
 * than an absolute, so a loud game and a quiet game behave alike.
 *
 *   JOLT_GAIN_DB      jump over the trailing median loudness. 18 dB is a
 *                     roughly 8x amplitude step: an explosion in a quiet room,
 *                     not gunfire during a firefight.
 *   JOLT_COLOR_MAD    how many median absolute deviations above the trailing
 *                     MEDIAN colour delta counts as a change. See
 *                     signals.colorThreshold for why this is not a fixed
 *                     number any more: at a fixed 0.34 the arm was over
 *                     threshold on 38% of the Valorant clip's steps and every
 *                     event it raised was the refractory period expiring.
 *   JOLT_COLOR_FLOOR  absolute floor under that, so a menu screen sitting
 *                     still (median ~0, MAD ~0) cannot jolt on compression
 *                     noise.
 *
 * 260802: the colour arm also changed shape underneath these — it is now the
 * largest change over a 4x3 split of the thumbnail, against the better of a
 * 1.0 s and a 2.5 s lookback, rather than a mean over the whole frame against
 * one lookback. Both changes exist because the arm only ever fired on hard
 * scene cuts and never on a change within a scene.
 *
 * 260803: the floor moved 0.2 -> 0.15. It only binds when the moving part of
 * the bar is below it, which is to say on a calm screen, and 0.2 turned out to
 * be sized to "a big change" rather than to noise: metered over a still stretch
 * of a screen recording the block-max delta reads 0.001 to 0.002, so 0.15 still
 * sits about 75x above what compression actually produces. It was blocking two
 * real swipes on the Reels recording whose peaks were 0.187 and 0.179 while the
 * moving bar there sat at the floor. Honest caveat: at that point in that clip
 * the video's own motion also reaches 0.176, so this pair is not separable by
 * amplitude and the floor is buying sensitivity, not discrimination. It is
 * inert on anything busy, where median + k*MAD sits far above it: on the
 * Valorant montage the count of steps over the bar is identical at 0.2 and 0.15
 * (81 of 1863), so this change is scoped to calm screens by construction.
 */
export const JOLT_GAIN_DB = 18;
export const JOLT_COLOR_MAD = 4;
export const JOLT_COLOR_FLOOR = 0.15;

// ── Session shape ─────────────────────────────────────────────────────────

/** Voice mode speaks replies through the existing call; text mode shows them
 *  in the overlay's mini chat. Both persist to the same chat thread. */
export type BackseatMode = 'voice' | 'text';

export type BackseatPhase =
  /** The picker is up: choosing a window/screen to share. No capture yet. */
  | 'picking'
  /** Capturing and commentating. */
  | 'watching'
  /** Capture is live but every trigger is held (the pause button). */
  | 'paused'
  /** Torn down. */
  | 'ended';

/** A shareable source, as offered by the picker (from Electron desktopCapturer). */
export interface BackseatSource {
  id: string;
  name: string;
  /** 'screen' entries are whole displays; 'window' entries are single apps. */
  kind: 'screen' | 'window';
  /** Data-URL thumbnail for the picker tile. */
  thumbnail: string;
  /** Data-URL app icon, when the platform provides one (windows only). */
  appIcon?: string;
}

/** Descending priority. A tick preempts an in-flight turn of strictly lower
 *  priority and is dropped otherwise; see backseatService.handleTick. */
export type BackseatTickKind = 'user' | 'jolt' | 'idle';

/**
 * One unit of work sent renderer -> main. `grid` is a JPEG data URL of the
 * composited grid; `text` is the player's line on a 'user' tick.
 *
 * `capturedAt` is when the grid's LAST frame was taken, not when the tick was
 * sent. On a 'user' tick those differ by however long the player kept talking,
 * and the companion needs to know it is looking at the moment they reacted to
 * rather than the moment they stopped speaking.
 */
export interface BackseatTick {
  characterId: string;
  kind: BackseatTickKind;
  grid: string;
  /** The same grid at PREV_GRID_SCALE. Main holds onto it and sends it back
   *  with the NEXT tick as "what you were looking at last time". */
  gridSmall?: string;
  capturedAt: number;
  /** The player's message on a 'user' tick. Absent otherwise. */
  text?: string;
  /** Why a jolt fired, for the prompt ("the screen changed colour completely"). */
  joltReason?: 'gain' | 'color';
  /**
   * What the game audio said during (roughly) the grid's window, from the
   * local Whisper ring. Absent when there is no audio source or nothing was
   * said. This is DATA about the game, never the player speaking, and the
   * prompts frame it that way.
   */
  transcript?: string;
  /**
   * What the shared surface is called right now: the window title, or on a
   * whole-screen share the frontmost window's title. Absent when it could not
   * be read. This is the model's only cheap answer to "am I watching a game or
   * a film", so it rides every tick.
   */
  shareLabel?: string;
  /**
   * How old each frame in the grid is, in seconds before `capturedAt`, oldest
   * first — one entry per cell ACTUALLY drawn, after duplicates were dropped.
   *
   * It has to be sent now that the grid is variable-size. When every grid was
   * the same six cells at the same six offsets, the layout could be stated once
   * in the cached contract; a grid that may be one cell or six, at whichever
   * offsets survived deduplication, has to describe itself per tick.
   */
  frameAges: number[];
}

/** A line in the overlay's mini chat: the companion's, or the player's own. */
export interface BackseatLine {
  id: string;
  text: string;
  at: number;
  /** Set when this is the player's own typed line. Absent = the companion. */
  who?: 'player';
  /** Set when the line accompanied a saved clip. */
  clipPath?: string;
}

export interface BackseatState {
  characterId: string;
  phase: BackseatPhase;
  mode: BackseatMode;
  /** The shared source's display name, for the overlay tooltip. */
  sourceName: string;
  /** Companion display name, for the mini chat. */
  aiName: string;
  /** Rolling tail of the session's mini chat (companion + player lines). */
  lines: BackseatLine[];
  /** Session start, for the duration the analytics event reports. */
  startedAt: number;
}

/** Typed error codes thrown by backseatStart (surface as popups, not toasts). */
export const BACKSEAT_ERR_MC_ACTIVE = 'BACKSEAT_MC_SESSION_ACTIVE';
export const BACKSEAT_ERR_NO_SOURCE = 'BACKSEAT_NO_SOURCE';

/**
 * window.sei surface (implemented in src/preload/index.ts):
 *
 *   backseatSources(): Promise<BackseatSource[]>
 *     Enumerate shareable windows and screens for the picker panel.
 *   backseatStart(characterId, sourceId, sourceName, mode): Promise<BackseatState>
 *     Begin a session. Rejects with BACKSEAT_ERR_MC_ACTIVE when summoned.
 *   backseatGetState(characterId): Promise<BackseatState | null>
 *   backseatTick(tick: BackseatTick): Promise<void>
 *     Raise a tick. Main decides whether it becomes a spoken line.
 *   backseatAudioStart(): Promise<{sampleRate, channels} | null>
 *     macOS only: spawn the bundled system-audio tap and start relaying PCM to
 *     this window on backseat:pcm. Null when the tap cannot run (not macOS,
 *     helper missing, TCC refused, pre-13 macOS) — the renderer then tries a
 *     virtual device, else runs video-only.
 *   backseatAudioStop(): Promise<void>
 *   onBackseatPcm(cb: (chunk: ArrayBuffer) => void): () => void
 *     Raw interleaved Float32 LE at TAP_SAMPLE_RATE/TAP_CHANNELS, whole frames
 *     guaranteed.
 *   backseatSetPaused(characterId, paused): Promise<void>
 *   backseatSaveClip(characterId, webmBase64): Promise<void>
 *     Answer to a backseat:clip-request: the last 15 seconds, which main writes
 *     to disk and attaches to the chat line that asked for it.
 *   backseatEnd(characterId): Promise<void>
 *   onBackseatState(cb): () => void
 *   onBackseatLine(cb: (l: BackseatLine & {characterId}) => void): () => void
 *   onBackseatClipRequest(cb: (r: {characterId, requestId}) => void): () => void
 */
