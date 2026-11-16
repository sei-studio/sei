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
 *  - irises move inside the eye openings found by faceRig.findEyes, only
 *    where the art has an iris to move.
 *
 * `life: false` (reduced motion, a still preview) keeps only blinks and the
 * mouth. Nothing is allocated per frame on the steady path; the composite is
 * rebuilt only on a state change and the mouth box only on a viseme change.
 */
import type { FacepackManifest, FacepackViseme } from '@shared/facepack';
import type { AvatarCamera } from '@shared/ipc';
import { BLINK_ON_SACCADE_CHANCE, Blinker, GazeDriver, minJerk, type GazeInput, type GazePoint } from '../motion/organic';
import { ExpressionTimeline, VisemeDriver, type LevelSample } from './animation';
import { cueExpression, expressionBlinks, filesFor, layersFor, posesOf, resolveExpressionName, resolvePoseName } from './compose';
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
const POSE_FADE_MS = 460;
/** Head turn (normalised) each baked pose stands for. */
const POSE_YAW: Record<string, number> = {
  c: 0,
  l1: -0.5,
  r1: 0.5,
  l2: -0.9,
  r2: 0.9,
};
/** A baked pose is held at least this long. */
const POSE_HOLD_MS = 1_400;
/** Warp amplitudes, in eye-to-mouth units (rig.unit) and radians. */
const FACE_SLIDE_X = 0.16;
const FACE_SLIDE_Y = 0.1;
const HEAD_SHIFT_X = 0.05;
const HEAD_SHIFT_Y = 0.04;
const ROLL_RAD = 0.04;
/** Iris shift as a fraction of the opening's radii. */
const IRIS_X = 0.3;
const IRIS_Y = 0.2;
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
      if (found && found.every((el) => irisVisible(open, w, el))) {
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
    for (const l of layers) {
      const bmp = c.get(l.src);
      if (bmp) cg.drawImage(bmp, l.x, l.y);
    }
    return true;
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
    for (const l of layers) {
      const bmp = c.get(l.src);
      if (bmp) mg.drawImage(bmp, l.x - box[0], l.y - box[1]);
    }
    return [box[0], box[1]];
  };

  const lidsFor = (st: State): void => {
    const e = m.expressions[st.expression];
    const pose = e?.poses[resolvePoseName(e, m, st.pose)];
    const half = pose?.eyes?.half;
    const closed = pose?.eyes?.closed;
    const hb = half ? c.get(half) : undefined;
    const cb = closed ? c.get(closed) : undefined;
    gl.setLids(hb && half ? { key: half, src: hb } : null, cb && closed ? { key: closed, src: cb } : null);
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
  const headGain = eyeSetFor(shown).eyes ? 1 : NO_IRIS_HEAD_GAIN;

  /** The baked pose her head direction calls for (hysteresis, held a while). */
  const posePick = (headX: number, now: number, avail: readonly string[]): string => {
    if (now - poseSince < POSE_HOLD_MS) return idlePose;
    const a = Math.abs(headX);
    const side = headX < 0 ? 'l' : 'r';
    const cur = idlePose;
    let next = cur;
    if (cur === 'c') {
      if (a > 0.42) next = `${side}1`;
    } else if (cur.endsWith('1')) {
      if (a < 0.26 || cur[0] !== side) next = 'c';
      else if (a > 0.8) next = `${side}2`;
    } else if (cur.endsWith('2')) {
      if (a < 0.62 || cur[0] !== side) next = `${cur[0]}1`;
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
    for (const f of filesFor(m, shown.expression, shown.pose)) keep.add(f);
    if (prev) for (const f of filesFor(m, prev.expression, prev.pose)) keep.add(f);
    if (loading) for (const f of filesFor(m, target.expression, target.pose)) keep.add(f);
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
      const want = g ? posePick(g.headX * headGain, now, avail) : idlePose;
      target.pose = avail.includes(want) ? want : avail.includes('c') ? 'c' : avail[0];
    }
    if (target.expression !== shown.expression || target.pose !== shown.pose) {
      const files = filesFor(m, target.expression, target.pose);
      if (files.every((f) => c.has(f))) {
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
        trim();
      } else {
        const key = `${target.expression}/${target.pose}`;
        if (loading !== key) {
          loading = key;
          void c.load(files);
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

  // Warm the turned poses of the starting expression (big glances use them).
  void c.load(posesOf(m, env.startExpr).flatMap((pp) => filesFor(m, env.startExpr, pp)));

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
