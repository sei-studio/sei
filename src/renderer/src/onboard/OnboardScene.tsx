/**
 * OnboardScene â€” the animated stage behind the first-run ritual (260728).
 *
 * Layer stack (all art 1500x1000):
 *   layer1  flat sky, always present (also the backdrop of the sign-in phase)
 *   layer2  ground + haze â€” slides up from the bottom with the grass
 *   (Sui sits here: on the ground, behind the tufts â€” but see .suiFrontClip,
 *    which brings her back in front of them over two bands of the stage)
 *   layer3/4/5  grass tuft variations â€” cycled to make the grass sway
 *
 * SCALE LOCK: the layers AND the Sui sprite live inside one fixed-aspect
 * (3:2) `.stage` element that covers the window bottom-anchored. Everything
 * scales by the same single factor, so the art's line thickness always
 * matches the sprite's â€” scaling them independently (e.g. object-fit: cover
 * on the layers but %-of-window on the sprite) visibly mismatches the pen
 * weight the moment the window aspect drifts from 3:2.
 *
 * Sui is a sprite (1241x828 chibi frames) standing in the right third, on the
 * grass. Poses:
 *   entering/leaving  slide from/to off-right while alternating stand/stride
 *                     (the walk), transitionend fires onSuiEntered/onSuiLeft;
 *                     leaving mirrors the frames (scaleX(-1)) so she turns
 *                     around and walks out instead of sliding backwards
 *   idle              stand
 *   talking           alternate stand/talk (mouth flap while text types)
 *   shock             the sui-shock frame, with a small jitter
 *
 * Every frame <img> stays mounted and is toggled with opacity, so pose swaps
 * never wait on decode. The ground transition fires onGroundIn/onGroundOut.
 *
 * Every one of those four callbacks ALWAYS fires, exactly once per change
 * (261012): each stage is a TransitionGate (sceneGate.ts) that completes on
 * transitionend, on a watchdog a little past the CSS duration, or at once
 * when `instant` is set (a skip, or reduced motion). It used to wait on
 * transitionend alone, and a dropped transition left first launches stuck
 * on an empty sky.
 */
import React, { useEffect, useRef, useState } from 'react';
import styles from './onboard.module.css';
import { armTransitionGate, type AdvanceSource, type TransitionGate } from './sceneGate';

export type SuiPose = 'hidden' | 'entering' | 'idle' | 'talking' | 'shock' | 'leaving';

const LAYERS = {
  sky: './img/onboard/layer1.png',
  ground: './img/onboard/layer2.png',
  grass: ['./img/onboard/layer3.png', './img/onboard/layer4.png', './img/onboard/layer5.png'],
};
const SUI = {
  stand: './img/onboard/sui-stand.png',
  stride: './img/onboard/sui-stride.png',
  talk: './img/onboard/sui-talk.png',
  shock: './img/onboard/sui-shock.png',
};
// Grass footsteps (260730): Kenney "Impact Sounds", CC0 â€” see
// public/sfx/README.md. Two samples alternated so consecutive steps never
// sound identical; one plays on every stride frame swap.
const FOOTSTEPS = ['./sfx/footstep-grass-0.ogg', './sfx/footstep-grass-1.ogg'];

// Slower stride to match the slower walk slide (260729). The CSS bob cycle
// (suiBob, 520ms) is 2x this on purpose (260730): a steps(1) SNAP â€” down
// for the stand frame, up for the stride frame, cutting the instant the
// sprite swaps. Both clocks start on the same pose change; change one
// period and you must change the other.
const WALK_FRAME_MS = 260;
// Fast flap: at the old 240ms a short line finished typing after only two or
// three talk frames, which read as a barely-moving mouth (260729).
const TALK_FRAME_MS = 130;
const GRASS_FRAME_MS = 420;
// The CSS transition durations of .ground and .sui (onboard.module.css). The
// watchdogs are sized from these; sceneGate.test.ts checks they match.
export const GROUND_TRANSITION_MS = 2400;
export const SUI_WALK_TRANSITION_MS = 2600;

/** Why the scene should skip its slides: the player skipped the intro, or the
 * OS asks for reduced motion. null = animate normally. */
export type SceneInstant = Exclude<AdvanceSource, 'transition' | 'watchdog'> | null;

export interface OnboardSceneProps {
  groundIn: boolean;
  sui: SuiPose;
  /** Footstep volume, 0..1 (0/undefined = silent). The parent scales its
   * voice volume down so the steps stay quiet under Sui's lines. */
  sfxVolume?: number;
  /** Set: no slides; every stage completes at once with this source. */
  instant?: SceneInstant;
  onGroundIn?: (by: AdvanceSource) => void;
  onGroundOut?: (by: AdvanceSource) => void;
  onSuiEntered?: (by: AdvanceSource) => void;
  onSuiLeft?: (by: AdvanceSource) => void;
}

export function OnboardScene(props: OnboardSceneProps): React.ReactElement {
  const { groundIn, sui } = props;

  // Grass sway â€” only while the ground is on screen.
  const [grassFrame, setGrassFrame] = useState(0);
  useEffect(() => {
    if (!groundIn) return;
    const t = setInterval(() => setGrassFrame((f) => (f + 1) % 3), GRASS_FRAME_MS);
    return () => clearInterval(t);
  }, [groundIn]);

  // Footsteps ride the SAME tick as the frame swap so they can never drift
  // from the legs. Volume through a ref: the interval callback always reads
  // the live value without re-arming (and re-phasing) the walk clock.
  const sfxVolRef = useRef(props.sfxVolume ?? 0);
  sfxVolRef.current = props.sfxVolume ?? 0;
  const stepAudioRef = useRef<HTMLAudioElement[] | null>(null);
  const stepIdxRef = useRef(0);
  const playFootstep = (): void => {
    const vol = sfxVolRef.current;
    if (vol <= 0) return;
    if (!stepAudioRef.current) stepAudioRef.current = FOOTSTEPS.map((src) => new Audio(src));
    const a = stepAudioRef.current[stepIdxRef.current];
    stepIdxRef.current = (stepIdxRef.current + 1) % stepAudioRef.current.length;
    a.volume = Math.min(1, vol);
    a.currentTime = 0;
    void a.play().catch(() => {
      /* decode/autoplay hiccup: a silent step, not worth surfacing */
    });
  };

  // Sui frame alternation per pose.
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (sui === 'entering' || sui === 'leaving') {
      const t = setInterval(() => {
        setFlip((f) => !f);
        playFootstep();
      }, WALK_FRAME_MS);
      return () => clearInterval(t);
    }
    if (sui === 'talking') {
      // Open the mouth on the FIRST frame â€” waiting a full interval before
      // the first flap made short lines look mimed.
      setFlip(true);
      const t = setInterval(() => setFlip((f) => !f), TALK_FRAME_MS);
      return () => clearInterval(t);
    }
    setFlip(false);
    return undefined;
  }, [sui]);

  const frame: keyof typeof SUI =
    sui === 'shock'
      ? 'shock'
      : sui === 'entering' || sui === 'leaving'
        ? flip
          ? 'stride'
          : 'stand'
        : sui === 'talking' && flip
          ? 'talk'
          : 'stand';

  // Latch the callbacks through refs so the transitionend handlers never
  // re-attach mid-flight.
  const cbs = useRef(props);
  cbs.current = props;

  // â”€â”€ Stage gates (261012) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // One gate per CHANGE of groundIn (mount is not a change: nothing slides),
  // and one per entering/leaving pose. A newer change cancels the older gate,
  // so a superseded stage never fires its callback.
  const groundGate = useRef<TransitionGate | null>(null);
  const prevGroundIn = useRef(groundIn);
  useEffect(() => {
    if (prevGroundIn.current === groundIn) return undefined;
    prevGroundIn.current = groundIn;
    const into = groundIn;
    const gate = armTransitionGate({
      expectedMs: GROUND_TRANSITION_MS,
      instant: cbs.current.instant,
      onAdvance: (by) => (into ? cbs.current.onGroundIn?.(by) : cbs.current.onGroundOut?.(by)),
    });
    groundGate.current = gate;
    return () => {
      gate.cancel();
      if (groundGate.current === gate) groundGate.current = null;
    };
  }, [groundIn]);

  const suiGate = useRef<TransitionGate | null>(null);
  useEffect(() => {
    if (sui !== 'entering' && sui !== 'leaving') return undefined;
    const pose = sui;
    const gate = armTransitionGate({
      expectedMs: SUI_WALK_TRANSITION_MS,
      instant: cbs.current.instant,
      onAdvance: (by) =>
        pose === 'entering' ? cbs.current.onSuiEntered?.(by) : cbs.current.onSuiLeft?.(by),
    });
    suiGate.current = gate;
    return () => {
      gate.cancel();
      if (suiGate.current === gate) suiGate.current = null;
    };
  }, [sui]);

  // A skip (or reduced motion switching on) mid-stage completes it now.
  const instant = props.instant ?? null;
  useEffect(() => {
    if (!instant) return;
    groundGate.current?.skip(instant);
    suiGate.current?.skip(instant);
  }, [instant]);

  // Sui lives INSIDE the ground element (behind the grass tufts), so her
  // slide's transitionend bubbles up to the ground's handler â€” each handler
  // must only react to its own element's transition.
  const onGroundEnd = (e: React.TransitionEvent): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    groundGate.current?.transitionEnded();
  };
  const onSuiEnd = (e: React.TransitionEvent): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    suiGate.current?.transitionEnded();
  };

  const suiClass =
    sui === 'hidden'
      ? styles.suiOff
      : sui === 'leaving'
        ? styles.suiOff
        : styles.suiOn;

  const renderSui = (withHandler: boolean): React.ReactElement => (
    <div
      className={`${styles.sui} ${suiClass} ${sui === 'shock' ? styles.suiShake : ''} ${
        sui === 'leaving' ? styles.suiFlipped : ''
      }`}
      onTransitionEnd={withHandler ? onSuiEnd : undefined}
    >
      <div
        className={`${styles.suiInner} ${
          sui === 'entering' || sui === 'leaving' ? styles.suiWalking : ''
        }`}
      >
        {(Object.keys(SUI) as Array<keyof typeof SUI>).map((k) => (
          <img
            key={k}
            className={styles.suiImg}
            style={{ opacity: frame === k ? 1 : 0 }}
            src={SUI[k]}
            alt=""
            draggable={false}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className={instant ? `${styles.scene} ${styles.sceneInstant}` : styles.scene} aria-hidden="true">
      <div className={styles.stage}>
        <img className={styles.sky} src={LAYERS.sky} alt="" draggable={false} />
        <div
          className={`${styles.ground} ${groundIn ? styles.groundIn : styles.groundOut}`}
          onTransitionEnd={onGroundEnd}
        >
          <img className={styles.layerImg} src={LAYERS.ground} alt="" draggable={false} />
          {/* Sui stands ON the ground art but BEHIND the grass tufts, so the
              tufts overlap her feet and she reads as in the field rather than
              pasted on top of it. Riding inside the ground element also means
              she slides with it â€” she is always hidden/off-stage when it
              moves, so that is never visible.

              She is rendered TWICE: this behind-grass copy, and a duplicate
              after the tufts, masked to the two stage bands where she belongs
              in front of it (.suiFrontClip owns the band geometry). The copies
              share the exact same classes, so their transitions and animations
              run in lockstep; only this one carries the transitionend handler
              (the duplicate would fire it twice). */}
          {renderSui(true)}
          {LAYERS.grass.map((src, i) => (
            <img
              key={src}
              className={styles.layerImg}
              style={{ opacity: grassFrame === i ? 1 : 0 }}
              src={src}
              alt=""
              draggable={false}
            />
          ))}
          <div className={styles.suiFrontClip}>{renderSui(false)}</div>
        </div>
      </div>
    </div>
  );
}




