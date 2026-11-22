/**
 * Live2DView (260804) â€” renders a character's imported Live2D model with the
 * idle/talk behaviors, shared by the profile Avatar tab's preview and the
 * always-on-top overlay tile.
 *
 * Everything heavy (pixi.js + the cubism4 plugin + the proprietary Core) is
 * dynamically imported on mount, so surfaces that never show a Live2D model
 * pay nothing.
 *
 * Liveliness model (AIRI-informed, own constants â€” see
 * docs/design/avatar-v06-260804.md):
 *  - Breath/sway + blink come FREE from the Cubism SDK on a motionless model
 *    (import fills the EyeBlink group from the resolved eye ids), physics on top.
 *  - Gaze (261116, product call 261116: "head tilt jumps", "linear A to
 *    B"): motion/organic.ts GazeDriver. The eyes make quick minimum-jerk
 *    saccades between short fixations; the head follows on a critically
 *    damped spring with its own slow sway and tilt. They are written apart
 *    (ParamEyeBallX/Y for the eyes, ParamAngleX/Y/Z + ParamBodyAngleX for
 *    the head) by replacing the SDK's updateFocus, which drove all of them
 *    from one constant-speed focus point. The user's real pointer (polled by
 *    main for the overlay window only, avatar:overlay-cursor-state) is one
 *    of the things she looks at, and she follows it while it moves; where
 *    the feed never arrives her eyes simply wander. Cubism 2 models (no
 *    separate ids) get the gaze through the focusController as before.
 *  - Parameter ids (261122): the mouth, eyes, head and blink ids come from
 *    the manifest's resolved roles (shared/live2dParams.ts; resolved here
 *    from the model's own files when an older manifest has none), each
 *    scaled to the parameter's real range, so a model that names its mouth
 *    `ParamBocca` lip-syncs and one with an empty EyeBlink group blinks. A
 *    model with no eye or head parameters leans slightly toward her gaze
 *    instead.
 *  - Blink: the SDK's EyeBlink, set to a natural lid timing (65 ms close,
 *    45 ms hold, 105 ms open).
 *  - Mouth: driven per frame from `speaking` + `levelRef` (0..1 RMS envelope
 *    relayed from wherever the TTS actually plays). Written INSIDE a wrapped
 *    motionManager.update so the SDK layers blink/breath/physics after it and
 *    nothing later in the same frame stomps it. When speaking but no level
 *    arrives (older audio path), a pseudo-envelope keeps the mouth moving.
 *  - Expressions: `emotion` maps through the import manifest's emotion table
 *    (with fallback resolution for unmapped emotions); applied via
 *    model.expression(), decayed to neutral after the line's linger.
 *  - Accessories (260806): manifest.accessories toggles item expressions
 *    (hat, coat...) as per-frame absolute parameter writes â€” persistent, and
 *    independent of the single-slot expressionManager the emotions use.
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarCamera, AvatarEmotion, AvatarManifest } from '@shared/ipc';
import { sei } from '../ipcClient';
import { resolveEmotionExpression } from '../avatar/emotion';
import { BLINK_CLOSE_MS, BLINK_HOLD_MS, BLINK_OPEN_MS, GazeDriver, type GazeConfig, type GazeInput, type GazeOutput } from '../motion/organic';
import { parseExpressionParams, computeAccessoryTargets } from '../avatar/accessoryParams';
import { loadCubismCore } from './loadCore';
import { effectiveLive2DParams, LIVE2D_STANDARD_IDS, resolveLive2DParams, resolveLive2DParamsFromFiles, type Live2DRole } from '@shared/live2dParams';

export interface Live2DViewProps {
  characterId: string;
  /** True while this character is audibly speaking (drives the mouth). */
  speaking?: boolean;
  /** Latest mouth level 0..1, mutated externally at ~25 Hz. Read per frame â€”
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
  /**
   * Frame cap (261104, SeiLink): absent = the default ticker, 0 = paused (no
   * model updates, no rendering), N = render at most N a second.
   */
  fps?: number;
}

/**
 * An expression lives for 150% of its line: it holds while the line is spoken,
 * then this fraction of the line's duration longer, then decays to neutral â€”
 * unless a new line's emotion refreshes it first. A 2 s quip flashes its face
 * for ~3 s; a long story holds it long after the last word.
 */
const EXPRESSION_LINGER_FRACTION = 0.5;
/** Cursor samples older than this mean the feed is gone (main pushes at
 * ~8 Hz): back to wandering rather than staring at a frozen point. */
const CURSOR_FRESH_MS = 2_000;
/** How far she looks toward the cursor, per axis: the pushed sample is
 * [-1, 1] across the display around the window center; full deflection at
 * the screen edge reads cross-eyed, so it is scaled down. */
const CURSOR_GAIN_X = 0.75;
const CURSOR_GAIN_Y = 0.6;
/** Gaze in the overlay: the cursor is the main thing she looks at. */
const LIVE2D_GAZE: Partial<GazeConfig> = { cursorChance: 0.4 };
/** Head angles (deg) at a full head turn, and eyeball travel per unit of eye-in-head gaze. */
const HEAD_YAW_DEG = 30;
const HEAD_PITCH_DEG = 24;
const HEAD_ROLL_DEG = 9;
const BODY_YAW_DEG = 8;
const EYEBALL_GAIN = 1.6;
/** The standard parameters' half ranges the gains above are written for (angles Â±30, body Â±10, eyeballs Â±1). */
const STD_HALF_ANGLE = 30;
const STD_HALF_BODY = 10;
const STD_HALF_EYEBALL = 1;
/** A model with no eye or head parameters leans this far (deg, about her bottom) at a full head turn. */
const LEAN_DEG = 1.1;
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
  rotation: number;
  expression: (id?: number | string) => Promise<boolean>;
  internalModel: {
    coreModel: {
      setParameterValueById: (id: string, v: number) => void;
      getParameterIndex: (id: string) => number;
      getParameterCount: () => number;
      getParameterDefaultValue: (index: number) => number;
      getParameterMinimumValue: (index: number) => number;
      getParameterMaximumValue: (index: number) => number;
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
  fps,
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
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const applyFpsRef = useRef<(() => void) | null>(null);

  // â”€â”€ Mount: load libs + model, wire idle + mouth, handle resize â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    let cancelled = false;
    let app: { destroy: (removeView?: boolean, opts?: unknown) => void; renderer: { resize: (w: number, h: number) => void } } | null = null;
    let resizeObserver: ResizeObserver | null = null;
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
        // that match that sniff â€” whichever readdir happened to list first won.
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

        // â”€â”€ Accessories (260806): toggled item expressions (hat, coat...)
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

        // â”€â”€ Parameter ids (261122) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // The stored roles (main resolves them at import), else resolved here
        // from the model's own files; only ids the model really has are used.
        const core = model.internalModel.coreModel;
        const rangeOf = (id: string): { min: number; max: number; def: number } | null => {
          const idx = core.getParameterIndex(id);
          if (idx >= core.getParameterCount()) return null;
          return { min: core.getParameterMinimumValue(idx), max: core.getParameterMaximumValue(idx), def: core.getParameterDefaultValue(idx) };
        };
        const paramMap = effectiveLive2DParams(
          manifest.params ?? resolveLive2DParamsFromFiles(rawFiles, manifest.entry) ?? resolveLive2DParams({ params: null }),
          manifest.paramOverrides,
        );
        const roleId = (role: Live2DRole): string | undefined => {
          const id = paramMap.roles[role];
          return id && rangeOf(id) ? id : undefined;
        };
        /** Half the parameter's range over the standard one's: 1 for a standard parameter. */
        const rangeScale = (id: string, stdHalf: number): number => {
          const r = rangeOf(id);
          return r && r.max > r.min ? (r.max - r.min) / 2 / stdHalf : 1;
        };

        // â”€â”€ Gaze (261116) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const cursor = { x: 0, y: 0, at: 0 };
        const gazeDriver = new GazeDriver(performance.now(), LIVE2D_GAZE);
        const gazeIn: GazeInput = { cursor: null, engaged: false };
        const cursorPt = { x: 0, y: 0 };
        const im = model.internalModel as unknown as {
          updateFocus?: () => void;
          coreModel: { addParameterValueById?: (id: unknown, v: number) => void };
          eyeBlink?: { setBlinkingSetting?: (closing: number, closed: number, opening: number) => void } | null;
          breath?: { getParameters?: () => Array<{ parameterId?: unknown }> } | null;
        };
        // Gaze per frame (eyes on gaze.eye*, head on gaze.head*), read by updateFocus below.
        let gaze: GazeOutput | null = null;
        const eyeBallX = roleId('eyeBallX');
        const eyeBallY = roleId('eyeBallY');
        const angleX = roleId('angleX');
        const angleY = roleId('angleY');
        const angleZ = roleId('angleZ');
        const bodyAngleX = roleId('bodyAngleX');
        const gazeWrites: Array<[string, (g: GazeOutput) => number]> = [];
        // Live2D's y is up-positive; the driver's is down-positive.
        if (eyeBallX) {
          const k = rangeScale(eyeBallX, STD_HALF_EYEBALL);
          gazeWrites.push([eyeBallX, (g) => Math.max(-1, Math.min(1, g.eyeX * EYEBALL_GAIN)) * k]);
        }
        if (eyeBallY) {
          const k = rangeScale(eyeBallY, STD_HALF_EYEBALL);
          gazeWrites.push([eyeBallY, (g) => Math.max(-1, Math.min(1, -g.eyeY * EYEBALL_GAIN)) * k]);
        }
        if (angleX) {
          const k = rangeScale(angleX, STD_HALF_ANGLE);
          gazeWrites.push([angleX, (g) => g.headX * HEAD_YAW_DEG * k]);
        }
        if (angleY) {
          const k = rangeScale(angleY, STD_HALF_ANGLE);
          gazeWrites.push([angleY, (g) => -g.headY * HEAD_PITCH_DEG * k]);
        }
        if (angleZ) {
          const k = rangeScale(angleZ, STD_HALF_ANGLE);
          gazeWrites.push([angleZ, (g) => g.headRoll * HEAD_ROLL_DEG * k]);
        }
        if (bodyAngleX) {
          const k = rangeScale(bodyAngleX, STD_HALF_BODY);
          gazeWrites.push([bodyAngleX, (g) => g.headX * BODY_YAW_DEG * k]);
        }
        const separate = typeof im.updateFocus === 'function' && typeof im.coreModel.addParameterValueById === 'function';
        if (separate) {
          im.updateFocus = () => {
            const g = gaze;
            const add = im.coreModel.addParameterValueById;
            if (!g || !add) return;
            for (const [id, value] of gazeWrites) add.call(im.coreModel, id, value(g));
          };
        }
        // No eyes or head to move: the whole figure leans toward her gaze.
        const lean = separate && gazeWrites.length === 0;
        // The SDK's breath writes the standard ids; point it at the model's own.
        try {
          const std = new Map<string, string | undefined>([
            [LIVE2D_STANDARD_IDS.angleX, angleX],
            [LIVE2D_STANDARD_IDS.angleY, angleY],
            [LIVE2D_STANDARD_IDS.angleZ, angleZ],
            [LIVE2D_STANDARD_IDS.bodyAngleX, bodyAngleX],
            [LIVE2D_STANDARD_IDS.breath, roleId('breath')],
          ]);
          for (const b of im.breath?.getParameters?.() ?? []) {
            const to = typeof b.parameterId === 'string' ? std.get(b.parameterId) : undefined;
            if (to) b.parameterId = to;
          }
        } catch {
          /* an SDK without breath parameters */
        }
        // Blink: an EyeBlink group with no ids (or none at all) gave the model
        // no blink; the resolved eye ids get one (main also fills the group).
        try {
          const blinkIds = paramMap.blink.filter((id) => rangeOf(id));
          const EyeBlink = (plugin as unknown as { CubismEyeBlink?: { create: (s: unknown) => unknown } }).CubismEyeBlink;
          if (!im.eyeBlink && blinkIds.length > 0 && EyeBlink) {
            im.eyeBlink = EyeBlink.create({ getEyeBlinkParameters: () => blinkIds }) as typeof im.eyeBlink;
          }
        } catch {
          /* keeps the SDK's own blink, if any */
        }
        // Mouth writer + gaze pursuit, layered INSIDE the SDK's update so
        // blink/breath/physics still run after it in the same frame.
        let mouth = 0;
        /** Where fit() put her (the lean slides from here). */
        let base: { x: number; y: number } | null = null;
        // The mouth parameter and its closed/open values (closed = its rest value, else its minimum).
        const mouthId = roleId('mouthOpen');
        const mouthRange = mouthId ? rangeOf(mouthId) : null;
        const mouthClosed = mouthRange ? (mouthRange.def > mouthRange.min && mouthRange.def < mouthRange.max ? mouthRange.def : mouthRange.min) : 0;
        const mouthOpen = mouthRange ? mouthRange.max : 1;
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
            if (mouthId) core.setParameterValueById(mouthId, mouthClosed + mouth * (mouthOpen - mouthClosed));

            // Accessory toggles: absolute targets, every frame. This runs
            // inside motionManager.update, i.e. BEFORE saveParameters and
            // the SDK's expression pass, so the values persist frame to
            // frame; an emotion expression touching the same parameter
            // (none do â€” emotions drive faces, accessories drive items)
            // would win only while it plays.
            for (const [id, v] of accessoryTargets) {
              model.internalModel.coreModel.setParameterValueById(id, v);
            }

            // Gaze: advance the driver; updateFocus (or the focusController) shows it.
            const now = performance.now();
            const cursorFresh = Date.now() - cursor.at < CURSOR_FRESH_MS;
            if (cursorFresh) {
              cursorPt.x = cursor.x * CURSOR_GAIN_X;
              cursorPt.y = -cursor.y * CURSOR_GAIN_Y;
            }
            gazeIn.cursor = cursorFresh ? cursorPt : null;
            gazeIn.engaged = speakingRef.current;
            gaze = gazeDriver.update(now, gazeIn);
            if (!separate) model.internalModel.focusController.focus(gaze.gazeX, -gaze.gazeY, true);
            else if (lean && base) {
              // About her bottom edge: the anchor is the centre, so slide by half her height.
              const t = (gaze.headX * LEAN_DEG * Math.PI) / 180;
              model.rotation = t;
              model.position.set(base.x + (model.height / 2) * t, base.y);
            }
          } catch {
            /* a mid-destroy frame must never throw into the ticker */
          }
          return result;
        };

        // Layout: contain the whole model, centered â€” then the camera on top
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
          base = { x: w / 2 + (cam?.x ?? 0) * w, y: h / 2 + (cam?.y ?? 0) * h };
          model.position.set(base.x, base.y);
        };
        fitRef.current = fit;
        (pixiApp.stage as unknown as { addChild: (c: unknown) => void }).addChild(model);
        fit();
        resizeObserver = new ResizeObserver(() => fit());
        resizeObserver.observe(host);

        // Frame cap / pause (261104): 0 stops both the model's updates (it
        // rides the shared ticker) and this app's render loop.
        applyFpsRef.current = () => {
          const cap = fpsRef.current;
          try {
            const automator = (model as unknown as { automator?: { autoUpdate: boolean } }).automator;
            if (cap === 0) {
              if (automator) automator.autoUpdate = false;
              pixiApp.stop();
            } else {
              pixiApp.ticker.maxFPS = cap ?? 0;
              if (automator) automator.autoUpdate = true;
              pixiApp.start();
            }
          } catch {
            /* a mid-destroy app */
          }
        };
        if (fpsRef.current !== undefined) applyFpsRef.current();

        // The user's real pointer, in the overlay window only (see the header).
        offCursor = sei.onAvatarOverlayCursor?.((pt) => {
          cursor.x = pt.x;
          cursor.y = pt.y;
          cursor.at = Date.now();
        });

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
      applyFpsRef.current = null;
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

  useEffect(() => {
    applyFpsRef.current?.();
  }, [fps]);

  // Re-fit when the camera changes (edit-mode wheel/drag streams new values).
  useEffect(() => {
    fitRef.current?.();
  }, [camera?.zoom, camera?.x, camera?.y]);

  // â”€â”€ Expressions: apply on a line's emotion, decay at 150% of the line â”€â”€â”€â”€
  // The emotion prop is per-LINE (the pusher classifies the audibly-playing
  // line and sends null between lines), so an emotion CHANGE marks a new line
  // and `speaking` falling marks its end. Nothing resets on emotion â†’ null â€”
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
        // equal to currentExpression â€” so without this, a decayed face could
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




