/**
 * The first-link intro's timeline and frames (261105, T337; 261106 the
 * eclipse aurora, first-link v3 plain ending, v4 climax and cut to black).
 * The frames are pure, so the review videos (seeked frame by frame) show
 * exactly what the app plays.
 *
 * Invariants under test:
 *   1. Three beats then the end card, in order, about 11.3 s (8.4 s calm).
 *   2. The end card holds for the host's answer, at most HOLD_MAX_MS, and
 *      never delays anything before it.
 *   3. Every ending: she is not there before the black lifts, she is fully
 *      herself by the end card, and the end card is what the wallpaper draws
 *      (the plain colour or her room, full screen) with no light, stars or
 *      glow left over it, so the window can step aside without a cut.
 *   4. A plain ending is never masked: the whole screen settles into the
 *      colour, no circle or edge.
 *   5. Reduced motion: the light stands still, nothing is masked or blurred.
 *   6. Deterministic: the same t gives the same frame.
 *   7. Captions (261106) sit above her head, never over her, and never rise
 *      into the corner label; text switches to day ink only where a light
 *      background (her room, the white plain one) is behind it, never over
 *      the black one.
 *   8. The climax (261106 v4): one swell up to a hard cut to black, a hold,
 *      then the black fades out as she comes in; no caption during the peak
 *      or the black; never more than one flash in any second; reduced
 *      motion has no peak and no cut (a gentle fade through black); a skip
 *      never rushes through it.
 */
import { describe, expect, it } from "vitest";
import { INTRO_END_ON } from "@shared/seilinkIntroTelemetry";
import {
  CALM_TIMELINE,
  FULL_TIMELINE,
  HOLD_MAX_MS,
  beatAt,
  beatProgress,
  skipFrom,
  timelineTime,
  type IntroTimeline,
} from "../../../lib/seilink/introTimeline";
import {
  FLOOD_MAX,
  INTRO_PALETTE,
  captionTop,
  computeFrame,
  dayInk,
  revealMask,
  roomBehind,
  type IntroFrame,
} from "./introFrame";

const W = 1920;
const H = 1080;

describe("timeline", () => {
  it("runs the beats in order and ends after the fade", () => {
    for (const tl of [FULL_TIMELINE, CALM_TIMELINE]) {
      const { tunnel, link, port, linked } = tl.beats;
      expect(tunnel).toBe(0);
      expect(link).toBeGreaterThan(tunnel);
      expect(port).toBeGreaterThan(link);
      expect(linked).toBeGreaterThan(port);
      expect(tl.fadeAt).toBeGreaterThan(linked);
      expect(tl.end).toBeGreaterThan(tl.fadeAt);
      expect(beatAt(tl, 0)).toBe("tunnel");
      expect(beatAt(tl, link)).toBe("link");
      expect(beatAt(tl, port + 1)).toBe("port");
      expect(beatAt(tl, tl.end)).toBe("linked");
    }
    expect(FULL_TIMELINE.end).toBeGreaterThanOrEqual(10_500);
    expect(FULL_TIMELINE.end).toBeLessThanOrEqual(12_000);
    expect(CALM_TIMELINE.end).toBeLessThan(FULL_TIMELINE.end);
  });

  it("beat progress runs 0..1", () => {
    expect(beatProgress(FULL_TIMELINE, 0, "tunnel")).toBe(0);
    expect(
      beatProgress(FULL_TIMELINE, FULL_TIMELINE.beats.link, "tunnel"),
    ).toBe(1);
    expect(
      beatProgress(FULL_TIMELINE, FULL_TIMELINE.beats.link + 1, "link"),
    ).toBeGreaterThan(0);
  });

  it("holds at the end card until the host answers, at most HOLD_MAX_MS", () => {
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

describe("frames", () => {
  for (const end of INTRO_END_ON) {
    describe(`ending on ${end}`, () => {
      const at = (t: number, reduced = false) =>
        computeFrame(
          reduced ? CALM_TIMELINE : FULL_TIMELINE,
          t,
          W,
          H,
          reduced,
          end,
        );

      it("she is not there before the black lifts and fully herself by the port beat", () => {
        const tl = FULL_TIMELINE;
        for (let t = 0; t <= tl.climax.lift; t += 50)
          expect(at(t).avatar.opacity).toBe(0);
        const f = at(tl.beats.port);
        expect(f.avatar.opacity).toBe(1);
        expect(f.avatar.filter).toBe("none");
        expect(f.avatar.rise).toBe(0);
      });

      it("the light and space wake first and the ending stays hidden until the port beat", () => {
        const tl = FULL_TIMELINE;
        expect(at(0).field.opacity).toBe(0);
        expect(at(1500).field.opacity).toBeGreaterThan(0.9);
        expect(at(2500).space).toBeGreaterThan(0.9);
        for (let t = 0; t <= tl.beats.port; t += 100)
          expect(at(t).room.opacity).toBe(0);
        const mid = at(tl.beats.port + 1200);
        if (end === "room") {
          expect(mid.room.opacity).toBe(1);
          expect(mid.room.reveal).toBeGreaterThan(0);
          expect(mid.room.reveal).toBeLessThan(1);
          expect(revealMask(mid, { x: W / 2, y: H / 2 })).toMatch(
            /^radial-gradient\(/,
          );
        } else {
          // The whole screen settles into the colour: partly there, never masked.
          expect(mid.room.opacity).toBeGreaterThan(0);
          expect(mid.room.opacity).toBeLessThan(1);
          expect(revealMask(mid, { x: W / 2, y: H / 2 })).toBe("none");
        }
      });

      it("ends on the wallpaper picture, full screen, with no light left over it", () => {
        const tl = FULL_TIMELINE;
        for (const t of [tl.beats.linked + 1600, tl.fadeAt, tl.end]) {
          const f = at(t);
          expect(f.room.opacity).toBe(1);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(revealMask(f, { x: 0, y: 0 })).toBe("none");
          expect(f.field.opacity).toBe(0);
          expect(f.space).toBe(0);
          expect(f.halo).toBe(0);
          expect(f.linkGlow).toBe(0);
          expect(f.room.flood).toBe(end === "plain_light" ? FLOOD_MAX : 0);
          expect(f.avatar).toEqual({ opacity: 1, filter: "none", rise: 0 });
          expect(f.black).toBe(0);
          expect(f.field.peak).toBe(0);
        }
      });

      it("breathes one soft glow around her when linked (none over the white ending)", () => {
        const K = FULL_TIMELINE.beats.linked;
        if (end === "plain_light") {
          for (let t = K; t < K + 1600; t += 50) expect(at(t).linkGlow).toBe(0);
          return;
        }
        expect(at(K - 10).linkGlow).toBe(0);
        expect(at(K + 800).linkGlow).toBeCloseTo(1, 5);
        expect(at(K + 400).linkGlow).toBeGreaterThan(0);
      });

      it("is deterministic", () => {
        for (const t of [0, 777, 1650, 3500, 5000, 6800, 8000, 9500])
          expect(at(t)).toEqual(at(t));
      });

      it("reduced motion: a still light, plain fades, nothing masked or blurred", () => {
        const tl = CALM_TIMELINE;
        for (let t = 0; t <= tl.end; t += 50) {
          const f = at(t, true);
          expect(f.field.clock).toBe(at(0, true).field.clock);
          expect(f.field.gather).toBe(0);
          expect(f.field.swell).toBe(0);
          expect(f.field.peak).toBe(0);
          expect(f.linkGlow).toBe(0);
          expect(f.room.reveal).toBeGreaterThanOrEqual(1);
          expect(f.avatar.filter).toBe("none");
          expect(f.avatar.rise).toBe(0);
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

  it("the palette is a dark sky with bright light (space, no pastel)", () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return (
        ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114
      );
    };
    for (const v of INTRO_PALETTE.void) expect(lum(v)).toBeLessThan(24);
    for (const c of INTRO_PALETTE.lights)
      expect(Math.max(...c)).toBeGreaterThanOrEqual(200);
  });
});

/** How bright the picture is, roughly (the light, its peak, under the black). */
function brightness(f: IntroFrame): number {
  return (
    (1 - f.black) *
    Math.max(f.field.opacity * (1 + 0.9 * f.field.peak), f.avatar.opacity * 0.6)
  );
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

describe("the climax (261106 v4)", () => {
  const tl = FULL_TIMELINE;
  const C = tl.climax;
  for (const end of INTRO_END_ON) {
    const at = (t: number) => computeFrame(tl, t, W, H, false, end);

    it(`${end}: one swell up to the cut, then black, held, fading out as she comes in`, () => {
      expect(C.build).toBeLessThan(C.peak);
      expect(C.peak).toBeLessThan(C.cut);
      expect(C.cut).toBe(tl.beats.link);
      expect(C.lift).toBeGreaterThan(C.cut);
      expect(C.clear).toBeGreaterThan(C.lift);
      // The peak only rises (never a flicker) and holds to the cut.
      let last = 0;
      for (let t = 0; t < C.cut; t += 10) {
        const p = at(t).field.peak;
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
        expect(at(t).black).toBe(0);
      }
      expect(at(C.peak).field.peak).toBe(1);
      expect(at(C.cut - 1).field.peak).toBe(1);
      // Brighter and faster at the peak.
      expect(brightness(at(C.cut - 1))).toBeGreaterThan(
        brightness(at(C.build)) * 1.6,
      );
      const speed = (t: number) => at(t + 10).field.clock - at(t).field.clock;
      expect(speed(C.peak)).toBeCloseTo(20, 5);
      expect(speed(500)).toBeCloseTo(10, 5);
      // The hard cut: one frame to full black, held.
      for (let t = C.cut; t <= C.lift; t += 10) {
        expect(at(t).black).toBe(1);
        expect(at(t).field.peak).toBe(0);
      }
      // The black only fades out from there, and she comes in while it does.
      let b = 1;
      for (let t = C.lift; t <= C.clear; t += 10) {
        const k = at(t).black;
        expect(k).toBeLessThanOrEqual(b);
        b = k;
      }
      expect(at(C.clear).black).toBe(0);
      const mid = at((C.lift + C.clear) / 2);
      expect(mid.black).toBeGreaterThan(0);
      expect(mid.black).toBeLessThan(1);
      expect(mid.avatar.opacity).toBeGreaterThan(0);
      expect(at(C.lift + 60).avatar.rise).toBeGreaterThan(0);
      for (let t = C.clear; t <= tl.end; t += 50) expect(at(t).black).toBe(0);
    });

    it(`${end}: no caption over the peak or the black`, () => {
      for (let t = tl.lineOut + 350; t <= C.lift; t += 10) {
        const f = at(t);
        expect(f.caption.block).toBe(0);
        expect(f.brand).toBe(0);
      }
      // Wherever the light is near its peak, the captions are gone.
      for (let t = 0; t < C.cut; t += 10) {
        const f = at(t);
        if (f.field.peak >= 0.75)
          expect(f.caption.block * f.caption.line).toBe(0);
      }
      // The first line was up before it left, and the next comes once the black has lifted.
      expect(
        at(tl.lineOut - 10).caption.line * at(tl.lineOut - 10).caption.block,
      ).toBe(1);
      expect(at(tl.lineAt.link).beat).toBe("link");
      expect(tl.lineAt.link).toBeGreaterThan(C.lift);
      expect(
        at(C.clear + 200).caption.line * at(C.clear + 200).caption.block,
      ).toBeGreaterThan(0.9);
    });

    it(`${end}: never more than one flash in any second`, () => {
      const step = 10;
      const vals: number[] = [];
      for (let t = 0; t <= tl.end; t += step) vals.push(brightness(at(t)));
      const rev = reversals(vals).map((i) => i * step);
      // A flash is a pair of opposing changes: at most 2 direction changes in any 1 s.
      for (const r of rev)
        expect(
          rev.filter((x) => x >= r && x < r + 1000).length,
        ).toBeLessThanOrEqual(2);
    });
  }

  it("reduced motion: no peak and no cut, a gentle fade through black", () => {
    const calm = CALM_TIMELINE;
    const at = (t: number) => computeFrame(calm, t, W, H, true, "plain_dark");
    let prev = at(0);
    for (let t = 33; t <= calm.end; t += 33) {
      const f = at(t);
      expect(f.field.peak).toBe(0);
      // No step bigger than a fade of about a second allows in one 30 fps frame (the full cut is a step of 1).
      expect(Math.abs(f.black - prev.black)).toBeLessThan(0.12);
      expect(Math.abs(brightness(f) - brightness(prev))).toBeLessThan(0.12);
      prev = f;
    }
    expect(at(calm.climax.cut).black).toBe(1);
    expect(at(calm.climax.clear).black).toBe(0);
    expect(at(calm.climax.lift).avatar.opacity).toBe(0);
    expect(at(calm.climax.clear + 300).avatar.opacity).toBeGreaterThan(0.9);
    for (let t = calm.lineOut + 350; t <= calm.climax.lift; t += 10)
      expect(at(t).caption.block).toBe(0);
  });

  it("a skip never rushes through the climax or the black", () => {
    for (const t of [0, 1000, C.build, C.peak, C.cut, C.lift, C.clear - 1])
      expect(skipFrom(tl, t)).toBe(C.clear);
    for (const t of [C.clear, tl.beats.port, tl.fadeAt])
      expect(skipFrom(tl, t)).toBe(t);
  });

  it("keeps the whole intro about as long as before (11.2 s then)", () => {
    const len = (x: IntroTimeline) => x.end;
    expect(len(FULL_TIMELINE)).toBeGreaterThanOrEqual(11_000);
    expect(len(FULL_TIMELINE)).toBeLessThanOrEqual(11_800);
  });
});

describe("captions", () => {
  // Her box at 1920x1080 in the cozy room: top at half the height.
  const her = { x: 773, y: 540, w: 405, h: 540 };

  it("sit above her head with a gap", () => {
    const top = captionTop(H, 110, her);
    expect(top + 110).toBeLessThanOrEqual(her.y - 24);
    expect(top).toBeGreaterThanOrEqual(64);
  });

  it("move up when her head is close, never into the corner label", () => {
    const near = { ...her, y: 300 };
    expect(captionTop(H, 110, near) + 110).toBeLessThanOrEqual(300 - 24);
    expect(captionTop(400, 300, { ...her, y: 120 })).toBe(64);
  });

  it("use the default place before she has a size", () => {
    expect(captionTop(H, 110, null)).toBeCloseTo(H * 0.15);
  });

  it("turn to day ink only where her room shows", () => {
    const at = (t: number) =>
      computeFrame(FULL_TIMELINE, t, W, H, false, "room");
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    expect(
      dayInk(roomBehind(at(FULL_TIMELINE.beats.link + 500), centre, above)),
    ).toBe(0);
    expect(
      dayInk(roomBehind(at(FULL_TIMELINE.beats.linked + 600), centre, above)),
    ).toBe(1);
    // While the circle opens, a point near her is in the room before a far corner is.
    let near = 0;
    let far = 0;
    for (
      let t = FULL_TIMELINE.beats.port;
      t < FULL_TIMELINE.beats.linked;
      t += 50
    ) {
      const f = at(t);
      if (!near && roomBehind(f, centre, above) >= 1) near = t;
      if (!far && roomBehind(f, centre, { x: 40, y: 30 }) >= 1) far = t;
    }
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it("follow the crossfade under reduced motion", () => {
    const centre = { x: W / 2, y: H * 0.7 };
    const p = { x: 40, y: 30 };
    const { port } = CALM_TIMELINE.beats;
    for (const end of ["room", "plain_light"] as const) {
      expect(
        roomBehind(
          computeFrame(CALM_TIMELINE, port - 100, W, H, true, end),
          centre,
          p,
        ),
      ).toBe(0);
      expect(
        roomBehind(
          computeFrame(CALM_TIMELINE, port + 1300, W, H, true, end),
          centre,
          p,
        ),
      ).toBe(1);
    }
  });

  it("go to day ink over the white plain background, never over the black one", () => {
    const centre = { x: W / 2, y: H * 0.7 };
    const above = { x: W / 2, y: H * 0.17 };
    const t = FULL_TIMELINE.beats.linked + 600;
    expect(
      dayInk(
        roomBehind(
          computeFrame(FULL_TIMELINE, t, W, H, false, "plain_light"),
          centre,
          above,
        ),
      ),
    ).toBe(1);
    expect(
      dayInk(
        roomBehind(
          computeFrame(FULL_TIMELINE, t, W, H, false, "plain_dark"),
          centre,
          above,
        ),
      ),
    ).toBe(0);
  });
});
