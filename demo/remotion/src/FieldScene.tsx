import React from 'react';
import { Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { GRASS_FRAME_MS, SKY, WALK_FRAME_MS } from './theme';

/**
 * The onboarding grass field, ported from OnboardScene.tsx / onboard.module.css:
 *  - stage is a fixed 3:2 canvas covering the window, bottom-anchored (scale lock)
 *  - ground (layer2 + Sui + grass tufts) slides up/down 103% over 2400ms,
 *    cubic-bezier(0.45, 0.05, 0.3, 0.95) — the "camera tilt" illusion
 *  - Sui walks in from off-right over 2600ms, cubic-bezier(0.3, 0, 0.35, 1),
 *    alternating stand/stride every 260ms with a steps(1) bob snap
 *  - grass tufts (layers 3/4/5) cycle every 420ms, hard cuts
 *  - Sui renders twice: behind the tufts, and a front copy masked to the two
 *    stage bands where she reads as in front of the field
 */
const groundEase = Easing.bezier(0.45, 0.05, 0.3, 0.95);
const walkEase = Easing.bezier(0.3, 0, 0.35, 1);

export interface FieldTiming {
  groundInAt?: number; // frame the ground starts sliding up (intro)
  suiInAt?: number; // frame Sui starts walking in (intro)
  groundOutAt?: number; // frame the ground starts sliding down (outro)
}

const GROUND_MS = 2400;
const WALK_MS = 2600;

export const FieldScene: React.FC<FieldTiming> = ({ groundInAt, suiInAt, groundOutAt }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const ms = (frame * 1000) / fps;

  // Stage geometry: width max(100vw, 150vh), 3:2 aspect, bottom-anchored.
  const stageW = Math.max(width, 1.5 * height);
  const stageH = (stageW * 2) / 3;

  // Ground position.
  let groundY = 103;
  if (groundInAt !== undefined) {
    const t = interpolate(ms, [groundInAt * (1000 / fps), groundInAt * (1000 / fps) + GROUND_MS], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: groundEase,
    });
    groundY = 103 * (1 - t);
  }
  if (groundOutAt !== undefined) {
    const t = interpolate(ms, [groundOutAt * (1000 / fps), groundOutAt * (1000 / fps) + GROUND_MS], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: groundEase,
    });
    groundY = 103 * t;
  }

  // Grass sway — starts cycling with the scene clock, hard cuts, no crossfade.
  const grassFrame = Math.floor(ms / GRASS_FRAME_MS) % 3;

  // Sui slide + walk cycle.
  let suiX = 140; // % of her own width, off-right
  let walking = false;
  if (groundOutAt !== undefined) suiX = 0; // outro: she is already standing
  if (suiInAt !== undefined) {
    const start = suiInAt * (1000 / fps);
    const t = interpolate(ms, [start, start + WALK_MS], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: walkEase,
    });
    suiX = 140 * (1 - t);
    walking = ms >= start && ms <= start + WALK_MS;
  }
  const stride = walking && Math.floor(ms / WALK_FRAME_MS) % 2 === 1;
  const bobY = stride ? -2 : 0; // steps(1) snap, drawn not tweened

  const suiFrame = stride ? 'sui-stride' : 'sui-stand';

  const sui = (
    <div
      style={{
        position: 'absolute',
        right: '-10%',
        bottom: '7%',
        width: '66%',
        aspectRatio: '1241 / 828',
        transform: `translateX(${suiX}%)`,
      }}
    >
      <img
        src={staticFile(`img/onboard/${suiFrame}.png`)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform: `translateY(${bobY}%)`,
        }}
      />
    </div>
  );

  const layer: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'fill',
  };

  return (
    <div style={{ position: 'absolute', inset: 0, background: SKY, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 0,
          transform: 'translateX(-50%)',
          width: stageW,
          height: stageH,
        }}
      >
        <img src={staticFile('img/onboard/layer1.png')} style={layer} />
        <div style={{ position: 'absolute', inset: 0, transform: `translateY(${groundY}%)` }}>
          <img src={staticFile('img/onboard/layer2.png')} style={layer} />
          {sui}
          <img src={staticFile(`img/onboard/layer${3 + grassFrame}.png`)} style={layer} />
          {/* Front copy, masked to the bands where she stands in front of the field. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              WebkitMaskImage:
                'linear-gradient(to right, #000 0 70%, transparent 70% 90%, #000 90% 100%)',
              maskImage:
                'linear-gradient(to right, #000 0 70%, transparent 70% 90%, #000 90% 100%)',
            }}
          >
            {sui}
          </div>
        </div>
      </div>
    </div>
  );
};
