/**
 * One frame of the first-link intro, as plain numbers and CSS strings:
 * computeFrame(timeline, t, W, H, reduced, end) is pure, so a seek redraws
 * exactly the same picture (the video harness depends on it) and the view
 * just writes the result to the DOM and the light canvases (introFx.ts).
 *
 * The light is the aurora (261106, product feedback: "the aurora is pretty creative ...
 * make the colors more space themed. Think interstellar scifi and no man's
 * sky"): curtains of soft light sway across deep space. Space depth comes
 * from a faint, very soft starfield and a nebula haze. One palette, eclipse
 * (261106 v4, Shawn's pick of the three moods): gold light and blue-white
 * rims against violet and teal nebula.
 *
 * Beats (261106 v5, the climax, product feedback: "fade to black not hard cut, like the
 * light expands until fully bright or dark depending on dark or light theme.
 * Same goes for the blank background afterwards"): tunnel (the light wakes
 * out of the solid colour, builds to a peak: brighter, fuller, faster,
 * filling the screen, then keeps expanding until the screen is one solid
 * colour: in light mode it blooms on into white, in dark mode it expands and
 * dims into black), link (a short hold on the solid, then it fades back into
 * the scene as she fades and rises in, the light settled again behind her),
 * port (the light expands around her once more and settles into the plain
 * colour, or her room opens), linked (the end card; the last frame is
 * exactly what the wallpaper shows).
 *
 * The solid (`solid`, `tone`) is the theme's colour, the same as the plain
 * background (PLAIN_COLOURS): light mode never goes black, dark mode never
 * goes white. Nothing is a cut: the solid, the plain colour and her room all
 * come and go by smoothstep fades of a second or more, so no frame jumps.
 * The brightness turns at most twice in any second (a test caps it).
 * Reduced motion: no peak and no bloom, plain crossfades through the solid
 * on the calm timeline and a still field.
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
import { CAPTION_IN_MS, CAPTION_OUT_MS, OPEN_MS, beatAt, beatProgress, ease, span, type IntroTimeline } from '../../../lib/seilink/introTimeline';
import type { PlainTone } from '../../../lib/seilink/plainTone';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
    /** Motion clock, ms (still under reduced motion; runs faster into the peak). */
    clock: number;
    /** 0..1 extra brightness (the swell as she forms). */
    swell: number;
    /** 0..1 the climax: brighter, fuller, wider light, one rise held until the solid covers it (0 under reduced motion). */
    peak: number;
    /** 0..1 past the peak, how far the climax's bloom has expanded toward filling the screen (0 under reduced motion). */
    fill: number;
  };
  /** 0..1 the starfield and haze (space behind the light). */
  space: number;
  /**
   * 0..1 the solid colour (`tone`) over the whole picture (not the HUD): the
   * intro opens out of it, the climax fills the screen with it, it holds, then
   * fades back into the scene as she comes in.
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
  /** Captions: `block` the whole caption area (cloud, lines, dots; the view sets it on the area, so a line shows at line * block), `line` the beat's line, `sub` the end card's second line. Nothing shows through the peak and the solid. */
  caption: { block: number; line: number; sub: number };
  /** The three beat dots: 0..1 lit. */
  dots: [number, number, number];
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

/** The motion clock: real time, plus the extra the climax adds (smoothly faster into the peak, then steady). */
function motionClock(tl: IntroTimeline, t: number): number {
  const { build, peak, fill } = tl.climax;
  const d = Math.max(1, peak - build);
  const u = Math.min(t, fill);
  if (u <= build) return t;
  // Speed rises as s^2 across the build (s = 0..1), so the clock gains d*s^3/3, then the full speedup until the screen is solid.
  const s = Math.min(1, (u - build) / d);
  const extra = PEAK_SPEEDUP * (d * (s * s * s) / 3 + Math.max(0, u - peak));
  return t + extra;
}

export function computeFrame(
  tl: IntroTimeline,
  t: number,
  W: number,
  H: number,
  reduced: boolean,
  end: IntroEndOn = 'plain_dark',
  tone: PlainTone = end === 'plain_light' ? 'light' : 'dark',
): IntroFrame {
  const B = tl.beats;
  const C = tl.climax;
  const P = B.port;
  const K = B.linked;
  const beat = beatAt(tl, t);
  const plain = end !== 'room';
  const light = tone === 'light';
  const dots: [number, number, number] =
    beat === 'linked'
      ? [1, 1, 1]
      : [
          ease.out(beatProgress(tl, t, 'tunnel')),
          beat === 'tunnel' ? 0 : ease.out(beatProgress(tl, t, 'link')),
          beat === 'port' ? ease.out(beatProgress(tl, t, 'port')) : 0,
        ];
  // The solid: the intro opens out of it, the climax fills the screen with it (a crossfade under reduced motion), it holds, then fades back into the scene.
  const solid =
    t < C.build
      ? 1 - ease.soft(span(t, 0, OPEN_MS))
      : t < C.fill
        ? ease.soft(span(t, reduced ? C.build : C.dim, C.fill))
        : 1 - ease.soft(span(t, C.lift, C.clear));
  // Captions: no text through the peak and the solid. The first line and the block leave before the peak and come back as the solid lifts.
  const timing = t < C.fill ? 1 - ease.inOut(span(t, tl.lineOut, tl.lineOut + CAPTION_OUT_MS)) : ease.inOut(span(t, C.lift, C.clear));
  const block = Math.min(timing, 1 - solid);
  const lineIn = ease.out(span(t, tl.lineAt[beat], tl.lineAt[beat] + CAPTION_IN_MS));
  const caption = {
    block,
    line: lineIn,
    sub: beat === 'linked' ? ease.out(span(t, K + 450, K + 1000)) : 0,
  };
  const base: IntroFrame = {
    t,
    beat,
    W,
    H,
    reduced,
    end,
    tone,
    field: { opacity: 0, gather: 0, clock: t, swell: 0, peak: 0, fill: 0 },
    space: 0,
    solid,
    bloom: { r: 0, a: 0 },
    room: { opacity: 0, reveal: 0, flood: 0 },
    avatar: { opacity: 0, filter: 'none', rise: 0 },
    halo: 0,
    linkGlow: 0,
    brand: ease.out(span(t, 100, 800)) * block,
    caption,
    dots,
  };

  if (reduced) {
    // Calm: the field fades in still, crossfades through the solid, she fades in as it clears, her place fades in as the field fades out.
    const settle = ease.soft(span(t, P, P + 1800));
    base.field.clock = 2400;
    base.field.opacity = ease.soft(span(t, 0, 1200)) * (1 - settle);
    base.space = base.field.opacity;
    base.avatar.opacity = ease.inOut(span(t, C.lift + 100, C.clear + 200));
    base.halo = 0.6 * base.avatar.opacity * (1 - settle);
    base.room.opacity = settle;
    base.room.reveal = 1.2;
    return base;
  }

  // The light wakes, builds to the peak and fills the screen; behind the solid it is settled again, and it fades as her place opens.
  const wake = ease.inOut(span(t, 0, 1200));
  const fade = ease.inOut(span(t, P + 300, P + 2300));
  base.field.opacity = wake * (1 - fade);
  base.field.clock = motionClock(tl, t);
  // One swell: it only rises (eased) up to the peak, then the bloom expands on until the solid covers it all.
  base.field.peak = t < C.fill ? ease.soft(span(t, C.build, C.peak)) : 0;
  base.field.fill = t < C.fill ? ease.soft(span(t, C.peak, C.fill)) : 0;
  // After the solid the curtains lean in toward her as she comes in, then lift away.
  const L = C.lift;
  base.field.gather = (t < C.fill ? 0 : ease.inOut(span(t, C.fill, L + 1800))) * (1 - ease.inOut(span(t, P, P + 1800)));
  // Softer than before the climax (0.6): the peak stays the brightest moment.
  base.field.swell = 0.6 * span(t, L + 200, L + 1100) * (1 - span(t, L + 1500, P + 600));
  // Space (stars, haze) comes up a little behind the light and lingers a moment longer.
  base.space = ease.inOut(span(t, 200, 1800)) * (1 - ease.inOut(span(t, P + 500, P + 2500)));

  // She comes in as the solid fades: rising a little into place, bright, soft and glowing first, then herself.
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
    const open = ease.inOut(span(t, P + 150, P + 2300));
    base.room.opacity = open > 0 ? 1 : 0;
    base.room.reveal = open >= 1 ? 1.2 : open * 1.15;
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

/** The caption's top never rises above this, px: it stays clear of the SEILINK corner label. */
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
