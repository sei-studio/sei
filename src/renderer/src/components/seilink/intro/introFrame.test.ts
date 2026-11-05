/**
 * The first-link intro's timeline and frames (261105, T337). The frames are
 * pure, so the review videos (seeked frame by frame) show exactly what the
 * app plays.
 *
 * Invariants under test:
 *   1. Three beats then the end card, in order, about 11 s (8 s calm).
 *   2. The end card holds for the host's answer, at most HOLD_MAX_MS, and
 *      never delays anything before it.
 *   3. Every style: she is not there in beat 1, she is fully there by beat 3,
 *      and the room ends inside the monitor with nothing clipped or masked.
 *   4. Reduced motion: no motion effects at all, only fades.
 *   5. Deterministic: the same t gives the same frame.
 */
import { describe, expect, it } from 'vitest';
import { INTRO_STYLES } from '@shared/seilinkIntroTelemetry';
import {
  CALM_TIMELINE,
  FULL_TIMELINE,
  HOLD_MAX_MS,
  beatAt,
  beatProgress,
  hash01,
  timelineTime,
  typedChars,
} from '../../../lib/seilink/introTimeline';
import { PORT_SCALE, computeFrame, screenBox } from './introFrame';

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

  it('types a line after its delay, whole at once on the calm timeline', () => {
    const tl = FULL_TIMELINE;
    expect(typedChars(tl, tl.lineDelay - 1, 'tunnel', 20)).toBe(0);
    expect(typedChars(tl, tl.lineDelay, 'tunnel', 20)).toBe(1);
    expect(typedChars(tl, 100_000, 'tunnel', 20)).toBe(20);
    expect(typedChars(CALM_TIMELINE, CALM_TIMELINE.lineDelay, 'tunnel', 20)).toBe(20);
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

  it('hash01 is deterministic and in [0, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = hash01(i, 7);
      expect(v).toBe(hash01(i, 7));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('frames', () => {
  for (const style of INTRO_STYLES) {
    describe(style, () => {
      it('she is not there in beat 1 and fully there by beat 3', () => {
        const tl = FULL_TIMELINE;
        for (let t = 0; t < tl.beats.link; t += 100) expect(computeFrame(style, tl, t, W, H, false).avatar.opacity).toBe(0);
        const f = computeFrame(style, tl, tl.beats.port, W, H, false);
        expect(f.avatar.opacity).toBe(1);
        expect(f.avatar.clip).toBe('none');
        expect(f.avatar.filter).toBe('none');
      });

      it('the room is whole before she arrives', () => {
        const f = computeFrame(style, FULL_TIMELINE, FULL_TIMELINE.beats.link, W, H, false);
        expect(f.room.opacity).toBe(1);
        expect(f.room.clip).toBe('none');
        expect(f.room.mask).toBe('none');
      });

      it('ends inside the monitor, on the desktop', () => {
        const f = computeFrame(style, FULL_TIMELINE, FULL_TIMELINE.beats.linked, W, H, false);
        expect(f.stage.scale).toBeCloseTo(PORT_SCALE, 5);
        expect(f.stage.tx).toBe(0);
        expect(f.bezel.opacity).toBe(1);
        expect(f.desk).toBe(1);
        expect(f.icons).toEqual([1, 1, 1, 1]);
        expect(f.room.filter).toBe('none');
        expect(f.room.glitch).toBe(0);
        const s = screenBox(W, H);
        expect(f.H / 2 + f.stage.ty).toBeCloseTo(s.y + s.h / 2, 5);
      });

      it('is deterministic', () => {
        for (const t of [0, 777, 1650, 3500, 5000, 6800, 8000, 9500]) {
          expect(computeFrame(style, FULL_TIMELINE, t, W, H, false)).toEqual(computeFrame(style, FULL_TIMELINE, t, W, H, false));
        }
      });

      it('reduced motion only fades', () => {
        const tl = CALM_TIMELINE;
        for (let t = 0; t <= tl.end; t += 50) {
          const f = computeFrame(style, tl, t, W, H, true);
          expect(f.stage.tx).toBe(0);
          expect([1, PORT_SCALE]).toContain(f.stage.scale);
          expect(f.room.clip).toBe('none');
          expect(f.room.mask).toBe('none');
          expect(f.room.glitch).toBe(0);
          expect(f.avatar.glitch).toBe(0);
          expect(f.avatar.transform).toBe('none');
          const fx = f.fx;
          expect([fx.wire, fx.rain, fx.tunnel, fx.rim, fx.ring, fx.linkedPulse]).toEqual([0, 0, 0, 0, 0, 0]);
          expect([fx.beam, fx.herScan, fx.stream, fx.motes, fx.ripple].every((v) => v < 0)).toBe(true);
        }
        const end = computeFrame(style, tl, tl.beats.linked, W, H, true);
        expect(end.avatar.opacity).toBe(1);
        expect(end.bezel.opacity).toBe(1);
        expect(end.stage.scale).toBe(PORT_SCALE);
      });
    });
  }

  it('the three styles really differ', () => {
    const at = (s: (typeof INTRO_STYLES)[number]): string => JSON.stringify(computeFrame(s, FULL_TIMELINE, 1800, W, H, false).fx);
    expect(new Set(INTRO_STYLES.map(at)).size).toBe(INTRO_STYLES.length);
  });
});
