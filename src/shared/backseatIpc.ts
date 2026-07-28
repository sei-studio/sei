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
 *             the rolling clip, and raises the two local triggers. It decides
 *             nothing about what the companion says.
 *   main      owns the SESSION AND EVERY MODEL CALL: the salience gate (a small
 *             VLM on DeepInfra), the companion turn (Haiku), clip files,
 *             analytics, and the continuity rows. It never sees a raw frame,
 *             only finished grids.
 *
 * The unit of work is a TICK: one image grid plus the reason it fired. Ticks
 * are raised three ways, in descending priority (see BackseatTickKind):
 *
 *   1. 'user'     the player said or typed something. Always answered.
 *   2. 'gate'     the every-6s salience gate said the grid is interesting.
 *   3. 'jolt'     a very large local audio/colour discontinuity, no model in
 *                 the loop. Deliberately rare — see JOLT_* below.
 *
 * Both text mode and voice mode use the SAME chat thread and the same
 * per-character memory as every other surface; backseat is a lens on the
 * existing conversation, not a second one.
 */

// ── Ring buffer ───────────────────────────────────────────────────────────

/** Rolling window the renderer retains, and the length of a saved clip. */
export const BUFFER_MS = 15_000;
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

/** The window a grid spans: GRID_FRAMES buckets of one second each. */
export const GRID_SPAN_MS = GRID_FRAMES * 1000; // 6000

// ── Cadence ───────────────────────────────────────────────────────────────

/** How often the salience gate looks at a fresh grid. */
export const GATE_INTERVAL_MS = 6_000;

/**
 * Floor between two companion lines, whatever raised them. Backseat is a
 * commentator, not a stream of consciousness: without this a jolt landing on
 * the heels of a gate tick produces two lines about the same moment.
 * A 'user' tick ignores it — being talked to always earns an answer.
 */
export const MIN_SPEAK_GAP_MS = 8_000;

/**
 * Refractory period for the local jolt trigger. The gate already covers the
 * steady state; a jolt exists to catch the thing that happened 300 ms after
 * the last gate call, so it needs to be rare enough that it never becomes the
 * dominant source of ticks.
 */
export const JOLT_REFRACTORY_MS = 20_000;

/**
 * Jolt thresholds, deliberately set very high (the spec's "really high, not
 * sure how it'll work"). Both are measured against a rolling baseline over the
 * buffer, not against absolutes, so a loud game and a quiet game behave alike.
 *
 *   JOLT_GAIN_DB       jump over the trailing median loudness. 18 dB is a
 *                      roughly 8x amplitude step: an explosion in a quiet room,
 *                      not gunfire during a firefight.
 *   JOLT_COLOR_DELTA   mean per-channel distance between the current 32x18 luma
 *                      /chroma thumbnail and the one a second ago, 0..1. 0.34
 *                      is an almost total repaint of the screen: indoors to
 *                      outdoors on a CS map, a full-screen ability, a map
 *                      opening. Ordinary camera movement sits far below it.
 */
export const JOLT_GAIN_DB = 18;
export const JOLT_COLOR_DELTA = 0.34;

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

export type BackseatTickKind = 'user' | 'gate' | 'jolt';

/**
 * One unit of work sent renderer -> main. `grid` is a JPEG data URL of the
 * composited 3x2 image; `text` is the player's line on a 'user' tick.
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
  capturedAt: number;
  /** The player's message on a 'user' tick. Absent otherwise. */
  text?: string;
  /** Why a jolt fired, for the prompt ("the screen changed colour completely"). */
  joltReason?: 'gain' | 'color';
}

/** A line the companion said, pushed to the overlay's mini chat. */
export interface BackseatLine {
  id: string;
  text: string;
  at: number;
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
  /** Rolling tail of what the companion has said this session (mini chat). */
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
 *   backseatGate(characterId, grid): Promise<boolean>
 *     Ask the small VLM whether this grid is interesting. Resolves false on any
 *     error, so a gate outage degrades to "quiet", never to "chatty".
 *   backseatSetPaused(characterId, paused): Promise<void>
 *   backseatSaveClip(characterId, webmBase64): Promise<void>
 *     Answer to a backseat:clip-request: the last 15 seconds, which main writes
 *     to disk and attaches to the chat line that asked for it.
 *   backseatEnd(characterId): Promise<void>
 *   onBackseatState(cb): () => void
 *   onBackseatLine(cb: (l: BackseatLine & {characterId}) => void): () => void
 *   onBackseatClipRequest(cb: (r: {characterId, requestId}) => void): () => void
 */
