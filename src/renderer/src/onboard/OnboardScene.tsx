/**
 * OnboardScene — the animated stage behind the first-run ritual (260728).
 *
 * Layer stack (all art 1500x1000):
 *   layer1  flat sky, always present (also the backdrop of the sign-in phase)
 *   layer2  ground + haze — slides up from the bottom with the grass
 *   (Sui sits here: on the ground, behind the tufts)
 *   layer3/4/5  grass tuft variations — cycled to make the grass sway
 *
 * SCALE LOCK: the layers AND the Sui sprite live inside one fixed-aspect
 * (3:2) `.stage` element that covers the window bottom-anchored. Everything
 * scales by the same single factor, so the art's line thickness always
 * matches the sprite's — scaling them independently (e.g. object-fit: cover
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
 */
import React, { useEffect, useRef, useState } from 'react';
import styles from './onboard.module.css';

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

// Slower stride to match the slower walk slide (260729). The CSS bob cycle
// (suiBob, 520ms) is 2x this on purpose (260730): a steps(1) SNAP — down
// for the stand frame, up for the stride frame, cutting the instant the
// sprite swaps. Both clocks start on the same pose change; change one
// period and you must change the other.
const WALK_FRAME_MS = 260;
// Fast flap: at the old 240ms a short line finished typing after only two or
// three talk frames, which read as a barely-moving mouth (260729).
const TALK_FRAME_MS = 130;
const GRASS_FRAME_MS = 420;

export interface OnboardSceneProps {
  groundIn: boolean;
  sui: SuiPose;
  onGroundIn?: () => void;
  onGroundOut?: () => void;
  onSuiEntered?: () => void;
  onSuiLeft?: () => void;
}

export function OnboardScene(props: OnboardSceneProps): React.ReactElement {
  const { groundIn, sui } = props;

  // Grass sway — only while the ground is on screen.
  const [grassFrame, setGrassFrame] = useState(0);
  useEffect(() => {
    if (!groundIn) return;
    const t = setInterval(() => setGrassFrame((f) => (f + 1) % 3), GRASS_FRAME_MS);
    return () => clearInterval(t);
  }, [groundIn]);

  // Sui frame alternation per pose.
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (sui === 'entering' || sui === 'leaving') {
      const t = setInterval(() => setFlip((f) => !f), WALK_FRAME_MS);
      return () => clearInterval(t);
    }
    if (sui === 'talking') {
      // Open the mouth on the FIRST frame — waiting a full interval before
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

  // Sui lives INSIDE the ground element (behind the grass tufts), so her
  // slide's transitionend bubbles up to the ground's handler — each handler
  // must only react to its own element's transition.
  const onGroundEnd = (e: React.TransitionEvent): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (groundIn) cbs.current.onGroundIn?.();
    else cbs.current.onGroundOut?.();
  };
  const onSuiEnd = (e: React.TransitionEvent): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (sui === 'entering') cbs.current.onSuiEntered?.();
    if (sui === 'leaving') cbs.current.onSuiLeft?.();
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
    <div className={styles.scene} aria-hidden="true">
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
              she slides with it — she is always hidden/off-stage when it
              moves, so that is never visible.

              She is rendered TWICE: this behind-grass copy, and a duplicate
              after the tufts clipped to the rightmost 10% of the stage
              (.suiFrontClip), so she rises above the tall right-edge grass
              there while the rest of her stays tucked into the field. The
              copies share the exact same classes, so their transitions and
              animations run in lockstep; only this one carries the
              transitionend handler (the duplicate would fire it twice). */}
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
