/**
 * One frame of the first-link intro, as plain numbers and CSS strings:
 * computeFrame(times, t, W, H, reduced, end, tone) is pure, so a seek redraws
 * exactly the same picture (the video harness depends on it) and the view
 * just writes the result to the DOM and the light canvases (introFx.ts).
 *
 * The light is the aurora (261106, product feedback: "the aurora is pretty creative ...
 * make the colors more space themed. Think interstellar scifi and no man's
 * sky"): curtains of soft light sway across deep space. Space depth comes
 * from a faint, very soft starfield and a nebula haze. One palette, eclipse
 * (261106 v4, the pick of the three moods): gold light and blue-white
 * rims against violet and teal nebula.
 *
 * 261106 v6, the WorldLink status lines (product feedback (261106)): the
 * intro opens out of the solid colour; the nine status lines run one at a
 * time, centred, over the light (`times.lines`, lib/seilink/worldLink.ts).
 * v7 (product feedback (261106)): the aurora is built line by line: each
 * line adds one wave (`waves`, WAVES of them, spread over the whole height)
 * and a step of brightness and speed (`field.energy`), both eased over
 * STEP_MS, so line 1 is one faint wave and line 9 the full aurora. Under
 * the last line the light builds to the climax and expands until the
 * screen is one solid colour (in light mode it blooms into white, in dark
 * mode it expands and dims into black). The success line lands on the
 * solid and the light never comes back: the line holds about 2 s and fades
 * out, then she fades in slowly on the solid (the solid fades off her and
 * her place, which was laid in under it), and the last frame is exactly
 * what the wallpaper shows (linked). She is never there before the success
 * line. A failure keeps the light (calming down) with the failure line and
 * no her. A skip before the success line crossfades into the solid (no
 * peak) and plays her entrance from there.
 *
 * The solid (`solid`, `tone`) is the theme's colour, the same as the plain
 * background (PLAIN_COLOURS): light mode never goes black, dark mode never
 * goes white. Nothing is a cut: every layer comes and goes by smoothstep
 * fades, so no frame jumps.
 * Reduced motion: no peak and no build, a still, dimmer aurora with every
 * wave, plain crossfades through the solid.
 *
 * How it ends (`end`): she comes in on her place, the plain background she
 * spawns on (`plain_dark` black, `plain_light` white, with the OS theme) or
 * (`room`, a replay over a room she already has) her room, full screen.
 *
 * No grids, scanlines, rings, slices or hard edges: every shape is a gradient.
 */
import type { IntroBeat, IntroEndOn } from '@shared/seilinkIntroTelemetry';
import { CAPTION_GAP_MS, CAPTION_IN_MS, CAPTION_OUT_MS, OPEN_MS, TEXT_OUT_MS, beatAt, ease, softIntegral, span, type IntroTimes } from '../../../lib/seilink/introTimeline';
import type { PlainTone } from '../../../lib/seilink/plainTone';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a caption shows: a status line (0..8), the success line or the failure line. */
export type CaptionId = number | 'success' | 'fail';

export interface IntroFrame {
  t: number;
  beat: IntroBeat;
  W: number;
  H: number;
  reduced: boolean;
  end: IntroEndOn;
  /** The theme: the solid's colour (white in light mode, black in dark mode, as the plain background). */
  tone: PlainTone;
  /** The light field (introFx). */
  field: {
    /** 0..1 how much of it shows. */
    opacity: number;
    /** Motion clock, ms (still under reduced motion; runs faster with each line and into the peak). */
    clock: number;
    /** 0..1 the climax: brighter, fuller, wider light, one rise held until the solid covers it (0 under reduced motion). */
    peak: number;
    /** 0..1 past the peak, how far the climax's bloom has expanded toward filling the screen (0 under reduced motion). */
    fill: number;
    /** 0..1 how far the status lines have built the light up (a step per line); it calms after the solid or a failure. */
    energy: number;
  };
  /**
   * 0..1 each aurora wave (one per status line, WAVES of them): a line adds
   * its wave, eased in over STEP_MS (all of them, still, under reduced motion).
   */
  waves: number[];
  /** 0..1 the starfield and haze (space behind the light). */
  space: number;
  /**
   * 0..1 the solid colour (`tone`) over the whole picture (not the HUD): the
   * intro opens out of it, the climax fills the screen with it, it holds
   * under the success line, then fades off her and her place as she comes in.
   */
  solid: number;
  /**
   * What she ends on: `opacity` of the plain colour or of her room's canvases
   * (she is not in them; laid in under the full solid after the success
   * line), `reveal` the radius of the soft circle a room opens in around her,
   * as a fraction of the screen's diagonal (>= 1 = no mask, which is how
   * this intro always shows it).
   */
  room: { opacity: number; reveal: number };
  /** `rise`: px she still sits below her place as she comes in (0 once in, always 0 under reduced motion). */
  avatar: { opacity: number; filter: string; rise: number };
  /**
   * Captions, one line at a time: `cur` fades up (`curIn`) a moment after
   * the line before it (`prev`) starts to fade out (`prevOut`, 1 = still
   * fully there), in the same place. `block` is the whole caption area.
   * `curAge`: ms since `cur` started (its typing runs on it, lib/seilink/typing.ts);
   * `prevAge`: how old `prev` was when `cur` started (its letters and dots stay as they were then).
   */
  caption: { block: number; cur: CaptionId | null; curIn: number; curAge: number; prev: CaptionId | null; prevOut: number; prevAge: number };
}

type RGB = [number, number, number];

export interface IntroPalette {
  /** Deep space behind the light, centre to edge. */
  void: [string, string];
  /** The curtains' colours, one per curtain (four). */
  lights: [RGB, RGB, RGB, RGB];
  /** The nebula haze, two soft clouds. */
  haze: [RGB, RGB];
  /** Star colour. */
  star: RGB;
  /** The peak's bloom. */
  halo: RGB;
}

/** Eclipse: gold light and blue-white rims against violet and teal nebula, kept soft and luminous. */
export const INTRO_PALETTE: IntroPalette = {
  void: ['#0a0a1e', '#010106'],
  lights: [
    [255, 188, 104],
    [124, 172, 255],
    [186, 110, 255],
    [64, 220, 226],
  ],
  haze: [
    [84, 40, 130],
    [20, 64, 92],
  ],
  star: [222, 230, 255],
  halo: [214, 200, 255],
};


/** Into the peak the light runs up to this much faster (2x at the peak). */
export const PEAK_SPEEDUP = 1;
/** With all the lines up (energy 1) the light runs this much faster. */
export const ENERGY_SPEEDUP = 0.6;
/** Each status line's step of energy (and its wave) eases in over this long. */
export const STEP_MS = 1200;
/** The aurora's waves: one per status line. */
export const WAVES = 9;
/** Reduced motion: no build, a still aurora at this (dimmer) energy. */
export const REDUCED_ENERGY = 0.4;
/** Behind the solid, the light fades out over this long once the screen is solid (it does not come back). */
const LIGHT_OUT_MS = 800;
/** Her place (the plain colour or her room) is laid in under the full solid over this long, from the success line. */
const PLACE_IN_MS = 1000;
/** She is put in under the solid over this long from `lift`; what shows is the solid fading off her. */
const HER_IN_MS = 700;
/** After the solid the light settles back this far (to 60%); after a failure further (to 35%), over FAIL_CALM_MS. */
const SETTLE_DROP = 0.4;
const FAIL_DROP = 0.65;
const FAIL_CALM_MS = 3000;

/** The energy the lines have built at t (each line adds a ninth, eased in). */
function linesEnergy(lines: readonly number[], t: number): number {
  let e = 0;
  for (const s of lines) e += ease.soft(span(t, s, s + STEP_MS)) / 9;
  return e;
}

function linesEnergyIntegral(lines: readonly number[], t: number): number {
  let e = 0;
  for (const s of lines) e += softIntegral(t, s, STEP_MS) / 9;
  return e;
}

/** When and how far the energy calms: after the solid fills (she comes in on settled light), or after a failure. */
function calming(times: IntroTimes): { at: number; d: number; drop: number } | null {
  if (times.fail !== null) return { at: times.fail, d: FAIL_CALM_MS, drop: FAIL_DROP };
  if (times.climax && times.after) return { at: times.climax.fill, d: Math.max(1, times.after.lift - times.climax.fill), drop: SETTLE_DROP };
  return null;
}

function energyAt(times: IntroTimes, t: number): number {
  const e = linesEnergy(times.lines, t);
  const c = calming(times);
  return c ? e * (1 - c.drop * ease.soft(span(t, c.at, c.at + c.d))) : e;
}

/** The integral of the energy over [0, t] (the clock's extra speed from the lines). Every step is done by the time it calms. */
function energyIntegral(times: IntroTimes, t: number): number {
  const c = calming(times);
  if (!c || t <= c.at) return linesEnergyIntegral(times.lines, t);
  const e0 = linesEnergy(times.lines, c.at);
  return linesEnergyIntegral(times.lines, c.at) + e0 * (t - c.at - c.drop * softIntegral(t, c.at, c.d));
}

/** The motion clock: real time, plus the extra the lines add (each a step faster), plus the climax's (smoothly faster into the peak, then steady). */
function motionClock(times: IntroTimes, t: number): number {
  let extra = ENERGY_SPEEDUP * energyIntegral(times, t);
  const C = times.climax;
  if (C && !C.calm && t > C.build) {
    const d = Math.max(1, C.peak - C.build);
    const u = Math.min(t, C.fill);
    // Speed rises as s^2 across the build (s = 0..1), so the clock gains d*s^3/3, then the full speedup until the screen is solid.
    const s = Math.min(1, (u - C.build) / d);
    extra += PEAK_SPEEDUP * (d * (s * s * s) / 3 + Math.max(0, u - C.peak));
  }
  return t + extra;
}

/** The caption at t: the newest entry that has started, and the one before it. */
function captionAt(times: IntroTimes, t: number): IntroFrame['caption'] {
  const entries: Array<[number, CaptionId]> = times.lines.map((s, i) => [s, i]);
  if (times.success !== null) entries.push([times.success, 'success']);
  if (times.fail !== null) entries.push([times.fail, 'fail']);
  let k = -1;
  for (let i = 0; i < entries.length; i++) if (entries[i][0] <= t) k = i;
  // The whole caption goes on a skip, and after the success line has held (it fades out before she comes in).
  const skipOut = times.skip === null ? 1 : 1 - ease.inOut(span(t, times.skip, times.skip + 400));
  const A = times.after;
  const textOut = times.success !== null && A ? 1 - ease.inOut(span(t, A.textOut, A.textOut + TEXT_OUT_MS)) : 1;
  const block = skipOut * textOut;
  if (k < 0) return { block, cur: null, curIn: 0, curAge: 0, prev: null, prevOut: 0, prevAge: 0 };
  const [s, cur] = entries[k];
  return {
    block,
    cur,
    curIn: ease.out(span(t, s + CAPTION_GAP_MS, s + CAPTION_GAP_MS + CAPTION_IN_MS)),
    curAge: t - s,
    prev: k > 0 ? entries[k - 1][1] : null,
    prevOut: k > 0 ? 1 - ease.inOut(span(t, s, s + CAPTION_OUT_MS)) : 0,
    prevAge: k > 0 ? s - entries[k - 1][0] : 0,
  };
}

export function computeFrame(
  times: IntroTimes,
  t: number,
  W: number,
  H: number,
  reduced: boolean,
  end: IntroEndOn = 'plain_dark',
  tone: PlainTone = end === 'plain_light' ? 'light' : 'dark',
): IntroFrame {
  const C = times.climax;
  const A = times.after;
  const L = A?.lift ?? Infinity;
  // The solid: the intro opens out of it, the climax fills the screen with it (a crossfade when calm), it holds under the success line, then fades off her and her place.
  const open = 1 - ease.soft(span(t, 0, OPEN_MS));
  const solid =
    !C || !A || t < C.build
      ? open
      : t < C.fill
        ? Math.max(open, ease.soft(span(t, C.calm ? C.build : C.dim, C.fill)))
        : 1 - ease.soft(span(t, L, A.clear));
  const caption = captionAt(times, t);
  const energy = energyAt(times, t);
  const base: IntroFrame = {
    t,
    beat: beatAt(times, t),
    W,
    H,
    reduced,
    end,
    tone,
    field: { opacity: 0, clock: t, peak: 0, fill: 0, energy },
    waves: Array.from({ length: WAVES }, (_, i) => (reduced ? 1 : i < times.lines.length ? ease.soft(span(t, times.lines[i], times.lines[i] + STEP_MS)) : 0)),
    space: 0,
    solid,
    room: { opacity: 0, reveal: 0 },
    avatar: { opacity: 0, filter: 'none', rise: 0 },
    caption,
  };

  // Once the screen is solid the light fades out behind it and does not come back; her place is laid in under it.
  const out = C && A ? 1 - ease.soft(span(t, C.fill, C.fill + LIGHT_OUT_MS)) : 1;
  if (A) {
    base.room.opacity = ease.soft(span(t, A.success, A.success + PLACE_IN_MS));
    base.room.reveal = 1.2;
    // Put in under the full solid; what shows is the solid fading off her (lift..clear).
    base.avatar.opacity = ease.soft(span(t, L, L + HER_IN_MS));
  }

  if (reduced) {
    // Calm: a still, dimmer aurora (no build), plain crossfades through the solid, she fades in as it clears.
    base.field.clock = 2400;
    base.field.energy = REDUCED_ENERGY;
    base.field.opacity = ease.soft(span(t, 0, 1200)) * out;
    base.space = base.field.opacity;
    return base;
  }

  // The light wakes and builds with the lines to the peak, filling the screen; then it is gone behind the solid.
  base.field.opacity = ease.inOut(span(t, 0, 1200)) * out;
  base.field.clock = motionClock(times, t);
  // One swell: it only rises (eased) up to the peak, then the bloom expands on until the solid covers it all.
  if (C && !C.calm && t < C.fill) {
    base.field.peak = ease.soft(span(t, C.build, C.peak));
    base.field.fill = ease.soft(span(t, C.peak, C.fill));
  }
  // Space (stars, haze) comes up a little behind the light.
  base.space = ease.inOut(span(t, 200, 1800)) * out;
  if (!C || !A) return base;

  // She comes in as the solid fades off her: rising a touch into place, soft first, then sharp.
  const q = ease.inOut(span(t, L, A.clear));
  base.avatar.rise = H * 0.02 * (1 - ease.out(span(t, L, A.clear)));
  if (q < 0.999) {
    const r = 1 - q;
    base.avatar.filter = `brightness(${(1 + 0.35 * r).toFixed(3)}) blur(${(4 * r).toFixed(2)}px)`;
  }
  return base;
}

/** The soft circle her room opens in: a CSS radial mask around her, or 'none' once it is fully open. */
export function revealMask(f: IntroFrame, center: { x: number; y: number }): string {
  if (f.room.reveal >= 1) return 'none';
  const diag = Math.hypot(f.W, f.H);
  const r = Math.max(0, f.room.reveal * diag);
  if (r < 1) return 'linear-gradient(transparent, transparent)';
  const soft = Math.max(80, diag * 0.16);
  const inner = Math.max(0, r - soft);
  const mid = inner + (r - inner) * 0.55;
  return `radial-gradient(circle at ${center.x.toFixed(1)}px ${center.y.toFixed(1)}px, #000 ${inner.toFixed(1)}px, rgba(0,0,0,0.55) ${mid.toFixed(1)}px, transparent ${r.toFixed(1)}px)`;
}

/**
 * 0..1 how much LIGHT background shows at screen point `p` (root px): her
 * room in the same soft circle as revealMask around `centre`, or the white
 * plain background, times its opacity, under the white solid (light mode).
 * The black plain background and the black solid are not light, so they
 * count 0. The HUD text switches from night ink to day ink by
 * it, each piece where it sits, so it never turns dark over the light.
 */
export function roomBehind(f: IntroFrame, centre: { x: number; y: number }, p: { x: number; y: number }): number {
  // The solid covers everything: white (light mode) is a light background, black (dark mode) a dark one.
  const white = f.tone === 'light' ? f.solid : 0;
  const under = sceneBehind(f, centre, p);
  return white + (1 - f.solid) * under;
}

function sceneBehind(f: IntroFrame, centre: { x: number; y: number }, p: { x: number; y: number }): number {
  if (f.end === 'plain_dark') return 0;
  if (f.end === 'plain_light') return f.room.opacity;
  if (f.room.opacity <= 0) return 0;
  if (f.room.reveal >= 1) return f.room.opacity;
  const diag = Math.hypot(f.W, f.H);
  const r = Math.max(0, f.room.reveal * diag);
  if (r < 1) return 0;
  const inner = Math.max(0, r - Math.max(80, diag * 0.16));
  const d = Math.hypot(p.x - centre.x, p.y - centre.y);
  const open = d <= inner ? 1 : d >= r ? 0 : 1 - (d - inner) / (r - inner);
  return f.room.opacity * open;
}

/** Text over this much of a light background is in day ink, under the low end night ink (0..1, eased between). */
export function dayInk(behind: number): number {
  const x = Math.min(1, Math.max(0, (behind - 0.25) / 0.5));
  return x * x * (3 - 2 * x);
}

/**
 * The caption block's top, px: centred on the screen (product feedback
 * (261106)). She is never on screen with a status line (she comes in after
 * the success line has faded), so nothing has to make room for her.
 */
export function captionTop(H: number, captionH: number): number {
  return Math.max(0, (H - captionH) / 2);
}
