/**
 * FacepackView's WebGL frame loop (261116, product call 261116). Same inputs
 * and the same face rules as the 2D loop in FacepackView (expression
 * timeline and decay, visemes from the clip tap, files decoded before a
 * state shows), plus her idle life:
 *
 *  - gaze (motion/organic.ts GazeDriver): the eyes wander between short
 *    fixations, glance at the cursor when the view has one and at points of
 *    interest, and the head follows on a spring with its own sway;
 *  - the head's turn, nod and tilt are a warp (facepackGl.ts); a big turn
 *    also moves to the pack's baked turned pose (l1/r1, rarely l2/r2), and
 *    the switch crossfades with the features aligned (morph), so it glides;
 *  - blinks follow the lid curve (fast close, short hold, slower open) by
 *    fading the half and closed patches in and out;
 *  - irises: a pack baked with gaze frames (anima, 261120) moves the iris
 *    itself: the model re-drew her open eyes looking at a small grid of
 *    directions; her look steps to the frame nearest her gaze (each step a
 *    quick crossfade, like a saccade) in the eye region of the composite
 *    (`composeIris`), and the half-shut frames of a blink keep that look.
 *    An older pack keeps the pre-261120 warp: the picture shifts inside the
 *    eye openings found by faceRig.findEyes, only where the art has an iris
 *    to move.
 *
 * `life: false` (reduced motion, a still preview) keeps only blinks and the
 * mouth. Nothing is allocated per frame on the steady path; the composite is
 * rebuilt only on a state change, the mouth box only on a viseme change and
 * the eye region (gaze frames) only when her look steps.
 */
import type { FacepackIris, FacepackManifest, FacepackViseme } from '@shared/facepack';
import type { AvatarCamera } from '@shared/ipc';
import { BLINK_ON_SACCADE_CHANCE, Blinker, GazeDriver, minJerk, type GazeInput, type GazePoint } from '../motion/organic';
import { ExpressionTimeline, VisemeDriver, type LevelSample } from './animation';
import {
  cueExpression,
  expressionBlinks,
  filesFor,
  irisCell,
  irisFiles,
  irisFrameAt,
  irisHalfAt,
  irisOf,
  layersFor,
  posesOf,
  resolveExpressionName,
  resolvePoseName,
  type FaceLayer,
  type IrisTap,
} from './compose';
import type { FaceImageCache } from './facepackSource';
import { FaceGl, lidWeights, newDrawParams, type EyeSet } from './facepackGl';
import { findEyes, irisVisible, type FaceRig } from './faceRig';
import { FramePacer } from '../framePacer';
import type { FaceDebugState } from './FacepackView';

export interface GlLive {
  speaking: boolean;
  camera: AvatarCamera | null;
  expression: string | null;
  expressionSeq: number;
  pinnedPose: string | null;
  overlays: boolean;
  decay: boolean;
  fps: number | undefined;
  life: boolean;
  interests: readonly GazePoint[] | null;
}

export interface GlFaceEnv {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  m: FacepackManifest;
  cache: FaceImageCache;
  rig: FaceRig;
  gl: FaceGl;
  subs: Partial<Record<FacepackViseme, FacepackViseme>>;
  startExpr: string;
  startPose: string;
  live: () => GlLive;
  cursor: { x: number; y: number; at: number };
  clip: { sample: LevelSample | null; at: number };
  levelRef?: React.MutableRefObject<number>;
  bandsRef?: React.MutableRefObject<LevelSample | null>;
  debugRef?: React.MutableRefObject<FaceDebugState | null>;
  dpr: number;
  /** A clip sample older than this is "no feed". */
  sampleFreshMs: number;
  cursorFreshMs: number;
  levelGate: number;
}

const EXPRESSION_FADE_MS = 160;
const POSE_FADE_MS = 600;
/** Head turn (normalised) each baked pose stands for. */
const POSE_YAW: Record<string, number> = {
  c: 0,
  l1: -0.5,
  r1: 0.5,
  l2: -0.9,
  r2: 0.9,
};
/** A baked pose is held at least this long. */
const POSE_HOLD_MS = 2_500;
/** Warp amplitudes, in eye-to-mouth units (rig.unit) and radians. */
const FACE_SLIDE_X = 0.16;
const FACE_SLIDE_Y = 0.1;
const HEAD_SHIFT_X = 0.05;
const HEAD_SHIFT_Y = 0.04;
const ROLL_RAD = 0.04;
/** Iris shift as a fraction of the opening's radii (packs without gaze frames: the warp). */
const IRIS_X = 0.3;
const IRIS_Y = 0.2;
/**
 * Gaze frames (261120): her eyes-in-head direction (GazeDriver eyeX/eyeY,
 * mostly within +-0.5) to the grid's units (the model's iris rotation, -1..1
 * across, -0.5..0.5 up and down in the 261120 bake); clamped to the grid
 * and to compose.IRIS_MAX (+-0.5), so a glance past about 0.15 across (0.2
 * up or down) already shows the +-0.5 frame and the outer columns never show.
 */
const GAZE_X = 2.0;
const GAZE_Y = 1.5;
/** compose.irisCell's hold: how far past the midpoint (a share of the step) her look must go to step. */
const GAZE_HOLD = 0.15;
/** Each step of her look crossfades over this long (a saccade: quick, so two irises never linger). */
const GAZE_STEP_MS = 70;
/** Room above her head inside the view, so a tilt never clips her hair at the top edge. */
const HEADROOM = 0.97;

interface State {
  expression: string;
  pose: string;
}

/**
 * A pack whose eyes have no iris to move (the flat chibi Sui) shows her gaze
 * through the head alone, so the head goes a little further.
 */
const NO_IRIS_HEAD_GAIN = 1.5;

/** Start the loop; returns resume (after fps 0) and stop. */
export function runGlFace(env: GlFaceEnv): { resume(): void; stop(): void } {
  const { canvas, host, m, cache: c, rig, gl, live } = env;
  const [W, H] = m.canvas;
  let stopped = false;
  let raf = 0;

  // ── sizing ──────────────────────────────────────────────────────────────
  let viewW = 1;
  let viewH = 1;
  const fit = (): void => {
    viewW = Math.max(1, host.clientWidth);
    viewH = Math.max(1, host.clientHeight);
    canvas.width = Math.round(viewW * env.dpr);
    canvas.height = Math.round(viewH * env.dpr);
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(host);

  // ── composites ──────────────────────────────────────────────────────────
  const comp = document.createElement('canvas');
  comp.width = W;
  comp.height = H;
  const cg = comp.getContext('2d');
  const mouthCv = document.createElement('canvas');
  const mg = mouthCv.getContext('2d');
  const probe = document.createElement('canvas');
  const pg = probe.getContext('2d', { willReadFrequently: true });
  if (!cg || !mg || !pg) throw new Error('2d context unavailable');

  /** A pack baked with gaze frames moves the iris itself; the warp is only for packs without them. */
  const packIris = Object.values(m.expressions).some((e) => Object.values(e.poses).some((po) => po.iris));
  const eyeSets = new Map<string, EyeSet>();
  /** Midpoint of the two eye openings per state (pack px), for the pose-change morph; kept even where there is no iris. */
  const centres = new Map<string, [number, number] | null>();
  const centreOf = (st: State): [number, number] | null => {
    eyeSetFor(st);
    return centres.get(`${st.expression}/${st.pose}`) ?? null;
  };
  const eyeSetFor = (st: State): EyeSet => {
    const key = `${st.expression}/${st.pose}`;
    const hit = eyeSets.get(key);
    if (hit) return hit;
    const e = m.expressions[st.expression];
    const pose = e?.poses[resolvePoseName(e, m, st.pose)];
    const box = pose?.eyes?.box ?? null;
    const set: EyeSet = {
      eyes: null,
      box: box ? [box[0], box[1], box[2], box[3]] : null,
    };
    const base = pose ? c.get(pose.base) : undefined;
    const closed = pose?.eyes?.closed ? c.get(pose.eyes.closed) : undefined;
    if (box && base && closed && e?.blink !== false) {
      const w = closed.width;
      const h = closed.height;
      probe.width = w;
      probe.height = h;
      pg.clearRect(0, 0, w, h);
      pg.drawImage(base, -box[0], -box[1]);
      const open = pg.getImageData(0, 0, w, h).data;
      pg.clearRect(0, 0, w, h);
      pg.drawImage(closed, 0, 0);
      const shut = pg.getImageData(0, 0, w, h).data;
      const found = findEyes(open, shut, w, h);
      if (found) centres.set(key, [box[0] + (found[0].cx + found[1].cx) / 2, box[1] + (found[0].cy + found[1].cy) / 2]);
      if (!packIris && found && found.every((el) => irisVisible(open, w, el))) {
        // Slightly inside the opening, so the lash line keeps still.
        set.eyes = [
          {
            cx: found[0].cx + box[0],
            cy: found[0].cy + box[1],
            rx: found[0].rx * 0.88,
            ry: found[0].ry * 0.85,
          },
          {
            cx: found[1].cx + box[0],
            cy: found[1].cy + box[1],
            rx: found[1].rx * 0.88,
            ry: found[1].ry * 0.85,
          },
        ];
      }
    }
    eyeSets.set(key, set);
    return set;
  };

  // ── gaze frames ─────────────────────────────────────────────────────────
  const irisCv = document.createElement('canvas');
  const ig = irisCv.getContext('2d');
  if (!ig) throw new Error('2d context unavailable');
  /** Gaze frames per state, null when the state has none (cached: asked every frame). */
  const irisCache = new Map<string, FacepackIris | null>();
  const irisFor = (st: State): FacepackIris | null => {
    const key = `${st.expression}/${st.pose}`;
    let hit = irisCache.get(key);
    if (hit === undefined) {
      hit = irisOf(m, st.expression, st.pose);
      irisCache.set(key, hit);
    }
    return hit;
  };
  /** Everything one state draws: its layers' files and its gaze frames. */
  const stateFiles = (expr: string, pose: string): string[] => [...filesFor(m, expr, pose), ...irisFiles(m, expr, pose)];
  /**
   * Her look on the grid: the frame shown (`cell`, grid indices; -1 before
   * the first), the one it is stepping from and how far the step's
   * crossfade has gone (0..1, eased).
   */
  const cell: [number, number] = [-1, -1];
  const cellFrom: [number, number] = [-1, -1];
  let stepAt = -Infinity;
  let stepMix = 1;
  const taps: IrisTap[] = [];
  /** The frames of her look now: the step's two frames, or the one shown when the step is done. */
  const gazeTaps = (ir: FacepackIris): IrisTap[] => {
    const to = cell[0] < 0 ? [ir.x.indexOf(0), ir.y.indexOf(0)] : cell;
    taps.length = 0;
    if (stepMix < 1 && cellFrom[0] >= 0) taps.push({ src: irisFrameAt(ir, cellFrom[0], cellFrom[1]), w: 1 - stepMix });
    taps.push({ src: irisFrameAt(ir, to[0], to[1]), w: stepMix < 1 && cellFrom[0] >= 0 ? stepMix : 1 });
    return taps;
  };
  /**
   * Draw `layers` at an offset of (-ox, -oy), with the gaze frames of `ir`
   * over the base: the frame of her look, or mid-step the two frames as a
   * lerp (the second over the first at its weight). The frames are opaque
   * inside and feathered to the base at their edges.
   */
  const drawLayers = (g: CanvasRenderingContext2D, layers: readonly FaceLayer[], ox: number, oy: number, ir: FacepackIris | null): void => {
    for (const l of layers) {
      const bmp = c.get(l.src);
      if (bmp) g.drawImage(bmp, l.x - ox, l.y - oy);
      if (l.kind !== 'base' || !ir || !bmp) continue;
      gazeTaps(ir);
      const [bx, by, bx1, by1] = ir.box;
      let acc = 0;
      for (const t of taps) {
        const a = t.w / (acc + t.w);
        acc += t.w;
        g.globalAlpha = a;
        if (t.src === null) {
          if (a < 1) g.drawImage(bmp, bx, by, bx1 - bx, by1 - by, bx - ox, by - oy, bx1 - bx, by1 - by);
        } else {
          const f = c.get(t.src);
          if (f) g.drawImage(f, bx - ox, by - oy);
        }
      }
      g.globalAlpha = 1;
    }
  };
  /** The state's gaze frames when all are decoded (until then her eyes show the base's look). */
  const irisReady = (st: State): FacepackIris | null => {
    const ir = irisFor(st);
    if (!ir) return null;
    for (const row of ir.frames) for (const f of row) if (f && !c.has(f)) return null;
    return ir;
  };

  const composeFull = (st: State, viseme: FacepackViseme): boolean => {
    const layers = layersFor(m, {
      ...st,
      eye: 'open',
      viseme,
      overlays: live().overlays,
    });
    if (!layers.length) return false;
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, W, H);
    drawLayers(cg, layers, 0, 0, irisReady(st));
    return true;
  };

  /** The eye region of `st` at the current gaze point, composed alone (base crop, gaze frames, mouth, overlays). */
  const composeIris = (st: State, viseme: FacepackViseme, ir: FacepackIris): [number, number] => {
    const box = ir.box;
    const w = Math.max(1, Math.round(box[2] - box[0]));
    const h = Math.max(1, Math.round(box[3] - box[1]));
    if (irisCv.width !== w || irisCv.height !== h) {
      irisCv.width = w;
      irisCv.height = h;
    }
    ig.clearRect(0, 0, w, h);
    drawLayers(ig, layersFor(m, { ...st, eye: 'open', viseme, overlays: live().overlays }), box[0], box[1], ir);
    return [box[0], box[1]];
  };

  /** The mouth box of `st` with `viseme`, composed alone (base crop, patch, overlays). */
  const composeMouth = (st: State, viseme: FacepackViseme): [number, number] | null => {
    const e = m.expressions[st.expression];
    const pose = e?.poses[resolvePoseName(e, m, st.pose)];
    const box = pose?.mouth?.box;
    if (!box) return null;
    const w = Math.max(1, Math.round(box[2] - box[0]));
    const h = Math.max(1, Math.round(box[3] - box[1]));
    if (mouthCv.width !== w || mouthCv.height !== h) {
      mouthCv.width = w;
      mouthCv.height = h;
    }
    mg.clearRect(0, 0, w, h);
    const layers = layersFor(m, {
      ...st,
      eye: 'open',
      viseme,
      overlays: live().overlays,
    });
    drawLayers(mg, layers, box[0], box[1], irisReady(st));
    return [box[0], box[1]];
  };

  const halfCv = document.createElement('canvas');
  const hg = halfCv.getContext('2d');
  if (!hg) throw new Error('2d context unavailable');
  /** The half-lid look (a gaze file) the GL half patch shows now, '' for the plain half patch. */
  let halfShown = '';
  /**
   * The lid patches of `st`. `look` (a gaze-frame pack's half-lid crop,
   * compose.irisHalfAt) is drawn over the half patch, so the half-shut frames
   * of a blink keep her look instead of flicking the iris back to centre.
   */
  const lidsFor = (st: State, look: string | null = null): void => {
    const e = m.expressions[st.expression];
    const pose = e?.poses[resolvePoseName(e, m, st.pose)];
    const half = pose?.eyes?.half;
    const closed = pose?.eyes?.closed;
    const hb = half ? c.get(half) : undefined;
    const cb = closed ? c.get(closed) : undefined;
    const lb = look ? c.get(look) : undefined;
    const ir = irisFor(st);
    let hl: { key: string; src: TexImageSource } | null = hb && half ? { key: half, src: hb } : null;
    halfShown = '';
    if (hl && hb && lb && look && ir && pose?.eyes) {
      if (halfCv.width !== hb.width || halfCv.height !== hb.height) {
        halfCv.width = hb.width;
        halfCv.height = hb.height;
      }
      hg.clearRect(0, 0, hb.width, hb.height);
      hg.drawImage(hb, 0, 0);
      hg.drawImage(lb, ir.box[0] - pose.eyes.box[0], ir.box[1] - pose.eyes.box[1]);
      // The GL patch cache keeps the upload by key, so each look is drawn here once per state.
      hl = { key: `${half}|${look}`, src: halfCv };
      halfShown = look;
    }
    gl.setLids(hl, cb && closed ? { key: closed, src: cb } : null);
  };

  // ── state ───────────────────────────────────────────────────────────────
  const t0 = performance.now();
  const blink = new Blinker(t0);
  const gaze = new GazeDriver(t0);
  const visemes = new VisemeDriver(env.subs);
  const timeline = new ExpressionTimeline(t0);
  if (env.startExpr !== timeline.current) timeline.set(env.startExpr, t0);
  let seenExpr = live().expression;
  let seenSeq = live().expressionSeq;
  let shown: State = { expression: env.startExpr, pose: env.startPose };
  let prev: State | null = null;
  let fadeStart = 0;
  let fadeMs = EXPRESSION_FADE_MS;
  let morphD: [number, number] = [0, 0];
  let lastViseme: FacepackViseme = 'rest';
  let idlePose = env.startPose;
  let poseSince = t0;
  let loading: string | null = null;
  let lastBig = -Infinity;
  const keep = new Set<string>();
  /** States whose files finished loading (some may have failed). */
  const settled = new Set<string>();
  const p = newDrawParams();
  const gazeIn: GazeInput = { cursor: null, interests: null, engaged: false };
  const cursorPt: GazePoint = { x: 0, y: 0 };
  const target: State = { expression: shown.expression, pose: shown.pose };

  const show = (st: State, viseme: FacepackViseme, crossfade: boolean): void => {
    composeFull(st, viseme);
    gl.setComposite(comp, eyeSetFor(st), crossfade);
    lidsFor(st);
    lastViseme = viseme;
  };
  show(shown, 'rest', false);
  /** The look (cell x, cell y, from x, from y, step mix) the eye region was last composed at, and for which state. */
  const irisDrawn: number[] = [NaN, NaN, NaN, NaN, NaN];
  let irisDrawnFor: FacepackIris | null = null;
  const markDrawn = (ir: FacepackIris | null): void => {
    irisDrawnFor = ir;
    irisDrawn[0] = cell[0];
    irisDrawn[1] = cell[1];
    irisDrawn[2] = cellFrom[0];
    irisDrawn[3] = cellFrom[1];
    irisDrawn[4] = stepMix;
  };
  const irises = packIris || eyeSetFor(shown).eyes !== null;
  const headGain = irises ? 1 : NO_IRIS_HEAD_GAIN;
  /**
   * 261119 (product call 261119, "the idle animation jumps", "eyes jump"): a baked
   * turned pose is a different picture (every hair strand moves, the irises sit
   * elsewhere), so moving to it is a whole-figure crossfade, and her ordinary
   * glances and cursor looks crossed into it every few seconds. A face set with
   * irises now turns her head with the warp alone (continuous) and keeps the
   * baked centre pose; only a face with no iris to move (the flat chibi eyes)
   * still uses the turned poses, and only for a big turn.
   */
  const turnPoses = !irises;

  /** The baked pose her head direction calls for (hysteresis, held a while). */
  const posePick = (headX: number, now: number, avail: readonly string[]): string => {
    if (now - poseSince < POSE_HOLD_MS) return idlePose;
    const a = Math.abs(headX);
    const side = headX < 0 ? 'l' : 'r';
    const cur = idlePose;
    let next = cur;
    if (cur === 'c') {
      if (a > 0.55) next = `${side}1`;
    } else if (cur.endsWith('1')) {
      if (a < 0.3 || cur[0] !== side) next = 'c';
      else if (a > 0.9) next = `${side}2`;
    } else if (cur.endsWith('2')) {
      if (a < 0.7 || cur[0] !== side) next = `${cur[0]}1`;
    } else next = 'c';
    if (next !== cur && avail.includes(next)) {
      idlePose = next;
      poseSince = now;
    } else if (next !== cur && next === 'c') {
      idlePose = 'c';
      poseSince = now;
    }
    return idlePose;
  };

  /** Poses per expression, cached (the frame loop asks every frame). */
  const posesCache = new Map<string, readonly string[]>();
  const posesFor = (expr: string): readonly string[] => {
    let hit = posesCache.get(expr);
    if (!hit) {
      hit = posesOf(m, expr);
      posesCache.set(expr, hit);
    }
    return hit;
  };
  /** Keep what is on screen (and fading out); run on state changes only, not per frame. */
  const trim = (): void => {
    keep.clear();
    for (const f of stateFiles(shown.expression, shown.pose)) keep.add(f);
    if (prev) for (const f of stateFiles(prev.expression, prev.pose)) keep.add(f);
    if (loading) for (const f of stateFiles(target.expression, target.pose)) keep.add(f);
    c.trim(keep);
  };

  const pacer = new FramePacer();
  let lastDrawKey = '';
  const frame = (): void => {
    if (stopped) return;
    const L = live();
    if (L.fps === 0) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (L.fps !== undefined && L.fps > 0 && !pacer.due(now, L.fps)) return;
    if (gl.isLost) return;

    if (L.expression !== seenExpr || L.expressionSeq !== seenSeq) {
      seenExpr = L.expression;
      seenSeq = L.expressionSeq;
      const next = L.expression ? cueExpression(m, L.expression) : null;
      if (next) timeline.set(next, now);
    }
    const clipFresh = env.clip.sample !== null && now - env.clip.at < env.sampleFreshMs;
    const explicit = env.bandsRef?.current ?? null;
    const isSpeaking = L.speaking || clipFresh || explicit !== null;
    timeline.setSpeaking(isSpeaking, now);
    if (L.decay) timeline.tick(now);

    // Gaze and head.
    const cursorFresh = Date.now() - env.cursor.at < env.cursorFreshMs;
    if (cursorFresh) {
      cursorPt.x = Math.max(-0.85, Math.min(0.85, env.cursor.x * 0.8));
      // The feed's y is up-positive; gaze y is down-positive.
      cursorPt.y = Math.max(-0.5, Math.min(0.5, -env.cursor.y * 0.6));
    }
    gazeIn.cursor = cursorFresh ? cursorPt : null;
    gazeIn.interests = L.interests;
    gazeIn.engaged = isSpeaking;
    const g = L.life ? gaze.update(now, gazeIn) : null;
    if (g && g.bigSaccadeAt !== lastBig) {
      lastBig = g.bigSaccadeAt;
      if (Math.random() < BLINK_ON_SACCADE_CHANCE) blink.nudge(now);
    }

    // Target state: the timeline's expression, the pose her head calls for (or the pinned one).
    const exprName = resolveExpressionName(m, timeline.current);
    const avail = posesFor(exprName);
    target.expression = exprName;
    if (L.pinnedPose) target.pose = avail.includes(L.pinnedPose) ? L.pinnedPose : avail[0];
    else {
      const want = g && turnPoses ? posePick(g.headX * headGain, now, avail) : idlePose;
      target.pose = avail.includes(want) ? want : avail.includes('c') ? 'c' : avail[0];
    }
    if (target.expression !== shown.expression || target.pose !== shown.pose) {
      const files = stateFiles(target.expression, target.pose);
      const tkey = `${target.expression}/${target.pose}`;
      // The gaze frames are wanted before the switch, so her eyes do not jump back to the base's look,
      // but a frame that failed to load must not hold the face: once its load settled, switch anyway.
      if (filesFor(m, target.expression, target.pose).every((f) => c.has(f)) && (settled.has(tkey) || files.every((f) => c.has(f)))) {
        const exprChange = target.expression !== shown.expression;
        prev = shown;
        shown = { expression: target.expression, pose: target.pose };
        fadeStart = now;
        fadeMs = exprChange ? EXPRESSION_FADE_MS : POSE_FADE_MS;
        loading = null;
        const a = centreOf(prev);
        const b = centreOf(shown);
        morphD = a && b && !exprChange ? [b[0] - a[0], b[1] - a[1]] : [0, 0];
        show(shown, lastViseme, true);
        markDrawn(irisReady(shown));
        trim();
      } else {
        if (loading !== tkey) {
          loading = tkey;
          void c.load(files).then(() => settled.add(tkey));
        }
      }
    }

    // Mouth.
    let sample: LevelSample | null = explicit ?? (clipFresh ? env.clip.sample : null);
    let mouthOn = isSpeaking;
    if (!sample && env.levelRef && L.speaking) {
      mouthOn = env.levelRef.current > env.levelGate;
      sample = null;
    }
    const viseme = visemes.update(now, mouthOn, sample);
    if (viseme !== lastViseme) {
      const at = composeMouth(shown, viseme);
      if (at) gl.updateRegion(mouthCv, at[0], at[1]);
      lastViseme = viseme;
    }

    // Lids.
    const canBlink = expressionBlinks(m, shown.expression) && (!prev || expressionBlinks(m, prev.expression));
    const lid = blink.lid(now, canBlink);
    lidWeights(lid, p);

    // Crossfade.
    const u = prev ? Math.min(1, (now - fadeStart) / fadeMs) : 1;
    const k = minJerk(u);
    if (prev && u >= 1) {
      prev = null;
      trim();
    }
    p.mix = prev ? k : 1;
    p.morphCur[0] = morphD[0] * (1 - k);
    p.morphCur[1] = morphD[1] * (1 - k);
    p.morphOld[0] = -morphD[0] * k;
    p.morphOld[1] = -morphD[1] * k;

    // Head warp: what the baked pose does not already show.
    const poseYaw = prev ? (POSE_YAW[prev.pose] ?? 0) * (1 - k) + (POSE_YAW[shown.pose] ?? 0) * k : (POSE_YAW[shown.pose] ?? 0);
    const yaw = g ? g.headX * headGain - poseYaw : 0;
    const pitch = g ? g.headY * headGain : 0;
    p.faceShift[0] = yaw * rig.unit * FACE_SLIDE_X;
    p.faceShift[1] = pitch * rig.unit * FACE_SLIDE_Y;
    p.headShift[0] = yaw * rig.unit * HEAD_SHIFT_X;
    p.headShift[1] = pitch * rig.unit * HEAD_SHIFT_Y;
    p.roll = g ? g.headRoll * ROLL_RAD : 0;
    p.iris[0] = g ? g.eyeX * IRIS_X : 0;
    p.iris[1] = g ? g.eyeY * IRIS_Y : 0;

    // Gaze frames: her look steps to the grid frame nearest her gaze point, each step a quick
    // crossfade; the eye region is recomposed only while it changes.
    const ir = irisReady(shown);
    if (ir) {
      const [nx, ny] = irisCell(ir, g ? g.eyeX * GAZE_X : 0, g ? g.eyeY * GAZE_Y : 0, cell[0] < 0 ? null : cell, GAZE_HOLD);
      if (cell[0] < 0) {
        cell[0] = cellFrom[0] = nx;
        cell[1] = cellFrom[1] = ny;
      } else if (nx !== cell[0] || ny !== cell[1]) {
        // Mid-step, the step starts again from whichever frame showed more.
        if (stepMix >= 0.5) {
          cellFrom[0] = cell[0];
          cellFrom[1] = cell[1];
        }
        cell[0] = nx;
        cell[1] = ny;
        stepAt = now;
      }
      const u = Math.min(1, Math.max(0, (now - stepAt) / GAZE_STEP_MS));
      stepMix = u * u * (3 - 2 * u);
      if (
        ir !== irisDrawnFor ||
        cell[0] !== irisDrawn[0] ||
        cell[1] !== irisDrawn[1] ||
        cellFrom[0] !== irisDrawn[2] ||
        cellFrom[1] !== irisDrawn[3] ||
        stepMix !== irisDrawn[4]
      ) {
        const at = composeIris(shown, lastViseme, ir);
        gl.updateRegion(irisCv, at[0], at[1]);
        markDrawn(ir);
      }
    }
    // Half lid at her look across (packs that bake it); picked as the half frame comes, held through the blink.
    if (p.halfA > 0 && p.closedA === 0) {
      const look = ir && cell[0] >= 0 ? irisHalfAt(ir, cell[0]) : null;
      if ((look ?? '') !== halfShown) lidsFor(shown, look);
    }

    // Fit: contain, a little headroom, feet (the bottom) on the bottom edge.
    const cam = L.camera;
    const s = Math.min(viewW / W, viewH / H) * (cam?.zoom ?? 1) * HEADROOM;
    const ox = (viewW - W * s) / 2 + (cam?.x ?? 0) * viewW;
    const oy = cam ? (viewH - H * s) / 2 + cam.y * viewH : viewH - H * s;
    const dpr = env.dpr;
    p.dest[0] = ox * dpr;
    p.dest[1] = oy * dpr;
    p.dest[2] = W * s * dpr;
    p.dest[3] = H * s * dpr;

    // Without idle life a frame can repeat exactly: skip it.
    if (!g) {
      const key = `${shown.expression}/${shown.pose}/${lastViseme}/${lid.toFixed(3)}/${p.mix.toFixed(3)}/${canvas.width}x${canvas.height}/${p.dest[0].toFixed(1)},${p.dest[1].toFixed(1)},${p.dest[2].toFixed(1)}`;
      if (key === lastDrawKey) return;
      lastDrawKey = key;
    }
    gl.draw(p, canvas.width, canvas.height);
    // Dev probe (scripts/seilink-avatar-demo.mjs): a script that sets window.__seiFaceTrace = [] gets one row a frame.
    const trace = (globalThis as { __seiFaceTrace?: unknown[] }).__seiFaceTrace;
    if (trace)
      trace.push({ t: now, gx: g?.gazeX ?? 0, gy: g?.gazeY ?? 0, ex: g?.eyeX ?? 0, ey: g?.eyeY ?? 0, hx: g?.headX ?? 0, hy: g?.headY ?? 0, roll: p.roll, pose: shown.pose, mix: p.mix, lid, ix: p.iris[0], iy: p.iris[1], irisFrames: ir !== null, cx: cell[0], cy: cell[1], step: stepMix });

    if (env.debugRef) {
      env.debugRef.current = {
        expression: shown.expression,
        pose: shown.pose,
        eye: lid > 0.75 ? 'closed' : lid > 0.25 ? 'half' : 'open',
        viseme,
        fading: prev !== null,
        speaking: isSpeaking,
        level: sample?.level ?? env.levelRef?.current ?? 0,
      };
    }
  };
  raf = requestAnimationFrame(frame);

  // Warm the turned poses of the starting expression (big turns of a face with no iris use them).
  if (turnPoses) void c.load(posesOf(m, env.startExpr).flatMap((pp) => filesFor(m, env.startExpr, pp)));
  // The starting state's gaze frames (FacepackView decoded only its layers); her eyes follow once they are in.
  const startIris = irisFiles(m, shown.expression, shown.pose);
  if (startIris.length) void c.load(startIris).then(() => trim());

  return {
    resume(): void {
      if (!stopped && raf === 0) raf = requestAnimationFrame(frame);
    },
    stop(): void {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}
