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
 *  - Eye saccades: every 0.6–4.6 s pick a random focus target and hand it to
 *    the SDK's focusController (spring-damped head + eyes follow).
 *  - Mouth: driven per frame from `speaking` + `levelRef` (0..1 RMS envelope
 *    relayed from wherever the TTS actually plays). Written INSIDE a wrapped
 *    motionManager.update so the SDK layers blink/breath/physics after it and
 *    nothing later in the same frame stomps it. When speaking but no level
 *    arrives (older audio path), a pseudo-envelope keeps the mouth moving.
 *  - Expressions: `emotion` maps through the import manifest's emotion table;
 *    applied via model.expression(), decayed to neutral after EXPRESSION_HOLD.
 */
import React, { useEffect, useRef } from 'react';
import type { AvatarEmotion, AvatarManifest } from '@shared/ipc';
import { sei } from '../ipcClient';
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
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
}

/** How long an applied expression holds before decaying back to neutral. */
const EXPRESSION_HOLD_MS = 10_000;
/** Saccade interval bounds (ms). */
const SACCADE_MIN_MS = 600;
const SACCADE_MAX_MS = 4_600;
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
    coreModel: { setParameterValueById: (id: string, v: number) => void };
    focusController: { focus: (x: number, y: number, instant?: boolean) => void };
    motionManager: {
      update: (...args: unknown[]) => boolean;
      expressionManager?: { resetExpression: () => void };
    };
  };
};

export function Live2DView({
  characterId,
  speaking = false,
  levelRef,
  emotion = null,
  className,
  onStatus,
}: Live2DViewProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Live2DModelT | null>(null);
  const manifestRef = useRef<AvatarManifest | null>(null);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;
  const emotionRef = useRef<AvatarEmotion | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // ── Mount: load libs + model, wire idle + mouth, handle resize ──────────
  useEffect(() => {
    let cancelled = false;
    let app: { destroy: (removeView?: boolean, opts?: unknown) => void; renderer: { resize: (w: number, h: number) => void } } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let saccadeTimer: ReturnType<typeof setTimeout> | null = null;
    const host = hostRef.current;
    if (!host) return undefined;

    onStatusRef.current?.('loading');

    void (async () => {
      try {
        const [, PIXI, plugin, manifest, rawFiles] = await Promise.all([
          loadCubismCore(),
          import('pixi.js'),
          import('pixi-live2d-display-lipsyncpatch/cubism4'),
          sei.avatarGet(characterId),
          sei.avatarModelFiles(characterId),
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
        // through the File constructor, hence defineProperty).
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

        // Mouth writer, layered INSIDE the SDK's update so blink/breath/
        // physics still run after it in the same frame.
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
          } catch {
            /* a mid-destroy frame must never throw into the ticker */
          }
          return result;
        };

        // Layout: contain the whole model, centered.
        const fit = (): void => {
          const w = Math.max(1, host.clientWidth);
          const h = Math.max(1, host.clientHeight);
          pixiApp.renderer.resize(w, h);
          const naturalW = model.width / (model as unknown as { scale: { x: number } }).scale.x;
          const naturalH = model.height / (model as unknown as { scale: { y: number } }).scale.y;
          const s = Math.min(w / naturalW, h / naturalH);
          model.scale.set(s);
          model.anchor.set(0.5, 0.5);
          model.position.set(w / 2, h / 2);
        };
        (pixiApp.stage as unknown as { addChild: (c: unknown) => void }).addChild(model);
        fit();
        resizeObserver = new ResizeObserver(() => fit());
        resizeObserver.observe(host);

        // Idle eye saccades: eyes+head wander via the SDK's spring-damped
        // focus controller; amplitude stays modest so it reads as attention,
        // not searching.
        const saccade = (): void => {
          if (cancelled) return;
          const fx = (Math.random() * 2 - 1) * 0.55;
          const fy = (Math.random() * 1.7 - 1) * 0.4;
          try {
            model.internalModel.focusController.focus(fx, fy, false);
          } catch {
            /* focus is a nicety */
          }
          saccadeTimer = setTimeout(
            saccade,
            SACCADE_MIN_MS + Math.random() * (SACCADE_MAX_MS - SACCADE_MIN_MS),
          );
        };
        saccade();

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
      if (saccadeTimer) clearTimeout(saccadeTimer);
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

  // ── Expressions: apply on emotion change, decay to neutral ──────────────
  useEffect(() => {
    const model = modelRef.current;
    emotionRef.current = emotion;
    if (!model) return undefined;
    const name = emotion ? manifestRef.current?.emotions?.[emotion] : undefined;
    if (emotion && name) {
      void model.expression(name).catch(() => {});
      const timer = setTimeout(() => {
        // Still on this emotion after the hold → decay to neutral.
        if (emotionRef.current === emotion) {
          try {
            model.internalModel.motionManager.expressionManager?.resetExpression();
          } catch {
            /* gone */
          }
        }
      }, EXPRESSION_HOLD_MS);
      return () => clearTimeout(timer);
    }
    if (!emotion) {
      try {
        model.internalModel.motionManager.expressionManager?.resetExpression();
      } catch {
        /* gone */
      }
    }
    return undefined;
  }, [emotion]);

  return <div ref={hostRef} className={className} />;
}
