/**
 * The first-link intro's timeline and frames (261105, T337; 261106 space
 * aurora moods, first-link v3 plain ending). The frames are pure, so the
 * review videos (seeked frame by frame) show exactly what the app plays.
 *
 * Invariants under test:
 *   1. Three beats then the end card, in order, about 11 s (8 s calm).
 *   2. The end card holds for the host's answer, at most HOLD_MAX_MS, and
 *      never delays anything before it.
 *   3. Every mood and every ending: she is not there in beat 1, she is fully
 *      herself by the end card, and the end card is what the wallpaper draws
 *      (the plain colour or her room, full screen) with no light, stars or
 *      glow left over it, so the window can step aside without a cut.
 *   4. A plain ending is never masked: the whole screen settles into the
 *      colour, no circle or edge.
 *   5. Reduced motion: the light stands still, nothing is masked or blurred.
 *   6. Deterministic: the same t gives the same frame; the moods differ only
 *      in colour (same motion).
 *   7. Captions (261106) sit above her head, never over her, and never rise
 *      into the corner label; text switches to day ink only where a light
 *      background (her room, the white plain one) is behind it, never over
 *      the black one.
 */
import { describe, expect, it } from 'vitest';
import { INTRO_END_ON, INTRO_MOODS } from '@shared/seilinkIntroTelemetry';
import {
  CALM_TIMELINE,
  FULL_TIMELINE,
  HOLD_MAX_MS,
  beatAt,
  beatProgress,
  timelineTime,
} from '../../../lib/seilink/introTimeline';
import { FLOOD_MAX, INTRO_PALETTES, captionTop, computeFrame, dayInk, revealMask, roomBehind } from './introFrame';

const W = 1920;
const H = 1080;

describe('timeline', () => {
  it('runs the beats in order and ends after the fade', () => {
    for (const tl of [FULL_TIMELINE, CALM_TIMELINE]) {
      const { tunnel, link, port, linked } = tl.beats;
      expect(tunnel).toBe(0);
      expect(link).toBeGreaterThan(tunnel);
      expect(port).toBeGreaterThan(link);
      expect(linked).toBeGreaterThan(port);
      expect(tl.fadeAt).toBeGreaterThan(linked);
      expect(tl.end).toBeGreaterThan(tl.fadeAt);
      expect(beatAt(tl, 0)).toBe('tunnel');
      expect(beatAt(tl, link)).toBe('link');
      expect(beatAt(tl, port + 1)).toBe('port');
      expect(beatAt(tl, tl.end)).toBe('linked');
    }
    expect(FULL_TIMELINE.end).toBeGreaterThanOrEqual(8000);
    expect(FULL_TIMELINE.end).toBeLessThanOrEqual(12_000);
    expect(CALM_TIMELINE.end).toBeLessThan(FULL_TIMELINE.end);
  });

  it('beat progress runs 0..1', () => {
    expect(beatProgress(FULL_TIMELINE, 0, 'tunnel')).toBe(0);
    expect(beatProgress(FULL_TIMELINE, FULL_TIMELINE.beats.link, 'tunnel')).toBe(1);
    expect(beatProgress(FULL_TIMELINE, FULL_TIMELINE.beats.link + 1, 'link')).toBeGreaterThan(0);
  });

  it('holds at the end card until the host answers, at most HOLD_MAX_MS', () => {
    const tl = FULL_TIMELINE;
    const K = tl.beats.linked;
    // Before the end card the answer changes nothing.
    expect(timelineTime(tl, 4000, null)).toBe(4000);
    // Answered early: no hold at all.
    expect(timelineTime(tl, K + 500, 1000)).toBe(K + 500);
    // Not answered: holds, then goes on after the cap.
    expect(timelineTime(tl, K + 3000, null)).toBe(K);
    expect(timelineTime(tl, K + HOLD_MAX_MS + 400, null)).toBe(K + 400);
    // Answered during the hold: goes on from then.
    expect(timelineTime(tl, K + 2500, K + 2000)).toBe(K + 500);
  });
});

describe('frames', () => {
  for (const mood of INTRO_MOODS) {
    for (const end of INTRO_END_ON) {
      describe(`${mood} ending on ${end}`, () => {
        const at = (t: number, reduced = false) => computeFrame(mood, reduced ? CALM_TIMELINE : FULL_TIMELINE, t, W, H, reduced, end);

        it('she is not there in beat 1 and fully herself by the end card', () => {
          const tl = FULL_TIMELINE;
          for (let t = 0; t < tl.beats.link; t += 100) expect(at(t).avatar.opacity).toBe(0);
          const f = at(tl.beats.port);
          expect(f.avatar.opacity).toBe(1);
          expect(f.avatar.filter).toBe('none');
        });

        it('the light and space wake first and the ending stays hidden until the port beat', () => {
          const tl = FULL_TIMELINE;
          expect(at(0).field.opacity).toBe(0);
          expect(at(1500).field.opacity).toBeGreaterThan(0.9);
          expect(at(2500).space).toBeGreaterThan(0.9);
          for (let t = 0; t <= tl.beats.port; t += 100) expect(at(t).room.opacity).toBe(0);
          const mid = at(tl.beats.port + 1200);
          if (end === 'room') {
            expect(mid.room.opacity).toBe(1);
            expect(mid.room.reveal).toBeGreaterThan(0);
            expect(mid.room.reveal).toBeLessThan(1);
            expect(revealMask(mid, { x: W / 2, y: H / 2 })).toMatch(/^radial-gradient\(/);
          } else {
            // The whole screen settles into the colour: partly there, never masked.
            expect(mid.room.opacity).toBeGreaterThan(0);
            expect(mid.room.opacity).toBeLessThan(1);
            expect(revealMask(mid, { x: W / 2, y: H / 2 })).toBe('none');
          }
        });

        it('ends on the wallpaper picture, full screen, with no light left over it', () => {
          const tl = FULL_TIMELINE;
          for (const t of [tl.beats.linked + 1600, tl.fadeAt, tl.end]) {
            const f = at(t);
            expect(f.room.opacity).toBe(1);
            expect(f.room.reveal).toBeGreaterThanOrEqual(1);
            expect(revealMask(f, { x: 0, y: 0 })).toBe('none');
            expect(f.field.opacity).toBe(0);
            expect(f.space).toBe(0);
            expect(f.halo).toBe(0);
            expect(f.linkGlow).toBe(0);
            expect(f.room.flood).toBe(end === 'plain_light' ? FLOOD_MAX : 0);
            expect(f.avatar).toEqual({ opacity: 1, filter: 'none' });
          }
        });

        it('breathes one soft glow around her when linked (none over the white ending)', () => {
          const K = FULL_TIMELINE.beats.linked;
          if (end === 'plain_light') {
            for (let t = K; t < K + 1600; t += 50) expect(at(t).linkGlow).toBe(0);
            return;
          }
          expect(at(K - 10).linkGlow).toBe(0);
          expect(at(K + 800).linkGlow).toBeCloseTo(1, 5);
          expect(at(K + 400).linkGlow).toBeGreaterThan(0);
        });

        it('is deterministic', () => {
          for (const t of [0, 777, 1650, 3500, 5000, 6800, 8000, 9500]) expect(at(t)).toEqual(at(t));
        });

        it('reduced motion: a still light, plain fades, nothing masked or blurred', () => {
          const tl = CALM_TIMELINE;
          for (let t = 0; t <= tl.end; t += 50) {
            const f = at(t, true);
            expect(f.field.clock).toBe(at(0, true).field.clock);
            expect(f.field.gather).toBe(0);
            expect(f.field.swell).toBe(0);
            expect(f.linkGlow).toBe(0);
            expect(f.room.reveal).toBeGreaterThanOrEqual(1);
            expect(f.avatar.filter).toBe('none');
          }
          const last = at(tl.end, true);
          expect(last.avatar.opacity).toBe(1);
          expect(last.room.opacity).toBe(1);
          expect(last.field.opacity).toBe(0);
          expect(last.space).toBe(0);
          expect(last.halo).toBe(0);
        });
      });
    }
  }

  it('the moods share the motion and differ in colour', () => {
    const motion = (m: (typeof INTRO_MOODS)[number]) => {
      const { mood: _m, ...rest } = computeFrame(m, FULL_TIMELINE, 7000, W, H, false);
      return JSON.stringify(rest);
    };
    expect(new Set(INTRO_MOODS.map(motion)).size).toBe(1);
    expect(new Set(INTRO_MOODS.map((m) => JSON.stringify(INTRO_PALETTES[m]))).size).toBe(INTRO_MOODS.length);
  });

  it('every palette is a dark sky with bright light (space, no pastel)', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const m of INTRO_MOODS) {
      const p = INTRO_PALETTES[m];
      for (const v of p.void) expect(lum(v)).toBeLessThan(24);
      for (const c of p.lights) expect(Math.max(...c)).toBeGreaterThanOrEqual(200);
    }
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
    const at = (t: number) => computeFrame('nebula', FULL_TIMELINE, t, W, H, false, 'room');
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    expect(dayInk(roomBehind(at(FULL_TIMELINE.beats.link + 500), centre, above))).toBe(0);
    expect(dayInk(roomBehind(at(FULL_TIMELINE.beats.linked + 600), centre, above))).toBe(1);
    // While the circle opens, a point near her is in the room before a far corner is.
    let near = 0;
    let far = 0;
    for (let t = FULL_TIMELINE.beats.port; t < FULL_TIMELINE.beats.linked; t += 50) {
      const f = at(t);
      if (!near && roomBehind(f, centre, above) >= 1) near = t;
      if (!far && roomBehind(f, centre, { x: 40, y: 30 }) >= 1) far = t;
    }
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('follow the crossfade under reduced motion', () => {
    const centre = { x: W / 2, y: H * 0.7 };
    const p = { x: 40, y: 30 };
    const { port } = CALM_TIMELINE.beats;
    for (const end of ['room', 'plain_light'] as const) {
      expect(roomBehind(computeFrame('nebula', CALM_TIMELINE, port - 100, W, H, true, end), centre, p)).toBe(0);
      expect(roomBehind(computeFrame('nebula', CALM_TIMELINE, port + 1300, W, H, true, end), centre, p)).toBe(1);
    }
  });

  it('go to day ink over the white plain background, never over the black one', () => {
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    const t = FULL_TIMELINE.beats.linked + 600;
    expect(dayInk(roomBehind(computeFrame('accretion', FULL_TIMELINE, t, W, H, false, 'plain_light'), centre, above))).toBe(1);
    expect(dayInk(roomBehind(computeFrame('accretion', FULL_TIMELINE, t, W, H, false, 'plain_dark'), centre, above))).toBe(0);
  });
});
