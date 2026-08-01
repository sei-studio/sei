/**
 * CallScene — renders a `CallScene` descriptor: a painted stage a character
 * walks into and talks on, used as the voice call's backdrop.
 *
 * This is the generic renderer. It knows nothing about Sui, grass, or which
 * character is on the call; everything it draws comes from the descriptor
 * (`shared/callScene.ts`, resolved by `lib/callScenes.ts`). The onboarding
 * scene is the prototype it generalizes — see `onboard/OnboardScene.tsx` for
 * the original, which stays as-is because it choreographs dialogue this one
 * has no concept of.
 *
 * SCALE LOCK (inherited from the onboarding scene, and load-bearing): the
 * backdrop layers AND the character sprite live inside one fixed-aspect
 * `.stage` that covers the window, bottom-anchored. Everything scales by the
 * same factor, so hand-drawn art always matches its own character's line
 * weight. Scaling the sprite as a fraction of the WINDOW instead would drift
 * the moment the window aspect leaves the art's.
 *
 * Frames are cross-toggled by opacity with every image mounted at once, never
 * swapped in `src` — a pose change must not wait on a decode.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { CallScene as CallSceneData, ScenePaint } from '@shared/callScene';
import {
  actorBoxStyle,
  actorMirrored,
  entranceEasingCss,
  frontSwitchDelayMs,
  offstageTranslatePct,
  restIsPastFront,
} from '../../lib/callScenes';
import styles from './CallScene.module.css';

/**
 * Where the character is in the scene's little life cycle.
 *
 * `offstage` holds her off the edge while the call connects — the backdrop is
 * up immediately, she is not. `entering` runs the walk exactly once.
 */
export type CallScenePhase = 'offstage' | 'entering' | 'idle' | 'talking';

export interface CallSceneProps {
  scene: CallSceneData;
  phase: CallScenePhase;
  /** Footstep volume, 0..1. 0 or undefined = silent (deafened, or no walk). */
  sfxVolume?: number;
  /**
   * Fires once when the walk-in finishes. The call holds the character's first
   * line until this lands, so it must ALWAYS fire: a timer backs up the
   * `transitionend` in case the transition is dropped (or the scene mounts
   * already `entering`, where there is no property change to transition).
   */
  onEntered?: () => void;
}

/**
 * Cycle 0..count-1 on a timer. A single frame or no interval never ticks.
 *
 * `onTick` rides the SAME interval as the frame advance rather than a parallel
 * one, so a footstep can never drift away from the leg that is supposed to be
 * making it. It is read through a ref: changing the volume must not re-arm the
 * timer, which would re-phase the walk.
 */
function useCycle(
  count: number,
  frameMs: number | undefined,
  restartKey: string,
  onTick?: () => void,
): number {
  const [i, setI] = useState(0);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  useEffect(() => {
    setI(0);
    if (count < 2 || !frameMs) return undefined;
    const t = window.setInterval(() => {
      setI((n) => (n + 1) % count);
      tickRef.current?.();
    }, frameMs);
    return () => window.clearInterval(t);
  }, [count, frameMs, restartKey]);
  return i;
}

/** One backdrop layer: a still, a cycled loop, or a video. */
function BackdropLayer({ paint }: { paint: ScenePaint }): React.ReactElement {
  const images = paint.kind === 'images' ? paint.images : [];
  const frame = useCycle(images.length, paint.kind === 'images' ? paint.frameMs : undefined, 'layer');

  if (paint.kind === 'video') {
    return <video className={styles.layer} src={paint.src} autoPlay loop muted playsInline />;
  }
  return (
    <>
      {images.map((src, i) => (
        <img
          key={src}
          className={styles.layer}
          // Hard 1/0 swap. A crossfade puts both frames at partial alpha
          // mid-swap, which reads as flicker rather than motion (260729).
          style={{ opacity: frame === i ? 1 : 0 }}
          src={src}
          alt=""
          draggable={false}
        />
      ))}
    </>
  );
}

export function CallScene({
  scene,
  phase,
  sfxVolume,
  onEntered,
}: CallSceneProps): React.ReactElement {
  const { actor } = scene;

  // Which pose is showing. A scene without a `walk`/`talk` paint degrades to
  // idle rather than erroring — the eventual customization UI will let people
  // supply a single image and nothing else.
  const pose: 'walk' | 'talk' | 'idle' =
    phase === 'entering' && actor.walk ? 'walk' : phase === 'talking' && actor.talk ? 'talk' : 'idle';
  const posePaint = (pose === 'walk' ? actor.walk : pose === 'talk' ? actor.talk : actor.idle) ?? actor.idle;
  const poseImages = posePaint.kind === 'images' ? posePaint.images : [];
  const poseFrameMs = posePaint.kind === 'images' ? posePaint.frameMs : undefined;
  // Footsteps: volume through a ref so changing it never re-arms the walk.
  const volRef = useRef(sfxVolume ?? 0);
  volRef.current = sfxVolume ?? 0;
  const stepAudioRef = useRef<HTMLAudioElement[] | null>(null);
  const stepIdxRef = useRef(0);
  const playFootstep = (): void => {
    const steps = scene.footsteps;
    const vol = volRef.current;
    if (pose !== 'walk' || vol <= 0 || !steps || steps.length === 0) return;
    if (!stepAudioRef.current) stepAudioRef.current = steps.map((src) => new Audio(src));
    const a = stepAudioRef.current[stepIdxRef.current];
    stepIdxRef.current = (stepIdxRef.current + 1) % stepAudioRef.current.length;
    a.volume = Math.min(1, vol);
    a.currentTime = 0;
    void a.play().catch(() => {
      /* decode/autoplay hiccup: one silent step, not worth surfacing */
    });
  };

  const frame = useCycle(poseImages.length, poseFrameMs, pose, playFootstep);
  const activeSrc = poseImages.length > 0 ? poseImages[frame % poseImages.length] : null;

  // Every image the actor can ever show, mounted once and toggled. Deduped
  // because poses share frames (a walk cycle is usually stand + stride).
  const allImages = Array.from(
    new Set(
      [actor.idle, actor.talk, actor.walk]
        .filter((p): p is ScenePaint => p !== undefined)
        .flatMap((p) => (p.kind === 'images' ? p.images : [])),
    ),
  );

  // ── Arrival ──────────────────────────────────────────────────────────────
  // onEntered gates the character's first spoken line, so a dropped
  // transitionend would leave the call permanently silent. The timer is the
  // backstop, and `firedRef` keeps whichever wins from double-firing.
  const enteredCb = useRef(onEntered);
  enteredCb.current = onEntered;
  const firedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'entering') {
      firedRef.current = false;
      return undefined;
    }
    const t = window.setTimeout(() => {
      if (firedRef.current) return;
      firedRef.current = true;
      enteredCb.current?.();
    }, actor.entrance.durationMs + 300);
    return () => window.clearTimeout(t);
  }, [phase, actor.entrance.durationMs]);

  const onActorTransitionEnd = (e: React.TransitionEvent): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (phase !== 'entering' || firedRef.current) return;
    firedRef.current = true;
    enteredCb.current?.();
  };

  // ── Stepping in front of the foreground ──────────────────────────────────
  // She walks in from behind the front layers and passes them partway across
  // (`entrance.frontAfter`). The switch is a z-index flip on the one actor
  // element, timed from the descriptor + the walk easing rather than measured
  // per frame: no second sprite, no layout read on every frame of the walk.
  const switchDelay = frontSwitchDelayMs(actor);
  const [inFront, setInFront] = useState(false);
  useEffect(() => {
    if (phase === 'offstage') {
      setInFront(false);
      return undefined;
    }
    if (switchDelay == null) return undefined;
    if (phase !== 'entering') {
      // Mounted already live (the entrance was skipped): she is wherever she
      // rests, so no timer — just the answer.
      setInFront(restIsPastFront(actor));
      return undefined;
    }
    const t = window.setTimeout(() => setInFront(true), switchDelay);
    return () => window.clearTimeout(t);
  }, [phase, switchDelay, actor]);

  const box = actorBoxStyle(actor);
  const offstage = phase === 'offstage';
  const mirrored = actorMirrored(actor);
  // Bob period is exactly two walk frames and snaps (steps(1)) in the same
  // instant the sprite swaps, so the bounce reads as drawn, not tweened.
  const bob = actor.entrance.bob ?? 0;

  return (
    <div className={styles.root} style={{ background: scene.backdropColor }} aria-hidden="true">
      <div
        className={styles.stage}
        style={{
          aspectRatio: `${scene.stageAspect}`,
          width: `max(100vw, ${scene.stageAspect * 100}vh)`,
        }}
      >
        {scene.back.map((layer, i) => (
          <BackdropLayer key={`back-${i}`} paint={layer.paint} />
        ))}

        <div
          className={styles.actor}
          style={{
            ...box,
            aspectRatio: `${actor.aspect}`,
            transform: `translateX(${offstage ? offstageTranslatePct(actor) : 0}%)`,
            transitionDuration: `${actor.entrance.durationMs}ms`,
            transitionTimingFunction: entranceEasingCss(),
            // Both are positioned siblings, so DOM order puts the front layers
            // above her; any positive z-index lifts her over them.
            zIndex: inFront ? 1 : undefined,
          }}
          onTransitionEnd={onActorTransitionEnd}
        >
          {/* The bob lives on an INNER wrapper: the outer element's transform
              is the walk slide and the image's is the facing flip, so all
              three transforms need their own element. */}
          <div
            className={pose === 'walk' && bob > 0 ? styles.actorBobbing : undefined}
            style={
              pose === 'walk' && bob > 0
                ? ({
                    animationDuration: `${(poseFrameMs ?? 260) * 2}ms`,
                    '--bob': `${-bob * 100}%`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            {actor.idle.kind === 'video' ? (
              <video className={styles.actorImg} src={actor.idle.src} autoPlay loop muted playsInline />
            ) : (
              allImages.map((src) => (
                <img
                  key={src}
                  className={styles.actorImg}
                  style={{
                    opacity: src === activeSrc ? 1 : 0,
                    transform: mirrored ? 'scaleX(-1)' : undefined,
                  }}
                  src={src}
                  alt=""
                  draggable={false}
                />
              ))
            )}
          </div>
        </div>

        {scene.front.map((layer, i) => (
          <BackdropLayer key={`front-${i}`} paint={layer.paint} />
        ))}
      </div>
    </div>
  );
}
