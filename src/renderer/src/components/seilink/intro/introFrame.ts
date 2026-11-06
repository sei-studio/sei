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
 * time over the light (`times.lines`, lib/seilink/worldLink.ts), each one a
 * step brighter, longer and faster (`field.energy`, eased over STEP_MS, so
 * no step is a jump); under the last line the light builds to the climax
 * and expands until the screen is one solid colour (v5's climax: in light
 * mode it blooms into white, in dark mode it expands and dims into black);
 * the success line lands on the solid; only after it does the solid fade
 * back into the scene as she fades and rises in (link), the light settles
 * into the plain colour or her room opens (port), and the last frame is
 * exactly what the wallpaper shows (linked). She is never there before the
 * success line. A failure keeps the light (calming down) with the failure
 * line and no her. A skip before the success line crossfades into the solid
 * (no peak) and plays her entrance from there.
 *
 * The solid (`solid`, `tone`) is the theme's colour, the same as the plain
 * background (PLAIN_COLOURS): light mode never goes black, dark mode never
 * goes white. Nothing is a cut: the solid, the plain colour and her room all
 * come and go by smoothstep fades of a second or more, so no frame jumps.
 * Reduced motion: no peak and no bloom, a still field whose brightness
 * steps by crossfades, plain crossfades through the solid.
 *
 * How it ends (`end`, first-link v3): on the plain background she spawns on
 * (`plain_dark` black, `plain_light` white, with the OS theme): the light
 * expands out from behind her (`bloom`) and the whole screen settles into
 * that colour, no shape or edge (into white it floods up to white; into
 * black it swells a little and dims).
 * `room` (a replay over a room she already has): her room opens in a wide,
 * feathered circle around her as before.
 *
 * No grids, scanlines, rings, slices or hard edges: every shape is a gradient.
 */
import type { IntroBeat, IntroEndOn } from '@shared/seilinkIntroTelemetry';
import { CAPTION_GAP_MS, CAPTION_IN_MS, CAPTION_OUT_MS, OPEN_MS, beatAt, ease, softIntegral, span, type IntroTimes } from '../../../lib/seilink/introTimeline';
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
    /** 0..1 how far it has gathered in on her (link). */
    gather: number;
    /** Motion clock, ms (still under reduced motion; runs faster with each line and into the peak). */
    clock: number;
    /** 0..1 extra brightness (the swell as she forms). */
    swell: number;
    /** 0..1 the climax: brighter, fuller, wider light, one rise held until the solid covers it (0 under reduced motion). */
    peak: number;
    /** 0..1 past the peak, how far the climax's bloom has expanded toward filling the screen (0 under reduced motion). */
    fill: number;
    /** 0..1 how far the status lines have built the light up (a step per line); it calms after the solid or a failure. */
    energy: number;
  };
  /** 0..1 the starfield and haze (space behind the light). */
  space: number;
  /**
   * 0..1 the solid colour (`tone`) over the whole picture (not the HUD): the
   * intro opens out of it, the climax fills the screen with it, it holds
   * under the success line, then fades back into the scene as she comes in.
   */
  solid: number;
  /** The ending's light expanding out from behind her (plain endings): `r` 0..1 how far it has spread, `a` 0..1 how bright it is. */
  bloom: { r: number; a: number };
  /**
   * What she ends on: `opacity` of the plain colour or of her room's canvases
   * (she is not in them), `reveal` the radius of the soft circle a room opens
   * in around her, as a fraction of the screen's diagonal (>= 1 = no mask; a
   * plain ending is never masked). `flood` (white ending only): 0..1 how far
   * the light has flooded toward white before the colour covers it (a
   * colour-dodge layer, so the bright light goes white first and the dark
   * last, instead of the whole picture greying through the crossfade).
   */
  room: { opacity: number; reveal: number; flood: number };
  /** `rise`: px she still sits below her place as she comes in (0 once in, always 0 under reduced motion). */
  avatar: { opacity: number; filter: string; rise: number };
  /** 0..1 the soft glow behind and around her. */
  halo: number;
  /** 0..1 a soft breath of light around her when linked (a glow, no ring; none over the white ending, where a glow only greys it). */
  linkGlow: number;
  brand: number;
  /**
   * Captions, one line at a time: `cur` fades up (`curIn`) a moment after
   * the line before it (`prev`) starts to fade out (`prevOut`, 1 = still
   * fully there), in the same place. `block` is the whole caption area.
   */
  caption: { block: number; cur: CaptionId | null; curIn: number; prev: CaptionId | null; prevOut: number };
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
  /** Her halo, the swell and the peak's bloom. */
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

/**
 * How far the white ending's flood goes (a colour-dodge by this grey: the
 * picture brightens about 2x, the brights reach white). Further, the dodge
 * would blow the soft light's 8-bit steps up into visible blocks.
 */
export const FLOOD_MAX = 0.55;


/** Into the peak the light runs up to this much faster (2x at the peak). */
export const PEAK_SPEEDUP = 1;
/** With all the lines up (energy 1) the light runs this much faster. */
export const ENERGY_SPEEDUP = 0.6;
/** Each status line's step of energy eases in over this long. */
export const STEP_MS = 1400;
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
  const block = times.skip === null ? 1 : 1 - ease.inOut(span(t, times.skip, times.skip + 400));
  if (k < 0) return { block, cur: null, curIn: 0, prev: null, prevOut: 0 };
  const [s, cur] = entries[k];
  return {
    block,
    cur,
    curIn: ease.out(span(t, s + CAPTION_GAP_MS, s + CAPTION_GAP_MS + CAPTION_IN_MS)),
    prev: k > 0 ? entries[k - 1][1] : null,
    prevOut: k > 0 ? 1 - ease.inOut(span(t, s, s + CAPTION_OUT_MS)) : 0,
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
  const P = A?.port ?? Infinity;
  const K = A?.linked ?? Infinity;
  const plain = end !== 'room';
  // The solid: the intro opens out of it, the climax fills the screen with it (a crossfade when calm), it holds under the success line, then fades back into the scene.
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
    field: { opacity: 0, gather: 0, clock: t, swell: 0, peak: 0, fill: 0, energy },
    space: 0,
    solid,
    bloom: { r: 0, a: 0 },
    room: { opacity: 0, reveal: 0, flood: 0 },
    avatar: { opacity: 0, filter: 'none', rise: 0 },
    halo: 0,
    linkGlow: 0,
    brand: ease.out(span(t, 100, 800)) * caption.block,
    caption,
  };

  if (reduced) {
    // Calm: the field fades in still and brightens by crossfades with the lines, crossfades through the solid, she fades in as it clears, her place fades in as the field fades out.
    const settle = A ? ease.soft(span(t, P, P + 1800)) : 0;
    base.field.clock = 2400;
    base.field.opacity = ease.soft(span(t, 0, 1200)) * (1 - settle);
    base.space = base.field.opacity;
    if (A) {
      base.avatar.opacity = ease.inOut(span(t, L + 100, A.clear + 200));
      base.halo = 0.6 * base.avatar.opacity * (1 - settle);
      base.room.opacity = settle;
    }
    base.room.reveal = 1.2;
    return base;
  }

  // The light wakes, builds with the lines to the peak and fills the screen; behind the solid it is settled again, and it fades as her place opens.
  const wake = ease.inOut(span(t, 0, 1200));
  // (No after yet, or a failure: nothing settles. Guarded, since span over Infinity is NaN.)
  const fade = A ? ease.inOut(span(t, P + 300, P + 2300)) : 0;
  base.field.opacity = wake * (1 - fade);
  base.field.clock = motionClock(times, t);
  // One swell: it only rises (eased) up to the peak, then the bloom expands on until the solid covers it all.
  if (C && !C.calm && t < C.fill) {
    base.field.peak = ease.soft(span(t, C.build, C.peak));
    base.field.fill = ease.soft(span(t, C.peak, C.fill));
  }
  // Space (stars, haze) comes up a little behind the light and lingers a moment longer.
  base.space = ease.inOut(span(t, 200, 1800)) * (A ? 1 - ease.inOut(span(t, P + 500, P + 2500)) : 1);
  if (!C || !A) return base;

  // After the solid the curtains lean in toward her as she comes in, then lift away.
  base.field.gather = (t < C.fill ? 0 : ease.inOut(span(t, C.fill, L + 1800))) * (1 - ease.inOut(span(t, P, P + 1800)));
  // Softer than the climax (0.6): the peak stays the brightest moment.
  base.field.swell = 0.6 * span(t, L + 200, L + 1100) * (1 - span(t, L + 1500, P + 600));

  // She comes in as the solid fades (never before the success line): rising a little into place, bright, soft and glowing first, then herself.
  const q = ease.inOut(span(t, L + 100, L + 1500));
  base.avatar.opacity = ease.out(span(t, L + 50, L + 1000));
  base.avatar.rise = H * 0.035 * (1 - ease.out(span(t, L + 50, L + 1400)));
  if (q < 0.999) {
    const r = 1 - q;
    base.avatar.filter =
      `brightness(${(1 + 1.4 * r).toFixed(3)}) saturate(${(0.55 + 0.45 * q).toFixed(3)}) blur(${(6 * r).toFixed(2)}px) ` +
      `drop-shadow(0 0 ${(26 * r).toFixed(1)}px rgba(255, 255, 255, ${(0.85 * r).toFixed(3)}))`;
  }
  base.halo = span(t, L + 100, L + 1100) * (1 - 0.65 * span(t, P + 200, P + 2000)) * (1 - span(t, K, K + 900));

  if (plain) {
    // The light expands out from behind her and the whole screen settles into the plain colour: no circle, no edge.
    // Into white, the light floods first (the brights go white, then the rest) and the white comes over it; into black it swells a little and dims.
    base.bloom.r = ease.soft(span(t, P, P + 2200));
    if (end === 'plain_light') {
      base.bloom.a = ease.soft(span(t, P, P + 1400)) * (1 - span(t, P + 2500, P + 2700));
      // The dodge brightens faster as it grows, so the flood and the white start early and run long (no steep middle).
      base.room.flood = FLOOD_MAX * ease.soft(span(t, P, P + 2300));
      base.room.opacity = ease.soft(span(t, P + 100, P + 2500));
    } else {
      base.bloom.a = ease.soft(span(t, P, P + 1000)) * (1 - ease.soft(span(t, P + 1200, P + 2500)));
      base.room.opacity = ease.soft(span(t, P + 400, P + 2500));
    }
    base.room.reveal = 1.2;
  } else {
    // Her room opens out around her in a soft circle.
    const o = ease.inOut(span(t, P + 150, P + 2300));
    base.room.opacity = o > 0 ? 1 : 0;
    base.room.reveal = o >= 1 ? 1.2 : o * 1.15;
  }
  // Linked: one soft breath of light around her (a glow that swells and fades).
  if (end !== 'plain_light') base.linkGlow = Math.sin(Math.PI * span(t, K, K + 1600)) * (t >= K && t < K + 1600 ? 1 : 0);
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
  // The white solid (light mode) is a light background over everything.
  const white = f.tone === 'light' ? f.solid : 0;
  const under = sceneBehind(f, centre, p);
  return white + (1 - white) * under;
}

function sceneBehind(f: IntroFrame, centre: { x: number; y: number }, p: { x: number; y: number }): number {
  if (f.end === 'plain_dark') return 0;
  // Into white: the flood brightens the picture before the white comes over it.
  if (f.end === 'plain_light') return f.room.opacity + (1 - f.room.opacity) * f.room.flood * 0.7;
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

/** The caption's top never rises above this, px: it stays clear of the WORLDLINK corner label. */
const CAPTION_TOP_MIN = 64;

/**
 * The caption block's top, px (261106: captions over her chest were hard to
 * read). It sits in the empty space above her head, about a sixth of the way
 * down, and moves up when her head comes closer than `gap` (a short window,
 * a bigger her), never into the corner label.
 */
export function captionTop(H: number, captionH: number, her: Box | null): number {
  const ideal = Math.max(CAPTION_TOP_MIN, H * 0.15);
  if (!her) return ideal;
  const gap = Math.max(24, H * 0.04);
  return Math.max(CAPTION_TOP_MIN, Math.min(ideal, her.y - gap - captionH));
}
