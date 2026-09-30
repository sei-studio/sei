import React from 'react';
import { Composition, Sequence } from 'remotion';
import { ensureFonts } from './fonts';
import { FieldScene } from './FieldScene';
import { GamesShowcase, SHOWCASE_LEN } from './GamesShowcase';
import { UiDemo, UI_DEMO_LEN } from './UiDemo';
import './style.css';

/**
 * SeiPromo timeline (30fps, 1920x1080):
 *   1. Field intro   — plain sky 2s, ground slides up, Sui walks in   (240)
 *   2. UI demo       — home wall → chat ("wanna game?") → call → share (332)
 *      [user cuts to their screenshare clip here]
 *   3. Games         — picker opens, tiles take over one by one        (196)
 *      [user cuts to their gaming compilation here]
 *   4. Field outro   — Sui on the grass, camera tilts up to plain sky  (170)
 */
const INTRO_LEN = 240;
const OUTRO_LEN = 170;

const Promo: React.FC = () => {
  ensureFonts();
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000' }}>
      <Sequence durationInFrames={INTRO_LEN}>
        {/* sky 2s → ground in at 60 (2.4s slide) → Sui walks in at 145 */}
        <FieldScene groundInAt={60} suiInAt={145} />
      </Sequence>
      <Sequence from={INTRO_LEN} durationInFrames={UI_DEMO_LEN}>
        <UiDemo />
      </Sequence>
      <Sequence from={INTRO_LEN + UI_DEMO_LEN} durationInFrames={SHOWCASE_LEN}>
        <GamesShowcase />
      </Sequence>
      <Sequence from={INTRO_LEN + UI_DEMO_LEN + SHOWCASE_LEN} durationInFrames={OUTRO_LEN}>
        {/* Sui already standing; ground tilts away at 45, plain sky holds */}
        <FieldScene groundInAt={-100} groundOutAt={45} />
      </Sequence>
    </div>
  );
};

export const Root: React.FC = () => (
  <Composition
    id="SeiPromo"
    component={Promo}
    durationInFrames={INTRO_LEN + UI_DEMO_LEN + SHOWCASE_LEN + OUTRO_LEN}
    fps={30}
    width={1920}
    height={1080}
  />
);
