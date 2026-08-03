import { describe, it, expect } from 'vitest';
import {
  baselineGain,
  blockMaxDelta,
  colorDelta,
  colorThreshold,
  COLOR_LOOKBACKS_MS,
  COLOR_REFRACTORY_MS,
  createJoltState,
  decideJolt,
  mad,
  median,
  pushColor,
  pushGain,
  pushThumb,
  thumbAt,
  THUMB_H,
  THUMB_W,
  thumbDelta,
  warmedUp,
} from './signals';
import {
  JOLT_COLOR_FLOOR,
  JOLT_COLOR_MAD,
  JOLT_GAIN_DB,
  JOLT_REFRACTORY_MS,
} from '../../../../shared/backseatIpc';

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
/**
 * The SHIPPED thresholds, imported rather than restated. These used to be
 * copied literals and drifted from the constants they were meant to stand for;
 * importing them means a test that passes is a statement about what the app
 * does. colorRefractoryMs is left off on purpose so the default path through
 * decideJolt is the one under test.
 */
const TH = {
  gainDb: JOLT_GAIN_DB,
  colorMad: JOLT_COLOR_MAD,
  colorFloor: JOLT_COLOR_FLOOR,
  refractoryMs: JOLT_REFRACTORY_MS,
};

/** BLACK with the top-left block of a 4x3 split turned white: a localised
 *  change, the case the colour arm used to be blind to. */
const oneBlockWhite = (): Uint8ClampedArray => {
  const px = solid(0, 0, 0);
  for (let y = 0; y < THUMB_H / 3; y++) {
    for (let x = 0; x < THUMB_W / 4; x++) {
      const i = (y * THUMB_W + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
    }
  }
  return px;
};

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

  it('averages a local change away, which is why the arm does not use it', () => {
    // The measured weakness that motivated block-max (260802). One block of a
    // 4x3 split going fully white moves the global MEAN by 1/12, far below any
    // usable threshold, so a kill feed or a hit marker could not fire this arm
    // at any setting. Kept as a pin: if it ever stops being true, thumbDelta
    // changed underneath the thing that replaced it.
    expect(thumbDelta(BLACK, oneBlockWhite())).toBeCloseTo(1 / 12, 2);
  });
});

describe('blockMaxDelta', () => {
  it('sees the local change the mean erases', () => {
    // Same pixels, same pair of frames, 12x the reading: this one line is the
    // whole reason the colour arm only ever fired on scene cuts.
    expect(blockMaxDelta(BLACK, oneBlockWhite())).toBeCloseTo(1, 5);
    expect(thumbDelta(BLACK, oneBlockWhite())).toBeLessThan(0.1);
  });

  it('agrees with the mean when the change is uniform', () => {
    expect(blockMaxDelta(BLACK, BLACK)).toBe(0);
    expect(blockMaxDelta(BLACK, WHITE)).toBe(1);
  });

  it('covers every pixel despite 32x18 not dividing evenly by 4x3', () => {
    // 32/4 is exact but 18/3 = 6 is too, so this pins the remainder handling
    // against a future thumbnail size: a change in the LAST row and column has
    // to be visible.
    const corner = solid(0, 0, 0);
    const i = ((THUMB_H - 1) * THUMB_W + (THUMB_W - 1)) * 4;
    corner[i] = corner[i + 1] = corner[i + 2] = 255;
    expect(blockMaxDelta(BLACK, corner)).toBeGreaterThan(0);
  });
});

describe('thumbAt', () => {
  it('returns null until the trace actually spans the target age', () => {
    const st = createJoltState();
    pushThumb(st, 0, BLACK);
    pushThumb(st, 500, BLACK);
    // Half a second of history cannot answer a question about a second ago,
    // and the old lookup answered it anyway with whatever it had.
    expect(thumbAt(st, 500, 1000)).toBeNull();
  });

  it('picks the NEAREST sample to the target, not the oldest one held', () => {
    const st = createJoltState();
    const marked = solid(1, 2, 3);
    for (let t = 0; t <= 3000; t += 100) pushThumb(st, t, t === 2000 ? marked : BLACK);
    // 3000 - 1000 = 2000, exactly the marked frame. The pre-260802 lookup took
    // the first entry at least a second old, which in a pruned trace is always
    // the oldest one retained.
    expect(thumbAt(st, 3000, 1000)).toBe(marked);
  });
});

describe('mad', () => {
  it('is not moved by the outlier it exists to detect', () => {
    const flat = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(mad(flat)).toBe(0);
    expect(mad([...flat.slice(0, 8), 1000])).toBe(0);
  });
});

describe('colorThreshold', () => {
  it('falls back to the floor before there is a baseline', () => {
    const st = createJoltState();
    expect(colorThreshold(st, TH)).toBe(TH.colorFloor);
  });

  it('rises with a screen that moves a lot, which is the whole point', () => {
    const calm = createJoltState();
    const frantic = createJoltState();
    for (let t = 0; t < 2000; t += 100) {
      pushColor(calm, t, 0.02 + (t % 300) / 30000);
      pushColor(frantic, t, 0.30 + (t % 300) / 3000);
    }
    // A fixed number cannot be right for both of these, which is what the
    // Valorant measurement showed: at a fixed 0.34 the frantic screen was over
    // threshold 38% of the time while a calm one would never fire at all.
    expect(colorThreshold(calm, TH)).toBe(TH.colorFloor);
    expect(colorThreshold(frantic, TH)).toBeGreaterThan(0.4);
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
    for (let t = 0; t <= 3500; t += 100) pushGain(sparse, t, -60);
    for (let t = 0; t <= 3500; t += 16) pushGain(dense, t, -60);
    expect(warmedUp(sparse, 3500)).toBe(true);
    expect(warmedUp(dense, 3500)).toBe(warmedUp(sparse, 3500));
    // 200 samples versus 35 covering the same span, and the answer is the same.
    expect(warmedUp(sparse, 2000)).toBe(false);
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

  it('accumulates a gradual change rather than reacting frame to frame', () => {
    // A slow fade to white over three seconds. Each 100 ms step moves the
    // picture by 3.3%, so a frame-to-frame detector would need a threshold of
    // 0.033 to see it at all; this one waits until enough of the fade has built
    // up across a lookback.
    const st = warm();
    let fired: string | null = null;
    for (let t = 3100; t <= 6000; t += 100) {
      const v = Math.round(((t - 3000) / 3000) * 255);
      const frame = solid(v, v, v);
      pushGain(st, t, -60);
      fired = fired ?? decideJolt(st, t, frame, TH);
      pushThumb(st, t, frame);
    }
    expect(fired).toBe('color');
    // Several steps of accumulation, not the first one.
    expect(st.lastColorAt).toBeGreaterThan(3100 + 300);
  });

  it('holds a refractory period PER ARM, so neither silences the other', () => {
    const st = warm();
    pushGain(st, 3100, -60);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
    // The same arm is held...
    expect(decideJolt(st, 3200, WHITE, TH)).toBeNull();
    // ...while the other is free immediately. This is the case that mattered on
    // real footage: a colour jolt at 01:41 used to swallow the +18.9 dB gain
    // spike at 01:55, the clearest real event in the clip.
    pushGain(st, 3200, -60 + TH.gainDb);
    expect(decideJolt(st, 3200, BLACK, TH)).toBe('gain');
    expect(decideJolt(st, 3300, BLACK, TH)).toBeNull();
    expect(decideJolt(st, 3100 + COLOR_REFRACTORY_MS, WHITE, TH)).toBe('color');
  });

  it('frees the colour arm on ITS period, well before the gain arm is free', () => {
    // 260803. The two arms used to share one period, and a run of scene changes
    // is exactly what that could not represent: on a screen recording of six
    // Reels swipes the gaps were 14, 6, 16, 3 and 11 s, every one of them under
    // the 20 s both arms held, so the clock decided which swipes were noticed
    // rather than the picture did (2 of 6 fired; at 6 s with the lower floor,
    // 5 of 6).
    const st = warm();
    pushGain(st, 3100, -60);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
    // The white screen settles in and becomes the new normal.
    for (let t = 3100; t <= 3100 + COLOR_REFRACTORY_MS; t += 100) {
      pushGain(st, t, -60);
      pushThumb(st, t, WHITE);
    }
    expect(COLOR_REFRACTORY_MS).toBeLessThan(TH.refractoryMs);
    // A second, different scene one tick short of the colour period: held.
    expect(decideJolt(st, 3100 + COLOR_REFRACTORY_MS - 100, BLACK, TH)).toBeNull();
    // At the period it is a second wake, even though the GAIN arm would still
    // be silent this far in.
    expect(decideJolt(st, 3100 + COLOR_REFRACTORY_MS, BLACK, TH)).toBe('color');
  });

  it('will not count one transition twice, which is what bounds the period below', () => {
    // A transition sits inside the 2.5 s lookback for 2.5 s after it finishes,
    // so the delta stays elevated well past the event. Measured on the Reels
    // recording: at a 5 s period the 00:28 swipe fired again at 00:32, at 3 s
    // again at 00:30. The period has to clear the longest lookback with margin.
    expect(COLOR_REFRACTORY_MS).toBeGreaterThan(Math.max(...COLOR_LOOKBACKS_MS) * 2);

    const st = warm();
    pushGain(st, 3100, -60);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
    pushThumb(st, 3100, WHITE);
    // WHITE stays on screen: nothing further has happened, but for the next
    // 2.5 s the lookbacks still reach back into BLACK and read a full repaint.
    for (let t = 3200; t < 3100 + COLOR_REFRACTORY_MS; t += 100) {
      pushGain(st, t, -60);
      expect(decideJolt(st, t, WHITE, TH)).toBeNull();
      pushThumb(st, t, WHITE);
    }
    // By the time the arm is free the lookbacks have caught up, so the same
    // unchanged screen does not re-fire.
    expect(decideJolt(st, 3100 + COLOR_REFRACTORY_MS, WHITE, TH)).toBeNull();
  });

  it('uses COLOR_REFRACTORY_MS unless a caller overrides it', () => {
    // The field exists so the offline sim can sweep the period; the default is
    // what the app gets, because the app builds JoltThresholds without it.
    const st = warm();
    pushGain(st, 3100, -60);
    expect(decideJolt(st, 3100, WHITE, TH)).toBe('color');
    pushThumb(st, 3100, WHITE);
    // A second later, well inside the 6 s default and well outside a 0.5 s one.
    expect(decideJolt(st, 4100, BLACK, TH)).toBeNull();
    expect(decideJolt(st, 4100, BLACK, { ...TH, colorRefractoryMs: 500 })).toBe('color');
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
