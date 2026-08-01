import { describe, it, expect } from 'vitest';
import {
  baselineGain,
  colorDelta,
  COLOR_LOOKBACK_MS,
  createJoltState,
  decideJolt,
  median,
  pushGain,
  pushThumb,
  THUMB_H,
  THUMB_W,
  thumbDelta,
  warmedUp,
} from './signals';

/** A flat RGBA thumbnail of one colour, the shape getImageData returns. */
const solid = (r: number, g: number, b: number): Uint8ClampedArray => {
  const px = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
};

const BLACK = solid(0, 0, 0);
const WHITE = solid(255, 255, 255);
const TH = { gainDb: 18, colorDelta: 0.34, refractoryMs: 20_000 };

describe('thumbDelta', () => {
  it('is 0 for identical frames and 1 for full inversion', () => {
    expect(thumbDelta(BLACK, BLACK)).toBe(0);
    expect(thumbDelta(BLACK, WHITE)).toBe(1);
  });

  it('is symmetric', () => {
    const grey = solid(90, 20, 200);
    expect(thumbDelta(grey, WHITE)).toBeCloseTo(thumbDelta(WHITE, grey), 10);
  });

  it('ignores alpha', () => {
    const opaque = solid(10, 10, 10);
    const transparent = solid(10, 10, 10);
    for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
    expect(thumbDelta(opaque, transparent)).toBe(0);
  });

  it('averages over the whole frame, which is why a local change is invisible', () => {
    // Pinned deliberately, because it is the known weakness of this detector
    // and the thing scripts/backseat-sim.ts exists to measure. One block of a
    // 4x3 split going fully white moves the global mean by ~1/12, nowhere near
    // any usable threshold — so a kill feed or a hit marker cannot fire this
    // arm at ANY setting. If this ever stops being true, the detector changed.
    const oneBlock = solid(0, 0, 0);
    const blockW = THUMB_W / 4;
    const blockH = THUMB_H / 3;
    for (let y = 0; y < blockH; y++) {
      for (let x = 0; x < blockW; x++) {
        const i = (y * THUMB_W + x) * 4;
        oneBlock[i] = oneBlock[i + 1] = oneBlock[i + 2] = 255;
      }
    }
    expect(thumbDelta(BLACK, oneBlock)).toBeCloseTo(1 / 12, 2);
    expect(thumbDelta(BLACK, oneBlock)).toBeLessThan(TH.colorDelta);
  });
});

describe('median', () => {
  it('resists a single outlier, which is the point of using it', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4, 5000])).toBe(3);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('warmup', () => {
  it('refuses to fire before there is history to be measured against', () => {
    const st = createJoltState();
    // A jump from digital silence to loud, which would trivially clear the
    // threshold, at t=0 with an empty baseline.
    pushGain(st, 0, -80);
    pushGain(st, 100, 0);
    pushThumb(st, 0, BLACK);
    expect(warmedUp(st, 100)).toBe(false);
    expect(decideJolt(st, 100, WHITE, TH)).toBeNull();
  });

  it('is time-based, so a 10 Hz sim and a 60 fps app agree', () => {
    const sparse = createJoltState();
    const dense = createJoltState();
    for (let t = 0; t <= 2000; t += 100) pushGain(sparse, t, -60);
    for (let t = 0; t <= 2000; t += 16) pushGain(dense, t, -60);
    expect(warmedUp(sparse, 2000)).toBe(true);
    expect(warmedUp(dense, 2000)).toBe(warmedUp(sparse, 2000));
  });
});

describe('decideJolt', () => {
  /** A warmed-up state sitting at a steady quiet baseline. */
  const warm = (): ReturnType<typeof createJoltState> => {
    const st = createJoltState();
    for (let t = 0; t <= 3000; t += 100) {
      pushGain(st, t, -60);
      pushThumb(st, t, BLACK);
    }
    return st;
  };

  it('fires the gain arm on a jump over the trailing median', () => {
    const st = warm();
    pushGain(st, 3100, -60 + TH.gainDb);
    expect(baselineGain(st)).toBeCloseTo(-60, 5);
    expect(decideJolt(st, 3100, BLACK, TH)).toBe('gain');
  });

  it('does not fire when the whole session is loud', () => {
    // The failure mode the absolute threshold was suspected of: a game with a
    // continuously high floor never produces a jump this large, however loud
    // it gets in absolute terms.
    const st = createJoltState();
    for (let t = 0; t <= 3000; t += 100) {
      pushGain(st, t, -8);
      pushThumb(st, t, BLACK);
    }
    pushGain(st, 3100, 0);
    expect(decideJolt(st, 3100, BLACK, TH)).toBeNull();
  });

  it('fires the colour arm on a full repaint a second later', () => {
    const st = warm();
    pushGain(st, 3100, -60);
    expect(colorDelta(st, 3100, WHITE)).toBe(1);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
  });

  it('compares against a second ago, not against the previous frame', () => {
    // A slow fade to white over three seconds is not an event, and reaches the
    // threshold only once a full lookback of it has accumulated.
    const st = warm();
    let fired: string | null = null;
    for (let t = 3100; t <= 6000; t += 100) {
      const v = Math.round(((t - 3000) / 3000) * 255);
      const frame = solid(v, v, v);
      pushGain(st, t, -60);
      fired = fired ?? decideJolt(st, t, frame, TH);
      pushThumb(st, t, frame);
    }
    // It does eventually clear (0.34 of 1.0 is a third of the fade), but only
    // after COLOR_LOOKBACK_MS of change has built up, never on frame-to-frame
    // motion.
    expect(fired).toBe('color');
    expect(st.lastJoltAt).toBeGreaterThanOrEqual(3100 + COLOR_LOOKBACK_MS);
  });

  it('holds the refractory period after firing', () => {
    const st = warm();
    pushGain(st, 3100, -60);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
    pushGain(st, 3200, -60 + TH.gainDb);
    expect(decideJolt(st, 3200, WHITE, TH)).toBeNull();
    expect(decideJolt(st, 3100 + TH.refractoryMs, WHITE, TH)).toBe('gain');
  });

  it('never fires the gain arm with no audio source', () => {
    // Video-only sessions leave currentGain at the floor forever; a flat trace
    // has a flat median, so the jump is always zero.
    const st = createJoltState();
    for (let t = 0; t <= 3000; t += 100) {
      pushGain(st, t, -100);
      pushThumb(st, t, BLACK);
    }
    expect(decideJolt(st, 3100, BLACK, TH)).toBeNull();
    // The colour arm still works, which is what keeps video-only useful.
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
  });
});
