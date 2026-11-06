/**
 * The first-link intro's timeline and frames (261105, T337; 261106 the
 * eclipse aurora, the plain ending, the climax into the theme's solid
 * colour; 261106 v6 the WorldLink status lines). The frames are pure, so the
 * review videos (seeked frame by frame) show exactly what the app plays.
 *
 * Invariants under test, for an instant link (a replay), a 75 s bake, a 20 s
 * one and a failure, in both themes, every ending, with and without reduced
 * motion:
 *   1. She is never there before the success line (not her, not her halo),
 *      and never at all when the link failed.
 *   2. The status lines show one at a time, in order; the success line lands
 *      on the full solid, after the last line; a failure line holds.
 *   3. The light builds with the lines (each a step brighter, never a jump)
 *      and peaks only under the last line; reduced motion has no peak and no
 *      bloom and a still light.
 *   4. No cut anywhere: no layer jumps more than a fade allows between two
 *      30 fps frames, and never more than one flash in any second.
 *   5. The end is what the wallpaper draws (the plain colour or her room,
 *      full screen) with no light left over it.
 *   6. The solid is the theme's colour: light mode never goes black, dark
 *      mode never white; HUD ink follows what is behind it.
 *   7. A skip before the success line crossfades into the solid and plays
 *      her entrance; it never rushes the climax or the solid.
 */
import { describe, expect, it } from 'vitest';
import { INTRO_END_ON } from '@shared/seilinkIntroTelemetry';
import { CLIMAX, OPEN_MS, beatAt, introTimes, skipFrom, type IntroTimes } from '../../../lib/seilink/introTimeline';
import { LAST_LINE_MS, instantLog, planLink, simulatedLog, type LinkLog } from '../../../lib/seilink/worldLink';
import { FLOOD_MAX, INTRO_PALETTE, captionTop, computeFrame, dayInk, revealMask, roomBehind, type IntroFrame } from './introFrame';

const W = 1920;
const H = 1080;
const TONES = ['dark', 'light'] as const;

const RUNS: Record<string, LinkLog> = {
  instant: instantLog(),
  slow: simulatedLog({ doneMs: 75_000 }),
  fast: simulatedLog({ doneMs: 20_000 }),
};
const FAIL = simulatedLog({ doneMs: 75_000, failAtMs: 30_000, failure: 'bake_failed' });

const timesFor = (log: LinkLog, reduced: boolean, skip: number | null = null): IntroTimes => introTimes(planLink(log), reduced, skip);

/** The ends a tone can have: its plain colour, or a room. */
function endsFor(tone: 'dark' | 'light') {
  return [tone === 'light' ? 'plain_light' : 'plain_dark', 'room'] as const;
}

/** The last ms worth sampling. */
const lengthOf = (x: IntroTimes): number => x.after?.end ?? (x.fail ?? 0) + 7000;

/**
 * How bright the picture is, roughly, 0 (black) .. 1 (white): the light and
 * its climax, her, the plain colour or room she ends on, under the solid.
 */
function brightness(f: IntroFrame): number {
  const light = f.tone === 'light';
  const scene = Math.min(
    1,
    0.35 * f.field.opacity * (0.72 + 0.5 * f.field.energy) * (1 + 0.9 * f.field.peak) +
      (light ? 0.6 : 0.15) * f.field.fill * f.field.peak +
      0.25 * f.avatar.opacity +
      (light ? 0.5 : 0.1) * f.bloom.a,
  );
  const ending = f.end === 'plain_light' ? 1 : f.end === 'plain_dark' ? 0.1 : 0.6;
  const base = scene + (ending - scene) * f.room.opacity;
  return base + ((light ? 1 : 0) - base) * f.solid;
}

/** Direction changes of a sampled curve (ignoring wiggles under `eps`). */
function reversals(values: number[], eps = 0.03): number[] {
  const out: number[] = [];
  let dir = 0;
  let ref = values[0];
  values.forEach((v, i) => {
    const d = v - ref;
    if (Math.abs(d) < eps) return;
    const s = Math.sign(d);
    if (dir !== 0 && s !== dir) out.push(i);
    dir = s;
    ref = v;
  });
  return out;
}

describe('the timeline (v6)', () => {
  for (const [name, log] of Object.entries(RUNS)) {
    it(`${name}: the climax under the last line, the success line on the full solid, then she comes in`, () => {
      for (const reduced of [false, true]) {
        const x = timesFor(log, reduced);
        expect(x.lines).toHaveLength(9);
        const s9 = x.lines[8];
        expect(x.success).toBe(s9 + LAST_LINE_MS);
        const C = x.climax!;
        const A = x.after!;
        expect(C.build).toBeGreaterThan(s9);
        expect(C.fill).toBeLessThan(x.success!);
        expect(A.success).toBe(x.success);
        expect(A.lift).toBeGreaterThan(A.success);
        expect(A.clear).toBeGreaterThan(A.lift);
        expect(A.port).toBeGreaterThan(A.lift);
        expect(A.linked).toBeGreaterThan(A.port);
        expect(A.end).toBeGreaterThan(A.fadeAt);
        expect(beatAt(x, s9)).toBe('tunnel');
        expect(beatAt(x, A.success)).toBe('link');
        expect(beatAt(x, A.port)).toBe('port');
        expect(beatAt(x, A.end)).toBe('linked');
      }
    });
  }

  it('the run lengths: about 50 s instant or a 20 s bake, a 75 s bake about 87 s', () => {
    expect(timesFor(RUNS.instant, false).after!.end).toBeGreaterThan(45_000);
    expect(timesFor(RUNS.instant, false).after!.end).toBeLessThan(55_000);
    expect(timesFor(RUNS.fast, false).after!.end).toBeLessThan(55_000);
    expect(timesFor(RUNS.slow, false).after!.end).toBeGreaterThan(80_000);
    expect(timesFor(RUNS.slow, false).after!.end).toBeLessThan(95_000);
  });

  it('a failure has no climax and no after, only the failure line', () => {
    const x = timesFor(FAIL, false);
    expect(x.success).toBeNull();
    expect(x.climax).toBeNull();
    expect(x.after).toBeNull();
    expect(x.fail).not.toBeNull();
    expect(x.lines.length).toBeLessThan(9);
  });

  it('a link still waiting has no after yet (nothing of her can show)', () => {
    const x = timesFor({ at: { sent: 100, answered: 900, host: 2000 }, failed: null }, false);
    expect(x.after).toBeNull();
    expect(x.climax).toBeNull();
  });
});

describe('she appears only after the success line', () => {
  for (const reduced of [false, true]) {
    for (const end of INTRO_END_ON) {
      for (const [name, log] of Object.entries(RUNS)) {
        it(`${name}${reduced ? ' reduced' : ''} ${end}`, () => {
          const x = timesFor(log, reduced);
          const at = (t: number) => computeFrame(x, t, W, H, reduced, end);
          for (let t = 0; t <= x.success!; t += 50) {
            const f = at(t);
            expect(f.avatar.opacity).toBe(0);
            expect(f.halo).toBe(0);
            expect(f.room.opacity).toBe(0);
          }
          // Still hidden while the success line is read on the solid.
          for (let t = x.success!; t <= x.after!.lift; t += 50) expect(at(t).avatar.opacity).toBe(0);
          const f = at(x.after!.port + (reduced ? 400 : 0));
          expect(f.avatar.opacity).toBeGreaterThan(0.9);
          const last = at(x.after!.end);
          expect(last.avatar).toEqual({ opacity: 1, filter: 'none', rise: 0 });
        });
      }
      it(`failure${reduced ? ' reduced' : ''} ${end}: never`, () => {
        const x = timesFor(FAIL, reduced);
        for (let t = 0; t <= lengthOf(x) + 60_000; t += 100) {
          const f = computeFrame(x, t, W, H, reduced, end);
          expect(f.avatar.opacity).toBe(0);
          expect(f.halo).toBe(0);
          expect(f.room.opacity).toBe(0);
        }
      });
    }
  }
});

describe('the lines', () => {
  it('one at a time, in order, then the success line', () => {
    const x = timesFor(RUNS.slow, false);
    const at = (t: number) => computeFrame(x, t, W, H, false, 'plain_dark');
    expect(at(0).caption.cur).toBeNull();
    let lastIdx = -1;
    for (let t = 0; t < x.success!; t += 100) {
      const c = at(t).caption;
      if (c.cur === null) continue;
      expect(typeof c.cur).toBe('number');
      expect(c.cur as number).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = c.cur as number;
    }
    expect(lastIdx).toBe(8);
    for (let t = x.success!; t <= x.after!.end; t += 100) expect(at(t).caption.cur).toBe('success');
    // The new line fades up only after the one before has begun to fade out.
    const s = x.lines[3];
    const f = at(s + 60);
    expect(f.caption.cur).toBe(3);
    expect(f.caption.prev).toBe(2);
    expect(f.caption.curIn).toBe(0);
    expect(f.caption.prevOut).toBeGreaterThan(0);
    expect(at(s + 1000).caption.curIn).toBeCloseTo(1, 5);
    expect(at(s + 1000).caption.prevOut).toBe(0);
  });

  it('the success line is read on the full solid', () => {
    for (const reduced of [false, true]) {
      for (const tone of TONES) {
        const x = timesFor(RUNS.instant, reduced);
        const f = computeFrame(x, x.success! + 600, W, H, reduced, tone === 'light' ? 'plain_light' : 'plain_dark', tone);
        expect(f.caption.cur).toBe('success');
        expect(f.solid).toBe(1);
      }
    }
  });

  it('a failure line holds, and the light calms but stays', () => {
    const x = timesFor(FAIL, false);
    const at = (t: number) => computeFrame(x, t, W, H, false, 'plain_dark');
    for (let t = x.fail!; t < x.fail! + 120_000; t += 500) {
      const f = at(t);
      expect(f.caption.cur).toBe('fail');
      expect(f.solid).toBe(0);
      expect(f.field.opacity).toBe(1);
      expect(f.field.peak).toBe(0);
    }
    expect(at(x.fail! + 4000).field.energy).toBeLessThan(at(x.fail! - 10).field.energy);
  });
});

describe('the light builds with the lines', () => {
  it('each line adds a step of energy, eased, and the peak only comes under the last', () => {
    const x = timesFor(RUNS.slow, false);
    const at = (t: number) => computeFrame(x, t, W, H, false, 'plain_dark');
    let e = 0;
    for (let t = 0; t < x.climax!.fill; t += 33) {
      const f = at(t);
      expect(f.field.energy).toBeGreaterThanOrEqual(e - 1e-12);
      expect(f.field.energy - e).toBeLessThan(0.02);
      e = f.field.energy;
      if (t < x.climax!.build) expect(f.field.peak).toBe(0);
    }
    expect(at(x.lines[4] + 2000).field.energy).toBeCloseTo(5 / 9, 5);
    expect(at(x.lines[8] + 1500).field.energy).toBeCloseTo(1, 5);
    expect(at(x.climax!.peak).field.peak).toBe(1);
    // Faster with every line: the clock runs about 1.6x with all of them up.
    const speed = (t: number) => at(t + 10).field.clock - at(t).field.clock;
    expect(speed(x.lines[1] - 50)).toBeLessThan(speed(x.lines[5] - 50));
    expect(speed(x.lines[8] - 50)).toBeCloseTo(10 * (1 + 0.6 * (8 / 9)), 5);
  });

  it('reduced motion: a still light, no peak, no bloom, nothing masked or blurred', () => {
    for (const [, log] of Object.entries(RUNS)) {
      const x = timesFor(log, true);
      for (const end of INTRO_END_ON) {
        for (let t = 0; t <= x.after!.end; t += 50) {
          const f = computeFrame(x, t, W, H, true, end);
          expect(f.field.clock).toBe(2400);
          expect(f.field.gather).toBe(0);
          expect(f.field.swell).toBe(0);
          expect(f.field.peak).toBe(0);
          expect(f.field.fill).toBe(0);
          expect(f.bloom.a).toBe(0);
          expect(f.linkGlow).toBe(0);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(f.avatar.filter).toBe('none');
          expect(f.avatar.rise).toBe(0);
        }
      }
    }
  });
});

describe('no cuts', () => {
  const cases: Array<[string, LinkLog]> = [...Object.entries(RUNS), ['failed', FAIL]];
  for (const reduced of [false, true]) {
    for (const tone of TONES) {
      for (const end of endsFor(tone)) {
        for (const [name, log] of cases) {
          it(`${name}${reduced ? ' reduced' : ''} ${tone} ${end}`, () => {
            const x = timesFor(log, reduced);
            const at = (t: number) => computeFrame(x, t, W, H, reduced, end, tone);
            // One 30 fps frame: no layer jumps more than a fade of about a second allows (a cut is a step of 1).
            let prev = at(0);
            for (const v of Object.values(prev.field)) expect(Number.isFinite(v)).toBe(true);
            const vals: number[] = [brightness(prev)];
            const len = lengthOf(x);
            for (let t = 33; t <= len; t += 33) {
              const f = at(t);
              expect(Math.abs(f.solid - prev.solid)).toBeLessThan(0.06);
              expect(Math.abs(brightness(f) - brightness(prev))).toBeLessThan(0.06);
              if (end !== 'room') expect(Math.abs(f.room.opacity - prev.room.opacity)).toBeLessThan(0.06);
              expect(Math.abs(f.field.opacity - prev.field.opacity)).toBeLessThan(0.1);
              expect(Math.abs(f.avatar.opacity - prev.avatar.opacity)).toBeLessThan(0.1);
              expect(Math.abs(f.field.energy - prev.field.energy)).toBeLessThan(0.03);
              vals.push(brightness(f));
              prev = f;
            }
            // A flash is a pair of opposing changes: at most 2 direction changes in any 1 s.
            const rev = reversals(vals).map((i) => i * 33);
            for (const r of rev) expect(rev.filter((y) => y >= r && y < r + 1000).length).toBeLessThanOrEqual(2);
          });
        }
      }
    }
  }
});

describe('the climax and the solid', () => {
  for (const tone of TONES) {
    for (const end of endsFor(tone)) {
      it(`${tone} ${end}: opens out of the solid, one swell into the solid, held under the success line, fading as she comes in`, () => {
        const x = timesFor(RUNS.instant, false);
        const C = x.climax!;
        const A = x.after!;
        const at = (t: number) => computeFrame(x, t, W, H, false, end, tone);
        expect(at(0).tone).toBe(tone);
        expect(at(0).solid).toBe(1);
        let o = 1;
        for (let t = 0; t <= OPEN_MS; t += 10) {
          const k = at(t).solid;
          expect(k).toBeLessThanOrEqual(o);
          o = k;
        }
        for (let t = OPEN_MS; t <= C.dim; t += 50) expect(at(t).solid).toBe(0);
        let last = 0;
        for (let t = 0; t < C.fill; t += 10) {
          const p = at(t).field.peak;
          expect(p).toBeGreaterThanOrEqual(last);
          last = p;
        }
        expect(at(C.fill - 1).field.fill).toBeGreaterThan(0.99);
        for (let t = C.fill; t <= A.lift; t += 10) {
          expect(at(t).solid).toBe(1);
          expect(at(t).field.peak).toBe(0);
          expect(at(t).field.fill).toBe(0);
        }
        let b = 1;
        for (let t = A.lift; t <= A.clear; t += 10) {
          const k = at(t).solid;
          expect(k).toBeLessThanOrEqual(b);
          b = k;
        }
        const mid = at((A.lift + A.clear) / 2);
        expect(mid.solid).toBeGreaterThan(0);
        expect(mid.solid).toBeLessThan(1);
        expect(mid.avatar.opacity).toBeGreaterThan(0);
        for (let t = A.clear; t <= A.end; t += 50) expect(at(t).solid).toBe(0);
      });

      it(`${tone} ${end}: ends on the wallpaper picture, full screen, with no light left over it`, () => {
        const x = timesFor(RUNS.fast, false);
        const A = x.after!;
        for (const t of [A.linked + 1600, A.fadeAt, A.end]) {
          const f = computeFrame(x, t, W, H, false, end, tone);
          expect(f.room.opacity).toBe(1);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(revealMask(f, { x: 0, y: 0 })).toBe('none');
          expect(f.field.opacity).toBe(0);
          expect(f.space).toBe(0);
          expect(f.halo).toBe(0);
          expect(f.linkGlow).toBe(0);
          expect(f.room.flood).toBe(end === 'plain_light' ? FLOOD_MAX : 0);
          expect(f.solid).toBe(0);
          expect(f.bloom.a).toBe(0);
        }
      });
    }
  }

  it('the solid is the theme colour; HUD ink follows it', () => {
    const x = timesFor(RUNS.instant, false);
    for (const end of INTRO_END_ON) {
      expect(computeFrame(x, 0, W, H, false, end, 'light').tone).toBe('light');
      expect(computeFrame(x, 0, W, H, false, end, 'dark').tone).toBe('dark');
    }
    expect(computeFrame(x, 0, W, H, false, 'plain_light').tone).toBe('light');
    expect(computeFrame(x, 0, W, H, false, 'plain_dark').tone).toBe('dark');
    const centre = { x: W / 2, y: H * 0.7 };
    const p = { x: W / 2, y: H * 0.17 };
    const fill = x.climax!.fill + 100;
    expect(dayInk(roomBehind(computeFrame(x, fill, W, H, false, 'room', 'light'), centre, p))).toBe(1);
    expect(dayInk(roomBehind(computeFrame(x, fill, W, H, false, 'room', 'dark'), centre, p))).toBe(0);
    // The lines over the night light are in night ink.
    expect(dayInk(roomBehind(computeFrame(x, x.lines[3], W, H, false, 'room', 'light'), centre, p))).toBe(0);
  });

  it('is deterministic', () => {
    const x = timesFor(RUNS.slow, false);
    for (const t of [0, 777, 5000, 30_000, 76_000, 80_000, 86_000]) expect(computeFrame(x, t, W, H, false, 'room')).toEqual(computeFrame(x, t, W, H, false, 'room'));
  });
});

describe('a skip', () => {
  it('before the success line: a calm crossfade into the solid, then her entrance', () => {
    for (const tone of TONES) {
      const skip = 9000;
      const x = timesFor(RUNS.slow, false, skip);
      expect(x.skip).toBe(skip);
      expect(x.climax!.calm).toBe(true);
      expect(x.success).toBeNull();
      const at = (t: number) => computeFrame(x, t, W, H, false, tone === 'light' ? 'plain_light' : 'plain_dark', tone);
      for (let t = skip; t < x.after!.lift; t += 20) {
        const f = at(t);
        expect(f.avatar.opacity).toBe(0);
        expect(f.field.peak).toBe(0);
        expect(f.field.fill).toBe(0);
      }
      expect(at(x.climax!.fill).solid).toBe(1);
      expect(at(skip + 800).caption.block).toBe(0);
      expect(at(x.after!.end).avatar.opacity).toBe(1);
      // The solid never jumps.
      let prev = at(skip);
      for (let t = skip + 33; t <= x.after!.end; t += 33) {
        const f = at(t);
        expect(Math.abs(f.solid - prev.solid)).toBeLessThan(0.06);
        prev = f;
      }
    }
  });

  it('under the climax plays it out as planned', () => {
    const plain = timesFor(RUNS.instant, false);
    const late = plain.climax!.build + 10;
    expect(timesFor(RUNS.instant, false, late).skip).toBeNull();
    expect(timesFor(RUNS.instant, false, plain.lines[8] + CLIMAX.build - 10).skip).not.toBeNull();
  });

  it('never rushes the climax or the solid', () => {
    const x = timesFor(RUNS.instant, false);
    const A = x.after!;
    for (const t of [0, 1000, x.climax!.build, x.climax!.fill, A.success, A.lift, A.clear - 1]) expect(skipFrom(x, t)).toBe(A.clear);
    for (const t of [A.clear, A.port, A.fadeAt]) expect(skipFrom(x, t)).toBe(t);
  });
});

describe('the palette', () => {
  it('is a dark sky with bright light (space, no pastel)', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const v of INTRO_PALETTE.void) expect(lum(v)).toBeLessThan(24);
    for (const c of INTRO_PALETTE.lights) expect(Math.max(...c)).toBeGreaterThanOrEqual(200);
  });
});

describe('captions', () => {
  // Her box at 1920x1080 in the cozy room: top at half the height.
  const her = { x: 773, y: 540, w: 405, h: 540 };

  it('sit above her head with a gap', () => {
    const top = captionTop(H, 110, her);
    expect(top + 110).toBeLessThanOrEqual(her.y - 24);
    expect(top).toBeGreaterThanOrEqual(64);
  });

  it('move up when her head is close, never into the corner label', () => {
    const near = { ...her, y: 300 };
    expect(captionTop(H, 110, near) + 110).toBeLessThanOrEqual(300 - 24);
    expect(captionTop(400, 300, { ...her, y: 120 })).toBe(64);
  });

  it('use the default place before she has a size', () => {
    expect(captionTop(H, 110, null)).toBeCloseTo(H * 0.15);
  });

  it('turn to day ink only where her room shows', () => {
    const x = timesFor(RUNS.instant, false);
    const A = x.after!;
    const at = (t: number) => computeFrame(x, t, W, H, false, 'room', 'dark');
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    expect(dayInk(roomBehind(at(A.clear + 200), centre, above))).toBe(0);
    expect(dayInk(roomBehind(at(A.linked + 600), centre, above))).toBe(1);
    let near = 0;
    let far = 0;
    for (let t = A.port; t < A.linked; t += 50) {
      const f = at(t);
      if (!near && roomBehind(f, centre, above) >= 1) near = t;
      if (!far && roomBehind(f, centre, { x: 40, y: 30 }) >= 1) far = t;
    }
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('follow the crossfade under reduced motion', () => {
    const x = timesFor(RUNS.instant, true);
    const centre = { x: W / 2, y: H * 0.7 };
    const p = { x: 40, y: 30 };
    for (const end of ['room', 'plain_light'] as const) {
      expect(roomBehind(computeFrame(x, x.after!.clear + 50, W, H, true, end, 'dark'), centre, p)).toBe(0);
      expect(roomBehind(computeFrame(x, x.after!.port + 1800, W, H, true, end, 'dark'), centre, p)).toBe(1);
    }
  });
});
