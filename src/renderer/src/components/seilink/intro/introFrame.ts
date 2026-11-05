/**
 * One frame of the first-link intro, as plain numbers and CSS strings:
 * computeFrame(mood, timeline, t, size, reduced, end) is pure, so a seek
 * redraws exactly the same picture (the video harness depends on it) and the
 * view just writes the result to the DOM and the light canvases (introFx.ts).
 *
 * The light is the aurora (261106, Shawn: "the aurora is pretty creative ...
 * make the colors more space themed. Think interstellar scifi and no man's
 * sky"): curtains of soft light sway across deep space, lean in toward her
 * as she forms, then lift away. Space depth comes from a faint, very soft
 * starfield and a nebula haze. Only the colours change between moods
 * (INTRO_MOODS): `accretion` (gold and amber light around a black hole, cool
 * blue-white highlights), `nebula` (saturated teal, magenta, violet and
 * sunset orange on deep indigo), `eclipse` (the two together).
 *
 * Beats: tunnel (the light wakes), link (she forms out of the light), port
 * (the light settles and her place opens around her), linked (the end card;
 * the last frame is exactly what the wallpaper shows).
 *
 * How it ends (`end`, first-link v3): on the plain background she spawns on
 * (`plain_dark` black, `plain_light` white, with the OS theme): the light
 * fades and the whole screen settles into that colour, no shape or edge.
 * `room` (a replay over a room she already has): her room opens in a wide,
 * feathered circle around her as before.
 *
 * No grids, scanlines, rings, slices or hard edges: every shape is a gradient.
 * Reduced motion (any mood): plain crossfades on the calm timeline and a
 * still field.
 */
import type { IntroBeat, IntroEndOn, IntroMood } from '@shared/seilinkIntroTelemetry';
import { beatAt, beatProgress, ease, span, type IntroTimeline } from '../../../lib/seilink/introTimeline';

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
  mood: IntroMood;
  end: IntroEndOn;
  /** The light field (introFx). */
  field: {
    /** 0..1 how much of it shows. */
    opacity: number;
    /** 0..1 how far it has gathered in on her (link). */
    gather: number;
    /** Motion clock, ms (still under reduced motion). */
    clock: number;
    /** 0..1 extra brightness (the swell as she forms). */
    swell: number;
  };
  /** 0..1 the starfield and haze (space behind the light). */
  space: number;
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
  avatar: { opacity: number; filter: string };
  /** 0..1 the soft glow behind and around her. */
  halo: number;
  /** 0..1 a soft breath of light around her when linked (a glow, no ring; none over the white ending, where a glow only greys it). */
  linkGlow: number;
  brand: number;
  /** The three beat dots: 0..1 lit. */
  dots: [number, number, number];
}

type RGB = [number, number, number];

export interface MoodPalette {
  /** Deep space behind the light, centre to edge. */
  void: [string, string];
  /** The curtains' colours, one per curtain (four). */
  lights: [RGB, RGB, RGB, RGB];
  /** The nebula haze, two soft clouds. */
  haze: [RGB, RGB];
  /** Star colour. */
  star: RGB;
  /** Her halo and the swell. */
  halo: RGB;
}

/** The moods (261106). Colours are the space references, kept soft and luminous. */
export const INTRO_PALETTES: Record<IntroMood, MoodPalette> = {
  // A black hole's accretion disk: warm gold, amber and white heat, cool blue-white rims.
  accretion: {
    void: ['#0b0805', '#000000'],
    lights: [
      [255, 182, 92],
      [255, 226, 176],
      [150, 186, 255],
      [255, 140, 64],
    ],
    haze: [
      [74, 42, 14],
      [24, 36, 84],
    ],
    star: [214, 226, 255],
    halo: [255, 214, 160],
  },
  // A saturated alien nebula: teal, magenta, violet and a sunset orange on deep indigo.
  nebula: {
    void: ['#0e0b33', '#03021a'],
    lights: [
      [38, 232, 208],
      [240, 70, 190],
      [150, 96, 255],
      [255, 146, 72],
    ],
    haze: [
      [120, 40, 150],
      [20, 96, 130],
    ],
    star: [230, 236, 255],
    halo: [190, 170, 255],
  },
  // The two together: gold light and blue-white rims against violet and teal nebula.
  eclipse: {
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
  },
};

/**
 * How far the white ending's flood goes (a colour-dodge by this grey: the
 * picture brightens about 2x, the brights reach white). Further, the dodge
 * would blow the soft light's 8-bit steps up into visible blocks.
 */
export const FLOOD_MAX = 0.55;

export function computeFrame(mood: IntroMood, tl: IntroTimeline, t: number, W: number, H: number, reduced: boolean, end: IntroEndOn = 'plain_dark'): IntroFrame {
  const B = tl.beats;
  const L = B.link;
  const P = B.port;
  const K = B.linked;
  const beat = beatAt(tl, t);
  const plain = end !== 'room';
  const dots: [number, number, number] =
    beat === 'linked'
      ? [1, 1, 1]
      : [
          ease.out(beatProgress(tl, t, 'tunnel')),
          beat === 'tunnel' ? 0 : ease.out(beatProgress(tl, t, 'link')),
          beat === 'port' ? ease.out(beatProgress(tl, t, 'port')) : 0,
        ];
  const base: IntroFrame = {
    t,
    beat,
    W,
    H,
    reduced,
    mood,
    end,
    field: { opacity: 0, gather: 0, clock: t, swell: 0 },
    space: 0,
    room: { opacity: 0, reveal: 0, flood: 0 },
    avatar: { opacity: 0, filter: 'none' },
    halo: 0,
    linkGlow: 0,
    brand: ease.out(span(t, 100, 800)),
    dots,
  };

  if (reduced) {
    // Calm: the field fades in still, she fades in, her place fades in as the field fades out.
    base.field.clock = 2400;
    base.field.opacity = ease.inOut(span(t, 0, 900)) * (1 - ease.inOut(span(t, P, P + 1200)));
    base.space = base.field.opacity;
    base.avatar.opacity = ease.inOut(span(t, L + 100, L + 1100));
    base.halo = 0.6 * base.avatar.opacity * (1 - span(t, P, P + 1200));
    base.room.opacity = ease.inOut(span(t, P, P + 1200));
    base.room.reveal = 1.2;
    return base;
  }

  // The light wakes, swells as she forms, and fades as her place opens.
  const wake = ease.inOut(span(t, 0, 1200));
  const fade = ease.inOut(span(t, P + 300, P + 2300));
  base.field.opacity = wake * (1 - fade);
  base.field.gather = ease.inOut(span(t, L, L + 2200)) * (1 - ease.inOut(span(t, P, P + 1800)));
  base.field.swell = span(t, L + 400, L + 1500) * (1 - span(t, L + 1900, P + 600));
  // Space (stars, haze) comes up a little behind the light and lingers a moment longer.
  base.space = ease.inOut(span(t, 200, 1800)) * (1 - ease.inOut(span(t, P + 500, P + 2500)));

  // She forms out of the light: bright, soft and glowing first, then herself.
  const q = ease.inOut(span(t, L + 300, L + 1900));
  base.avatar.opacity = ease.out(span(t, L + 200, L + 1100));
  if (q < 0.999) {
    const r = 1 - q;
    base.avatar.filter =
      `brightness(${(1 + 1.4 * r).toFixed(3)}) saturate(${(0.55 + 0.45 * q).toFixed(3)}) blur(${(6 * r).toFixed(2)}px) ` +
      `drop-shadow(0 0 ${(26 * r).toFixed(1)}px rgba(255, 255, 255, ${(0.85 * r).toFixed(3)}))`;
  }
  base.halo = span(t, L + 200, L + 1200) * (1 - 0.65 * span(t, P + 200, P + 2000)) * (1 - span(t, K, K + 900));

  if (plain) {
    // The whole screen settles into the plain colour as the light fades: no circle, no edge.
    // Into white, the light floods first (the brights go white, then the rest) and the white comes over it.
    if (end === 'plain_light') {
      base.room.flood = FLOOD_MAX * ease.inOut(span(t, P, P + 1800));
      base.room.opacity = ease.inOut(span(t, P + 700, P + 2500));
    } else {
      base.room.opacity = ease.inOut(span(t, P + 300, P + 2500));
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
 * plain background, times its opacity. The black plain background is not
 * light, so it is 0 there. The HUD text switches from night ink to day ink by
 * it, each piece where it sits, so it never turns dark over the light.
 */
export function roomBehind(f: IntroFrame, centre: { x: number; y: number }, p: { x: number; y: number }): number {
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
