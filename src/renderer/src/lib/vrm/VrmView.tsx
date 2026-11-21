/**
 * VrmView (261122, experimental: feat/vrm-avatar) renders a character's
 * imported VRM (0.x or 1.0: VRoid Studio, VSeeFace and VTube Studio models)
 * with three.js + @pixiv/three-vrm. Same contract as Live2DView, so
 * AvatarView swaps it in by the manifest's `kind` and every host (the room,
 * the overlay tile, the profile preview) gets it with no change.
 *
 * Everything heavy (three, GLTFLoader, three-vrm: vrmStack.ts) is one dynamic
 * import on mount, so a surface that never shows a VRM pays nothing.
 *
 * Behaviour (the Live2D contract):
 *  - Pose: VRM rests in a T-pose, so the arms are lowered on the normalized
 *    humanoid bones; breathing (spine and chest pitch, a little shoulder
 *    rise) and a slow sway (hips and spine, Wander noise) run on top.
 *  - Gaze: the same GazeDriver as Live2D (motion/organic.ts) with the same
 *    cursor feed (onAvatarOverlayCursor, the room host's hover poll); the head
 *    follows on neck + head bones, the eyes through VRM lookAt (yaw / pitch,
 *    bone or expression applier, whatever the model has), eyes = gaze minus
 *    head.
 *  - Blink: Blinker lid timing on the VRM `blink` expression (expressions
 *    that close the eyes override it, per the model's own settings).
 *  - Mouth: `speaking` + `levelRef` (RMS envelope) with Live2D's smoothing,
 *    mixed into aa / ih / ou / ee / oh by VisemeMixer (vrmMotion.ts); no level
 *    feed = the same pseudo envelope.
 *  - Emotion: manifest.emotions (happy, angry, sad, relaxed, surprised) eased
 *    in and out; it lives for the line plus half its length, as in Live2D.
 *  - Spring bones (hair and cloth) run in vrm.update(); the step is capped so
 *    a pause or a long frame never throws the hair.
 *  - Cost: at most 30 fps (or the host's lower cap), 0 = stopped; rAF also
 *    stops in a hidden document. powerPreference 'low-power' keeps dual-GPU
 *    laptops on the iGPU, the pixel ratio is capped at 2, no shadows.
 *  - A lost WebGL context or a failed load reports 'error', so RoomAvatar
 *    falls through to the face set / portrait.
 *
 * Analytics (shape only): vrm_avatar_shown {vrm_version, load, fps} once a
 * view has drawn for a while, vrm_avatar_failed {stage}. Through sei.track
 * when the window has it (the WorldLink host page does not; there the host's
 * avatarShown 'vrm' is the signal).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AvatarCamera, AvatarEmotion, AvatarManifest } from '@shared/ipc';
import { sei } from '../ipcClient';
import { resolveEmotionExpression } from '../avatar/emotion';
import { FramePacer } from '../framePacer';
import { Blinker, GazeDriver, Wander, type GazeConfig, type GazeInput } from '../motion/organic';
import { fpsBucket, frameModel, loadMsBucket, VisemeMixer, VISEMES } from './vrmMotion';

export interface VrmViewProps {
  characterId: string;
  speaking?: boolean;
  levelRef?: React.MutableRefObject<number>;
  emotion?: AvatarEmotion | null;
  camera?: AvatarCamera | null;
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
  /** Frame cap: absent = 30, 0 = paused. */
  fps?: number;
}

const DEFAULT_FPS = 30;
const MAX_FPS = 30;
/** Narrow lens: little perspective, reads like a drawn figure. */
const FOV_DEG = 20;
/** Longest physics / animation step (s): a long frame or a resume never flings the hair. */
const MAX_STEP_S = 1 / 20;
const EXPRESSION_LINGER_FRACTION = 0.5;
/** Emotion fade speed (per second, exponential). */
const EMOTION_RATE = 9;
const CURSOR_FRESH_MS = 2_000;
const CURSOR_GAIN_X = 0.75;
const CURSOR_GAIN_Y = 0.6;
const VRM_GAZE: Partial<GazeConfig> = { cursorChance: 0.4 };
/** Head (deg) at a full head turn, split over neck and head; the spine follows a little. */
const HEAD_YAW_DEG = 26;
const HEAD_PITCH_DEG = 18;
const HEAD_ROLL_DEG = 7;
const SPINE_YAW_DEG = 5;
/** Eyes (deg, VRM lookAt) at a full eye-in-head deflection. */
const EYE_YAW_DEG = 22;
const EYE_PITCH_DEG = 14;
const MOUTH_ATTACK = 0.5;
const MOUTH_RELEASE = 0.18;
/** Arms down from the T-pose (rad), elbows a touch bent. */
const ARM_DOWN = 1.22;
const ELBOW = 0.12;
/** Breathing (period ms, chest pitch rad) and sway (rad). */
const BREATH_MS = 4_300;
const BREATH_PITCH = 0.014;
const SWAY_ROLL = 0.012;
const SWAY_YAW = 0.02;
/** Analytics: report the frame rate after this long on screen. */
const SHOWN_AFTER_MS = 10_000;

type Stack = typeof import('./vrmStack');
type Vrm = import('./vrmStack').VRM;

/** Dev builds only: `window.__seiVrmForce = { blink: 1, mouth: 0.8 }` pins the lids / mouth for screenshots. */
function devForce(): { blink?: number; mouth?: number } | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (window as unknown as { __seiVrmForce?: { blink?: number; mouth?: number } }).__seiVrmForce;
}

function track(event: string, props: Record<string, string | number>): void {
  try {
    (sei as unknown as { track?: (e: string, p: Record<string, string | number>) => void }).track?.(event, props);
  } catch {
    /* analytics never disrupts the view */
  }
}

export function VrmView({ characterId, speaking = false, levelRef, emotion = null, camera = null, className, onStatus, fps }: VrmViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const cameraRef = useRef<AvatarCamera | null>(camera);
  cameraRef.current = camera;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const fitRef = useRef<(() => void) | null>(null);
  const kickRef = useRef<(() => void) | null>(null);
  const manifestRef = useRef<AvatarManifest | null>(null);
  /** The expression the current emotion shows (null = neutral). */
  const emotionNameRef = useRef<string | null>(null);
  const appliedRef = useRef<AvatarEmotion | null>(null);
  /** A re-import of another VRM (same kind, so AvatarView keeps this view) reloads it. */
  const [rev, setRev] = useState<string | null>(null);
  useEffect(
    () =>
      sei.onAvatarManifest?.((u) => {
        if (u.characterId === characterId && u.manifest?.kind === 'vrm') setRev(u.manifest.importedAt);
      }),
    [characterId],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let raf = 0;
    let renderer: import('three').WebGLRenderer | null = null;
    let vrm: Vrm | null = null;
    let stack: Stack | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let offCursor: (() => void) | undefined;
    let failed = false;
    const t0 = performance.now();
    onStatusRef.current?.('loading');

    const fail = (stage: string, err?: unknown): void => {
      if (cancelled || failed) return;
      failed = true;
      // eslint-disable-next-line no-console
      console.warn(`[VrmView] ${stage} failed`, err);
      track('vrm_avatar_failed', { stage });
      onStatusRef.current?.('error');
    };

    void (async () => {
      let stage = 'files';
      try {
        const [s, manifest, files] = await Promise.all([import('./vrmStack'), sei.avatarGet(characterId), sei.avatarModelFiles(characterId)]);
        if (cancelled) return;
        stack = s;
        const THREE = s;
        const entry = manifest ? files.find((f) => f.path === manifest.entry) : undefined;
        if (!manifest || manifest.kind !== 'vrm' || !entry) throw new Error('no VRM model');
        manifestRef.current = manifest;
        // An emotion that arrived before the model did.
        if (appliedRef.current) emotionNameRef.current = resolveEmotionExpression(manifest.emotions, appliedRef.current);

        stage = 'webgl';
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
        renderer = r;
        r.setClearColor(0x000000, 0);
        r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        r.outputColorSpace = THREE.SRGBColorSpace;
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          cancelAnimationFrame(raf);
          raf = 0;
          fail('context_lost');
        });

        stage = 'parse';
        const loader = new s.GLTFLoader();
        loader.register((parser) => new s.VRMLoaderPlugin(parser));
        const bytes = entry.bytes;
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const gltf = await loader.parseAsync(buf, '');
        const v = gltf.userData.vrm as Vrm | undefined;
        if (!v) throw new Error('not a VRM');
        if (cancelled) {
          s.VRMUtils.deepDispose(gltf.scene);
          return;
        }
        vrm = v;
        s.VRMUtils.removeUnnecessaryVertices(gltf.scene);
        s.VRMUtils.combineSkeletons(gltf.scene);
        s.VRMUtils.rotateVRM0(v); // 0.x faces -z; 1.0 faces +z (the camera side)
        v.scene.traverse((o) => {
          o.frustumCulled = false; // skinned bounds lag the pose; never cull her
        });
        host.appendChild(canvas);

        // ── scene: a key light from the front-top and a soft fill (MToon's shade does the rest)
        const scene = new THREE.Scene();
        scene.add(v.scene);
        const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
        key.position.set(0.4, 1.4, 1.6);
        scene.add(key);
        scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d0e0, 0.6));
        const cam = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 50);

        // ── rest pose (arms down) before measuring her
        const bone = (name: string): import('three').Object3D | null =>
          v.humanoid?.getNormalizedBoneNode(name as Parameters<NonNullable<Vrm['humanoid']>['getNormalizedBoneNode']>[0]) ?? null;
        const bones = {
          hips: bone('hips'),
          spine: bone('spine'),
          chest: bone('chest') ?? bone('upperChest'),
          neck: bone('neck'),
          head: bone('head'),
          lUpper: bone('leftUpperArm'),
          rUpper: bone('rightUpperArm'),
          lLower: bone('leftLowerArm'),
          rLower: bone('rightLowerArm'),
          lShoulder: bone('leftShoulder'),
          rShoulder: bone('rightShoulder'),
        };
        // A 0.x model's normalized bones face -z under rotateVRM0's 180 degree
        // turn, so rotations about x and z flip sign there (yaw does not).
        const f0 = v.meta?.metaVersion === '0' ? -1 : 1;
        const pose = (breath: number, sway: number, swayYaw: number, headYaw: number, headPitch: number, headRoll: number): void => {
          if (bones.lUpper) bones.lUpper.rotation.z = f0 * (-ARM_DOWN + breath * 0.02);
          if (bones.rUpper) bones.rUpper.rotation.z = f0 * (ARM_DOWN - breath * 0.02);
          if (bones.lLower) bones.lLower.rotation.z = -f0 * ELBOW;
          if (bones.rLower) bones.rLower.rotation.z = f0 * ELBOW;
          if (bones.lShoulder) bones.lShoulder.rotation.z = f0 * breath * 0.012;
          if (bones.rShoulder) bones.rShoulder.rotation.z = -f0 * breath * 0.012;
          if (bones.spine) {
            bones.spine.rotation.x = -f0 * breath * BREATH_PITCH * 0.6;
            bones.spine.rotation.z = f0 * sway * SWAY_ROLL;
            bones.spine.rotation.y = swayYaw * SWAY_YAW + (headYaw * SPINE_YAW_DEG * Math.PI) / 180;
          }
          if (bones.chest) bones.chest.rotation.x = -f0 * breath * BREATH_PITCH;
          if (bones.hips) bones.hips.rotation.z = -f0 * sway * SWAY_ROLL * 0.5;
          const yaw = (headYaw * HEAD_YAW_DEG * Math.PI) / 180;
          const pitch = (f0 * headPitch * HEAD_PITCH_DEG * Math.PI) / 180;
          const roll = (-f0 * headRoll * HEAD_ROLL_DEG * Math.PI) / 180;
          if (bones.neck) bones.neck.rotation.set(pitch * 0.4, yaw * 0.4, roll * 0.4);
          if (bones.head) bones.head.rotation.set(pitch * (bones.neck ? 0.6 : 1), yaw * (bones.neck ? 0.6 : 1), roll * (bones.neck ? 0.6 : 1));
        };
        pose(0, 0, 0, 0, 0, 0);
        v.update(0);
        scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(v.scene, true);
        const hipsAt = bones.hips?.getWorldPosition(new THREE.Vector3());
        const bounds = { minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y, centerX: hipsAt?.x };
        const modelZ = (box.min.z + box.max.z) / 2;
        v.springBoneManager?.reset();

        const fit = (): void => {
          const w = Math.max(1, host.clientWidth);
          const h = Math.max(1, host.clientHeight);
          r.setSize(w, h, false);
          cam.aspect = w / h;
          const f = frameModel(bounds, w / h, cameraRef.current, FOV_DEG);
          cam.position.set(f.x, f.y, modelZ + f.distance);
          cam.lookAt(f.x, f.y, modelZ);
          cam.near = Math.max(0.01, f.distance * 0.1);
          cam.far = f.distance * 10;
          cam.updateProjectionMatrix();
          kickRef.current?.();
        };
        fitRef.current = fit;
        fit();
        resizeObserver = new ResizeObserver(() => fit());
        resizeObserver.observe(host);

        // ── life: gaze, blink, mouth, emotion
        const em = v.expressionManager;
        const has = new Set<string>(em ? Object.keys(em.expressionMap) : []);
        const visemes = new VisemeMixer(has);
        const gazeDriver = new GazeDriver(performance.now(), VRM_GAZE);
        const blinker = new Blinker(performance.now());
        const breathPhase = Math.random() * BREATH_MS;
        const sway = new Wander([7_300, 11_900, 17_100]);
        const swayYaw = new Wander([9_100, 15_700]);
        const gazeIn: GazeInput = { cursor: null, engaged: false };
        const cursor = { x: 0, y: 0, at: 0 };
        const cursorPt = { x: 0, y: 0 };
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.y = pt.y;
          cursor.at = Date.now();
        });
        if (v.lookAt) v.lookAt.autoUpdate = false;
        const emotionWeights = new Map<string, number>();
        let mouth = 0;
        let pseudo = 0;
        let lastT = -1;
        let drawn = 0;
        let shownSent = false;
        let firstDrawAt = 0;
        const pacer = new FramePacer();

        const step = (t: number): void => {
          raf = 0;
          if (cancelled || failed) return;
          const cap = Math.min(MAX_FPS, fpsRef.current ?? DEFAULT_FPS);
          if (!(cap > 0)) {
            pacer.reset();
            lastT = -1;
            return; // stopped; the fps effect kicks it again
          }
          raf = requestAnimationFrame(step);
          if (!pacer.due(t, cap)) return;
          const dt = lastT < 0 ? 0 : Math.min(MAX_STEP_S, (t - lastT) / 1000);
          lastT = t;
          try {
            const now = performance.now();
            // Gaze
            const fresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
            if (fresh) {
              cursorPt.x = cursor.x * CURSOR_GAIN_X;
              cursorPt.y = -cursor.y * CURSOR_GAIN_Y;
            }
            gazeIn.cursor = fresh ? cursorPt : null;
            gazeIn.engaged = speakingRef.current;
            const g = gazeDriver.update(now, gazeIn);
            if (import.meta.env.DEV) (window as unknown as { __seiVrmGaze?: unknown }).__seiVrmGaze = g;
            if (g.bigSaccadeAt > now - 60) blinker.nudge(now);
            const breath = Math.sin(((now + breathPhase) / BREATH_MS) * Math.PI * 2);
            pose(breath, sway.value(now), swayYaw.value(now), g.headX, g.headY, g.headRoll);
            if (v.lookAt) {
              v.lookAt.yaw = g.eyeX * EYE_YAW_DEG;
              v.lookAt.pitch = g.eyeY * EYE_PITCH_DEG;
            }
            if (em) {
              // Emotion: ease every weight toward its target.
              const want = emotionNameRef.current;
              const k = 1 - Math.exp(-EMOTION_RATE * Math.max(dt, 1 / 60));
              if (want && has.has(want) && !emotionWeights.has(want)) emotionWeights.set(want, 0);
              for (const [name, w] of emotionWeights) {
                const next = w + ((name === want ? 1 : 0) - w) * k;
                if (name !== want && next < 0.01) {
                  emotionWeights.delete(name);
                  em.setValue(name, 0);
                } else {
                  emotionWeights.set(name, next);
                  em.setValue(name, next);
                }
              }
              // Blink (an eye-closing emotion overrides it through the model's own override settings).
              const force = devForce();
              if (has.has('blink')) em.setValue('blink', force?.blink ?? blinker.lid(now));
              // Mouth
              let target = 0;
              if (speakingRef.current) {
                const level = levelRef?.current ?? -1;
                if (level >= 0) target = Math.min(1, level);
                else {
                  pseudo += 0.35;
                  target = 0.25 + 0.35 * Math.abs(Math.sin(pseudo));
                }
              }
              if (force?.mouth !== undefined) target = force.mouth;
              mouth += (target - mouth) * (target > mouth ? MOUTH_ATTACK : MOUTH_RELEASE);
              const vw = visemes.weights(mouth);
              for (const name of VISEMES) if (has.has(name)) em.setValue(name, vw[name]);
            }
            v.update(dt);
            r.render(scene, cam);
          } catch (err) {
            fail('frame', err);
            return;
          }
          drawn++;
          if (drawn === 1) {
            firstDrawAt = performance.now();
            onStatusRef.current?.('ready');
          } else if (!shownSent && performance.now() - firstDrawAt >= SHOWN_AFTER_MS) {
            shownSent = true;
            const secs = (performance.now() - firstDrawAt) / 1000;
            track('vrm_avatar_shown', {
              vrm_version: v.meta?.metaVersion === '0' ? '0.x' : '1.0',
              load: loadMsBucket(firstDrawAt - t0),
              fps: fpsBucket((drawn - 1) / secs),
              cap: cap,
            });
          }
        };
        kickRef.current = () => {
          if (!raf && !cancelled && !failed) raf = requestAnimationFrame(step);
        };
        kickRef.current();
      } catch (err) {
        fail(stage, err);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      fitRef.current = null;
      kickRef.current = null;
      offCursor?.();
      resizeObserver?.disconnect();
      try {
        if (vrm && stack) stack.VRMUtils.deepDispose(vrm.scene);
      } catch {
        /* already gone */
      }
      try {
        renderer?.dispose();
        renderer?.forceContextLoss();
      } catch {
        /* already gone */
      }
      host.replaceChildren();
    };
  }, [characterId, levelRef, rev]);

  // Frame cap changed (0 = paused, anything else restarts a stopped loop).
  useEffect(() => {
    kickRef.current?.();
  }, [fps]);

  useEffect(() => {
    fitRef.current?.();
  }, [camera?.zoom, camera?.x, camera?.y]);

  // ── Emotion: a line's emotion shows while it is spoken, then lingers half the line (Live2DView's rule).
  const lineStartRef = useRef(0);
  const prevSpeakingRef = useRef(false);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wasSpeaking = prevSpeakingRef.current;
    prevSpeakingRef.current = speaking;
    if (speaking && !wasSpeaking) lineStartRef.current = Date.now();
    if (emotion && emotion !== appliedRef.current) {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = null;
      lineStartRef.current = Date.now();
      const name = resolveEmotionExpression(manifestRef.current?.emotions, emotion);
      appliedRef.current = emotion;
      emotionNameRef.current = name;
    }
    if (!speaking && wasSpeaking && appliedRef.current) {
      const lineMs = Math.max(0, Date.now() - lineStartRef.current);
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = setTimeout(
        () => {
          decayTimerRef.current = null;
          appliedRef.current = null;
          emotionNameRef.current = null;
        },
        Math.round(lineMs * EXPRESSION_LINGER_FRACTION),
      );
    }
  }, [emotion, speaking]);
  useEffect(
    () => () => {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    },
    [],
  );

  return <div ref={hostRef} className={className} />;
}
