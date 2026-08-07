/**
 * Live2DView (260804) — renders a character's imported Live2D model with the
 * idle/talk behaviors, shared by the profile Avatar tab's preview and the
 * always-on-top overlay tile.
 *
 * Everything heavy (pixi.js + the cubism4 plugin + the proprietary Core) is
 * dynamically imported on mount, so surfaces that never show a Live2D model
 * pay nothing.
 *
 * Liveliness model (AIRI-informed, own constants — see
 * .planning/avatar-v06-260804.md):
 *  - Breath/sway + blink come FREE from the Cubism SDK on a motionless model
 *    (import guarantees the EyeBlink group exists), physics on top.
 *  - Gaze (260806): alternates between WANDER (correlated random targets on
 *    the old saccade cadence) and CURSOR-FOLLOW (the user's real pointer,
 *    polled by main and pushed over avatar:overlay-cursor-state — only the
 *    overlay window receives it; anywhere else the feed is stale and the
 *    gaze simply wanders). The published focus target GLIDES at constant
 *    speed toward the goal per frame and is handed to the focusController
 *    with instant=true, so the SDK's constant-speed pursuit never sees a
 *    stepped target. That pursuit was the ~5 s jitter: FocusController runs
 *    at MAX_SPEED ≈ 5.3 units/s toward its target and only decelerates on
 *    arrival, so every saccade retarget (mean ~5 s) yanked the face ahead
 *    for about a second mid-drift.
 *  - Mouth: driven per frame from `speaking` + `levelRef` (0..1 RMS envelope
 *    relayed from wherever the TTS actually plays). Written INSIDE a wrapped
 *    motionManager.update so the SDK layers blink/breath/physics after it and
 *    nothing later in the same frame stomps it. When speaking but no level
 *    arrives (older audio path), a pseudo-envelope keeps the mouth moving.
 *  - Expressions: `emotion` maps through the import manifest's emotion table
 *    (with fallback resolution for unmapped emotions); applied via
 *    model.expression(), decayed to neutral after the line's linger.
 *  - Accessories (260806): manifest.accessories toggles item expressions
 *    (hat, coat...) as per-frame absolute parameter writes — persistent, and
 *    independent of the single-slot expressionManager the emotions use.
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera, AvatarEmotion, AvatarManifest } from '@shared/ipc';
import { sei } from '../ipcClient';
import { resolveEmotionExpression } from '../avatar/emotion';
import { parseExpressionParams, computeAccessoryTargets } from '../avatar/accessoryParams';
import { loadCubismCore } from './loadCore';

export interface Live2DViewProps {
  characterId: string;
  /** True while this character is audibly speaking (drives the mouth). */
  speaking?: boolean;
  /** Latest mouth level 0..1, mutated externally at ~25 Hz. Read per frame —
   * a ref so level samples never re-render React. */
  levelRef?: React.MutableRefObject<number>;
  /** Emotion of the line being spoken (null = neutral). */
  emotion?: AvatarEmotion | null;
  /**
   * How the character is framed within the view (260806): `zoom` multiplies
   * the contain-fit scale (1 = whole model), `x`/`y` pan in view-size
   * fractions. Null/absent = default framing.
   */
  camera?: AvatarCamera | null;
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
}

/**
 * An expression lives for 150% of its line: it holds while the line is spoken,
 * then this fraction of the line's duration longer, then decays to neutral —
 * unless a new line's emotion refreshes it first. A 2 s quip flashes its face
 * for ~3 s; a long story holds it long after the last word.
 */
const EXPRESSION_LINGER_FRACTION = 0.5;
/** Gaze wander interval bounds (ms). Long on purpose: at 0.6-4.6 s with
 * full-range jumps the head visibly TWITCHED between directions every few
 * seconds; a calm idle looks mostly still. */
const SACCADE_MIN_MS = 2_600;
const SACCADE_MAX_MS = 7_500;
/** Fraction of the previous gaze target kept each step — targets stay
 * correlated, so consecutive looks are neighbors, not opposite corners. */
const GAZE_KEEP = 0.35;
/** Usual wander amplitude, and the rarer bigger glance. */
const GAZE_STEP_X = 0.2;
const GAZE_STEP_Y = 0.14;
const GLANCE_CHANCE = 0.15;
const GLANCE_STEP_X = 0.45;
const GLANCE_STEP_Y = 0.28;
/** Gaze mode alternation (260806): every 6-14 s re-pick between wandering
 * and following the user's real cursor (only when the cursor feed is fresh —
 * main polls it only for the overlay window while a Live2D tile shows). */
const MODE_MIN_MS = 6_000;
const MODE_MAX_MS = 14_000;
const CURSOR_CHANCE = 0.45;
/** Cursor samples older than this mean the feed is gone (main pushes at
 * ~8 Hz): fall back to wander rather than staring at a frozen point. */
const CURSOR_FRESH_MS = 2_000;
/** How far the face turns toward the cursor, per axis: the pushed sample is
 * [-1, 1] across the display around the window center; full deflection at
 * the screen edge reads cross-eyed, so it is scaled down and clamped to the
 * same comfortable range the wander uses. */
const CURSOR_GAIN_X = 0.75;
const CURSOR_GAIN_Y = 0.6;
/** Gaze glide (the ~5 s jitter fix, reworked 260806): the published focus
 * target moves toward the goal at CONSTANT SPEED (units/s) and is applied
 * with instant=true — so the SDK's own constant-speed FocusController
 * (MAX_SPEED ≈ 5.3 units/s, decelerating only on arrival) never receives a
 * step it would lurch after. Constant speed, not a time constant: an
 * exponential glide covers a big saccade in the same time as a small one,
 * which makes large glances whip and small ones crawl; at fixed speed the
 * travel time scales with the distance, like a real eye drift. The short
 * arrive zone eases the last fraction so arrival is not a hard stop. */
const GAZE_SPEED = 0.9;
const GAZE_ARRIVE_DIST = 0.06;
/** Mouth smoothing per frame (fast attack, slower release). */
const MOUTH_ATTACK = 0.5;
const MOUTH_RELEASE = 0.18;

type Live2DModelT = {
  width: number;
  height: number;
  anchor: { set: (x: number, y: number) => void };
  position: { set: (x: number, y: number) => void };
  scale: { set: (s: number) => void };
  destroy: (opts?: unknown) => void;
  expression: (id?: number | string) => Promise<boolean>;
  internalModel: {
    coreModel: {
      setParameterValueById: (id: string, v: number) => void;
      getParameterIndex: (id: string) => number;
      getParameterCount: () => number;
      getParameterDefaultValue: (index: number) => number;
    };
    focusController: { focus: (x: number, y: number, instant?: boolean) => void };
    motionManager: {
      update: (...args: unknown[]) => boolean;
      expressionManager?: {
        resetExpression: () => void;
        currentExpression?: unknown;
        defaultExpression?: unknown;
      };
    };
  };
};

export function Live2DView({
  characterId,
  speaking = false,
  levelRef,
  emotion = null,
  camera = null,
  className,
  onStatus,
}: Live2DViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Live2DModelT | null>(null);
  const manifestRef = useRef<AvatarManifest | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // Read per layout pass (fit); a camera change re-fits via the effect below
  // without reloading the model.
  const cameraRef = useRef<AvatarCamera | null>(camera);
  cameraRef.current = camera;
  const fitRef = useRef<(() => void) | null>(null);

  // ── Mount: load libs + model, wire idle + mouth, handle resize ──────────
  useEffect(() => {
    let cancelled = false;
    let app: { destroy: (removeView?: boolean, opts?: unknown) => void; renderer: { resize: (w: number, h: number) => void } } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let saccadeTimer: ReturnType<typeof setTimeout> | null = null;
    let gazeModeTimer: ReturnType<typeof setTimeout> | null = null;
    let offCursor: (() => void) | undefined;
    let offManifest: (() => void) | undefined;
    const host = hostRef.current;
    if (!host) return undefined;

    onStatusRef.current?.('loading');

    void (async () => {
      try {
        // The Core global must exist BEFORE the cubism4 plugin module is
        // imported (loadCore's contract), so the plugin import is sequenced
        // behind it; everything else loads in parallel.
        const [PIXI, manifest, rawFiles, plugin] = await Promise.all([
          import('pixi.js'),
          sei.avatarGet(characterId),
          sei.avatarModelFiles(characterId),
          loadCubismCore().then(() => import('pixi-live2d-display-lipsyncpatch/cubism4')),
        ]);
        if (cancelled) return;
        if (!manifest || rawFiles.length === 0) throw new Error('no avatar model');
        manifestRef.current = manifest;

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);

        const pixiApp = new PIXI.Application({
          view: canvas,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(2, window.devicePixelRatio || 1),
          width: Math.max(1, host.clientWidth),
          height: Math.max(1, host.clientHeight),
          // Keep dual-GPU laptops on the iGPU; idle Live2D is cheap.
          powerPreference: 'low-power',
        });
        app = pixiApp as unknown as typeof app;

        // Build in-memory Files: the plugin's FileLoader resolves the
        // model3.json's relative refs via webkitRelativePath (not settable
        // through the File constructor, hence defineProperty). The TRUE entry
        // goes FIRST: the loader picks its settings file with
        // `find(name.endsWith("model.json") || name.endsWith("model3.json"))`,
        // and VTube Studio exports ship extras like items_pinned_to_model.json
        // that match that sniff — whichever readdir happened to list first won.
        rawFiles.sort((a, b) =>
          a.path === manifest.entry ? -1 : b.path === manifest.entry ? 1 : 0,
        );
        const files = rawFiles.map((f) => {
          const name = f.path.split('/').pop() ?? f.path;
          const file = new File([f.bytes as BlobPart], name);
          Object.defineProperty(file, 'webkitRelativePath', { value: f.path });
          return file;
        });

        const model = (await plugin.Live2DModel.from(files as unknown as string, {
          autoInteract: false,
          autoHitTest: false,
          autoFocus: false,
          ticker: PIXI.Ticker.shared,
        })) as unknown as Live2DModelT;
        if (cancelled) {
          model.destroy();
          return;
        }
        modelRef.current = model;

        // ── Accessories (260806): toggled item expressions (hat, coat...)
        // resolved to ABSOLUTE parameter targets, written every frame by the
        // update wrapper below. They cannot ride the expressionManager: it
        // holds ONE expression, so the next emotion expression would knock
        // the accessory off and its decay-reset would undo the toggle.
        const filesByPath = new Map(rawFiles.map((f) => [f.path, f.bytes]));
        const accessoryTargets = new Map<string, number>();
        const applyAccessoryToggles = (m: AvatarManifest | null): void => {
          const stale = [...accessoryTargets.keys()];
          accessoryTargets.clear();
          const core = model.internalModel.coreModel;
          const defaultOf = (id: string): number => {
            const idx = core.getParameterIndex(id);
            return idx < core.getParameterCount() ? core.getParameterDefaultValue(idx) : 0;
          };
          const sets = (m?.accessories ? m.expressions : [])
            .filter((e) => m?.accessories?.[e.name] === true)
            .map((e) => {
              const bytes = filesByPath.get(e.file);
              if (!bytes) return [];
              try {
                return parseExpressionParams(JSON.parse(new TextDecoder().decode(bytes)));
              } catch {
                return [];
              }
            });
          for (const [id, v] of computeAccessoryTargets(sets, defaultOf)) {
            accessoryTargets.set(id, v);
          }
          // Cubism params persist frame to frame, so a parameter the change
          // DROPPED would stay stuck at its accessory value forever: write
          // its default back once.
          try {
            for (const id of stale) {
              if (!accessoryTargets.has(id)) core.setParameterValueById(id, defaultOf(id));
            }
          } catch {
            /* mid-destroy */
          }
        };
        applyAccessoryToggles(manifest);
        // Toggles flip live from the profile's Avatar tab: main broadcasts
        // the updated manifest to every window.
        offManifest = sei.onAvatarManifest?.((update) => {
          if (update.characterId !== characterId) return;
          manifestRef.current = update.manifest;
          applyAccessoryToggles(update.manifest);
        });

        // ── Gaze state, read per frame by the update wrapper below ─────────
        // The GOALS are written by the wander/mode timers and the cursor
        // push; the published focus value `gaze` glides toward the active
        // goal each frame (see the constants for why stepping the
        // focusController directly is the ~5 s jitter).
        const wanderGoal = { x: 0, y: 0 };
        const cursor = { x: 0, y: 0, at: 0 };
        let gazeMode: 'wander' | 'cursor' = 'wander';
        const gaze = { x: 0, y: 0 };
        let lastGazeAt = performance.now();

        // Mouth writer + gaze pursuit, layered INSIDE the SDK's update so
        // blink/breath/physics still run after it in the same frame.
        let mouth = 0;
        const mm = model.internalModel.motionManager;
        const originalUpdate = mm.update.bind(mm);
        let pseudoPhase = 0;
        mm.update = (...args: unknown[]) => {
          const result = originalUpdate(...args);
          try {
            let target = 0;
            if (speakingRef.current) {
              const level = levelRef?.current ?? -1;
              if (level >= 0) target = Math.min(1, level);
              else {
                // No level feed: syllable-ish pseudo-envelope so the mouth
                // never freezes open or shut while audibly speaking.
                pseudoPhase += 0.35;
                target = 0.25 + 0.35 * Math.abs(Math.sin(pseudoPhase));
              }
            }
            mouth += (target - mouth) * (target > mouth ? MOUTH_ATTACK : MOUTH_RELEASE);
            model.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', mouth);

            // Accessory toggles: absolute targets, every frame. This runs
            // inside motionManager.update, i.e. BEFORE saveParameters and
            // the SDK's expression pass, so the values persist frame to
            // frame; an emotion expression touching the same parameter
            // (none do — emotions drive faces, accessories drive items)
            // would win only while it plays.
            for (const [id, v] of accessoryTargets) {
              model.internalModel.coreModel.setParameterValueById(id, v);
            }

            // Gaze: ease the published focus toward the active mode's goal
            // and apply it with instant=true — our glide IS the motion, the
            // SDK's constant-speed pursuit never sees a discontinuity.
            const now = performance.now();
            const dt = Math.min(100, Math.max(0, now - lastGazeAt));
            lastGazeAt = now;
            const cursorFresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
            const goalX =
              gazeMode === 'cursor' && cursorFresh
                ? Math.max(-0.7, Math.min(0.7, cursor.x * CURSOR_GAIN_X))
                : wanderGoal.x;
            const goalY =
              gazeMode === 'cursor' && cursorFresh
                ? Math.max(-0.45, Math.min(0.35, cursor.y * CURSOR_GAIN_Y))
                : wanderGoal.y;
            const gdx = goalX - gaze.x;
            const gdy = goalY - gaze.y;
            const dist = Math.hypot(gdx, gdy);
            if (dist > 0.001 && dt > 0) {
              // Constant-speed travel, easing off only inside the arrive zone.
              const speed = GAZE_SPEED * Math.min(1, dist / GAZE_ARRIVE_DIST);
              const step = Math.min(dist, speed * (dt / 1000));
              gaze.x += (gdx / dist) * step;
              gaze.y += (gdy / dist) * step;
              model.internalModel.focusController.focus(gaze.x, gaze.y, true);
            }
          } catch {
            /* a mid-destroy frame must never throw into the ticker */
          }
          return result;
        };

        // Layout: contain the whole model, centered — then the camera on top
        // (zoom multiplies the contain fit, pan offsets in view fractions, so
        // a framing survives any tile resize).
        const fit = (): void => {
          const w = Math.max(1, host.clientWidth);
          const h = Math.max(1, host.clientHeight);
          pixiApp.renderer.resize(w, h);
          const naturalW = model.width / (model as unknown as { scale: { x: number } }).scale.x;
          const naturalH = model.height / (model as unknown as { scale: { y: number } }).scale.y;
          const cam = cameraRef.current;
          const s = Math.min(w / naturalW, h / naturalH) * (cam?.zoom ?? 1);
          model.scale.set(s);
          model.anchor.set(0.5, 0.5);
          model.position.set(w / 2 + (cam?.x ?? 0) * w, h / 2 + (cam?.y ?? 0) * h);
        };
        fitRef.current = fit;
        (pixiApp.stage as unknown as { addChild: (c: unknown) => void }).addChild(model);
        fit();
        resizeObserver = new ResizeObserver(() => fit());
        resizeObserver.observe(host);

        // Idle gaze wander: correlated small steps around center (each
        // target keeps a fraction of the last), with an occasional larger
        // glance — attention, not a head on a swivel. Writes the wander GOAL
        // only; the eased pursuit in the update wrapper is the sole writer
        // of the focusController.
        const saccade = (): void => {
          if (cancelled) return;
          const glance = Math.random() < GLANCE_CHANCE;
          const ax = glance ? GLANCE_STEP_X : GAZE_STEP_X;
          const ay = glance ? GLANCE_STEP_Y : GAZE_STEP_Y;
          wanderGoal.x = Math.max(
            -0.55,
            Math.min(0.55, wanderGoal.x * GAZE_KEEP + (Math.random() * 2 - 1) * ax),
          );
          wanderGoal.y = Math.max(
            -0.4,
            Math.min(0.3, wanderGoal.y * GAZE_KEEP + (Math.random() * 1.7 - 1) * ay),
          );
          saccadeTimer = setTimeout(
            saccade,
            SACCADE_MIN_MS + Math.random() * (SACCADE_MAX_MS - SACCADE_MIN_MS),
          );
        };
        saccade();

        // Cursor-follow alternation (260806): main polls the real cursor for
        // the overlay window while a Live2D tile shows; every 6-14 s the
        // gaze re-picks between wandering and following it. In surfaces that
        // never receive the push (the profile preview) the feed stays stale
        // and the mode never leaves wander. Transitions are smooth for free:
        // the eased pursuit glides between the two goals.
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.y = pt.y;
          cursor.at = Date.now();
        });
        const pickGazeMode = (): void => {
          if (cancelled) return;
          const fresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
          gazeMode = fresh && Math.random() < CURSOR_CHANCE ? 'cursor' : 'wander';
          gazeModeTimer = setTimeout(
            pickGazeMode,
            MODE_MIN_MS + Math.random() * (MODE_MAX_MS - MODE_MIN_MS),
          );
        };
        pickGazeMode();

        onStatusRef.current?.('ready');
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[Live2DView] load failed', err);
          onStatusRef.current?.('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      fitRef.current = null;
      if (saccadeTimer) clearTimeout(saccadeTimer);
      if (gazeModeTimer) clearTimeout(gazeModeTimer);
      offCursor?.();
      offManifest?.();
      resizeObserver?.disconnect();
      try {
        modelRef.current?.destroy();
      } catch {
        /* already gone */
      }
      modelRef.current = null;
      try {
        app?.destroy(true, { children: true });
      } catch {
        /* already gone */
      }
      host.replaceChildren();
    };
  }, [characterId, levelRef]);

  // Re-fit when the camera changes (edit-mode wheel/drag streams new values).
  useEffect(() => {
    fitRef.current?.();
  }, [camera?.zoom, camera?.x, camera?.y]);

  // ── Expressions: apply on a line's emotion, decay at 150% of the line ────
  // The emotion prop is per-LINE (the pusher classifies the audibly-playing
  // line and sends null between lines), so an emotion CHANGE marks a new line
  // and `speaking` falling marks its end. Nothing resets on emotion → null —
  // the face outlives the line by EXPRESSION_LINGER_FRACTION of its duration.
  const appliedRef = useRef<AvatarEmotion | null>(null);
  const lineStartRef = useRef(0);
  const prevSpeakingRef = useRef(false);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const model = modelRef.current;
    const wasSpeaking = prevSpeakingRef.current;
    prevSpeakingRef.current = speaking;
    const resetToNeutral = (): void => {
      appliedRef.current = null;
      try {
        const mgr = model?.internalModel.motionManager.expressionManager;
        mgr?.resetExpression();
        // resetExpression deliberately KEEPS currentExpression (the SDK's
        // restoreExpression semantics), but setExpression refuses a name
        // equal to currentExpression — so without this, a decayed face could
        // never come back on the next line with the SAME emotion (and happy
        // is the most common one). Mirror the manager's init state instead.
        if (mgr) mgr.currentExpression = mgr.defaultExpression;
      } catch {
        /* gone */
      }
    };

    if (speaking && !wasSpeaking) lineStartRef.current = Date.now();

    if (emotion && emotion !== appliedRef.current) {
      // A (new) line with an emotion: refresh, cancelling any pending decay.
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = null;
      lineStartRef.current = Date.now();
      // Fallback resolution (260806): a model with no dedicated happy or
      // surprised face borrows a mapped neighbor instead of staying blank.
      const name = resolveEmotionExpression(manifestRef.current?.emotions, emotion);
      if (model && name) {
        appliedRef.current = emotion;
        void model.expression(name).catch(() => {});
      }
    }

    if (!speaking && wasSpeaking && appliedRef.current) {
      // Line over: linger for half of what the line took, then decay.
      const lineMs = Math.max(0, Date.now() - lineStartRef.current);
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      decayTimerRef.current = setTimeout(
        () => {
          decayTimerRef.current = null;
          resetToNeutral();
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
