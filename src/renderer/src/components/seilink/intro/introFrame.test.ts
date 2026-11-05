/**
 * The first-link intro's timeline and frames (261105, T337; 261106 soft light
 * styles). The frames are pure, so the review videos (seeked frame by frame)
 * show exactly what the app plays.
 *
 * Invariants under test:
 *   1. Three beats then the end card, in order, about 11 s (8 s calm).
 *   2. The end card holds for the host's answer, at most HOLD_MAX_MS, and
 *      never delays anything before it.
 *   3. Every style: she is not there in beat 1, she is fully herself by the
 *      end card, and the end card is her room full screen with no light left
 *      over it (the picture the wallpaper draws, so the window can step aside).
 *   4. Reduced motion: the light stands still, nothing is masked or blurred.
 *   5. Deterministic: the same t gives the same frame.
 *   6. Captions (261106) sit above her head, never over her, and never rise
 *      into the corner label; text switches to day ink only where her room
 *      is behind it.
 */
import { describe, expect, it } from 'vitest';
import { INTRO_STYLES } from '@shared/seilinkIntroTelemetry';
import {
  CALM_TIMELINE,
  FULL_TIMELINE,
  HOLD_MAX_MS,
  beatAt,
  beatProgress,
  timelineTime,
} from '../../../lib/seilink/introTimeline';
import { captionTop, computeFrame, dayInk, revealMask, roomBehind } from './introFrame';

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
  for (const style of INTRO_STYLES) {
    describe(style, () => {
      it('she is not there in beat 1 and fully herself by the end card', () => {
        const tl = FULL_TIMELINE;
        for (let t = 0; t < tl.beats.link; t += 100) expect(computeFrame(style, tl, t, W, H, false).avatar.opacity).toBe(0);
        const f = computeFrame(style, tl, tl.beats.port, W, H, false);
        expect(f.avatar.opacity).toBe(1);
        expect(f.avatar.filter).toBe('none');
      });

      it('the light wakes first and the room stays dark until the port beat', () => {
        const tl = FULL_TIMELINE;
        expect(computeFrame(style, tl, 0, W, H, false).field.opacity).toBe(0);
        expect(computeFrame(style, tl, 1500, W, H, false).field.opacity).toBeGreaterThan(0.9);
        for (let t = 0; t <= tl.beats.port; t += 100) expect(computeFrame(style, tl, t, W, H, false).room.opacity).toBe(0);
        const mid = computeFrame(style, tl, tl.beats.port + 1200, W, H, false);
        expect(mid.room.opacity).toBe(1);
        expect(mid.room.reveal).toBeGreaterThan(0);
        expect(mid.room.reveal).toBeLessThan(1);
        expect(revealMask(mid, { x: W / 2, y: H / 2 })).toMatch(/^radial-gradient\(/);
      });

      it('ends on her room, full screen, with no light left over it', () => {
        const tl = FULL_TIMELINE;
        for (const t of [tl.beats.linked + 1600, tl.fadeAt, tl.end]) {
          const f = computeFrame(style, tl, t, W, H, false);
          expect(f.room.opacity).toBe(1);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(revealMask(f, { x: 0, y: 0 })).toBe('none');
          expect(f.field.opacity).toBe(0);
          expect(f.halo).toBe(0);
          expect(f.pulse).toBe(-1);
          expect(f.avatar).toEqual({ opacity: 1, filter: 'none' });
        }
      });

      it('is deterministic', () => {
        for (const t of [0, 777, 1650, 3500, 5000, 6800, 8000, 9500]) {
          expect(computeFrame(style, FULL_TIMELINE, t, W, H, false)).toEqual(computeFrame(style, FULL_TIMELINE, t, W, H, false));
        }
      });

      it('reduced motion: a still light, plain fades, nothing masked or blurred', () => {
        const tl = CALM_TIMELINE;
        for (let t = 0; t <= tl.end; t += 50) {
          const f = computeFrame(style, tl, t, W, H, true);
          expect(f.field.clock).toBe(computeFrame(style, tl, 0, W, H, true).field.clock);
          expect(f.field.gather).toBe(0);
          expect(f.field.swell).toBe(0);
          expect(f.pulse).toBe(-1);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(f.avatar.filter).toBe('none');
        }
        const end = computeFrame(style, tl, tl.end, W, H, true);
        expect(end.avatar.opacity).toBe(1);
        expect(end.room.opacity).toBe(1);
        expect(end.field.opacity).toBe(0);
        expect(end.halo).toBe(0);
      });
    });
  }

  it('the three styles really differ', () => {
    const at = (s: (typeof INTRO_STYLES)[number]): string => {
      const f = computeFrame(s, FULL_TIMELINE, 7000, W, H, false);
      return JSON.stringify([f.field, f.room]);
    };
    expect(new Set(INTRO_STYLES.map(at)).size).toBe(INTRO_STYLES.length);
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
    const style = 'aurora';
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    const beforeRoom = computeFrame(style, FULL_TIMELINE, FULL_TIMELINE.beats.link + 500, W, H, false);
    expect(dayInk(roomBehind(beforeRoom, centre, above))).toBe(0);
    const end = computeFrame(style, FULL_TIMELINE, FULL_TIMELINE.beats.linked + 600, W, H, false);
    expect(dayInk(roomBehind(end, centre, above))).toBe(1);
    // While the circle opens, a point near her is in the room before a far corner is.
    let near = 0;
    let far = 0;
    for (let t = FULL_TIMELINE.beats.port; t < FULL_TIMELINE.beats.linked; t += 50) {
      const f = computeFrame(style, FULL_TIMELINE, t, W, H, false);
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
    expect(roomBehind(computeFrame('aurora', CALM_TIMELINE, port - 100, W, H, true), centre, p)).toBe(0);
    expect(roomBehind(computeFrame('aurora', CALM_TIMELINE, port + 1300, W, H, true), centre, p)).toBe(1);
  });
});
