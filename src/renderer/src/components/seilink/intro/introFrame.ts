/**
 * One frame of the first-link intro (261106, Shawn: "I prefer color gradient
 * glow/wave effects, not sharp lines"), as plain numbers and CSS strings:
 * computeFrame(style, timeline, t, size) is pure, so a seek redraws exactly
 * the same picture (the video harness depends on it) and the view just
 * writes the result to the DOM and the two light canvases (introFx.ts).
 *
 * Same beats and copy for every style; only the light differs:
 *   aurora  curtains of soft aurora light (teal, violet, rose) sway across
 *           the dark, lean in toward her as she forms, then lift away.
 *   bloom   slow pulses of warm light breathe out from where she will sit;
 *           in the link they draw back in and she forms in the brightest one.
 *   tide    big pools of liquid light drift and wash across in waves, gather
 *           into her, then drain away and leave her room.
 *
 * Beats: tunnel (the light wakes), link (she forms out of the light, the
 * room still dark), port (her blank room opens out around her in a soft
 * circle while the light fades), linked (the end card over her room; the
 * last frame is her room full screen, exactly what the wallpaper shows).
 * No grids, scanlines, slices or hard edges: every shape is a gradient.
 *
 * Reduced motion (any style): plain crossfades on the calm timeline and a
 * still field.
 */
import type { IntroBeat, IntroStyle } from '@shared/seilinkIntroTelemetry';
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
  style: IntroStyle;
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
  /**
   * Her room: `opacity` of its canvases (she is not in them), `reveal` the
   * radius of the soft circle it opens in around her, as a fraction of the
   * screen's diagonal (>= 1 = no mask).
   */
  room: { opacity: number; reveal: number };
  avatar: { opacity: number; filter: string };
  /** 0..1 the soft glow behind and around her. */
  halo: number;
  /** One soft ring of light out of her when linked, 0..1 progress (<0 none). */
  pulse: number;
  brand: number;
  /** The three beat dots: 0..1 lit. */
  dots: [number, number, number];
}

/** The field's palette per style: background top/bottom and three light colours (r, g, b). */
export const INTRO_PALETTES: Record<IntroStyle, { void: [string, string]; lights: Array<[number, number, number]> }> = {
  aurora: { void: ['#060a1c', '#02030b'], lights: [[62, 240, 200], [138, 107, 255], [255, 122, 217]] },
  bloom: { void: ['#120814', '#050207'], lights: [[255, 179, 138], [255, 122, 168], [176, 140, 255]] },
  tide: { void: ['#03101c', '#010409'], lights: [[64, 200, 255], [90, 120, 255], [236, 110, 255]] },
};

export function computeFrame(style: IntroStyle, tl: IntroTimeline, t: number, W: number, H: number, reduced: boolean): IntroFrame {
  const B = tl.beats;
  const L = B.link;
  const P = B.port;
  const K = B.linked;
  const beat = beatAt(tl, t);
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
    style,
    field: { opacity: 0, gather: 0, clock: t, swell: 0 },
    room: { opacity: 0, reveal: 0 },
    avatar: { opacity: 0, filter: 'none' },
    halo: 0,
    pulse: -1,
    brand: ease.out(span(t, 100, 800)),
    dots,
  };

  if (reduced) {
    // Calm: the field fades in still, she fades in, her room fades in as the field fades out.
    base.field.clock = 2400;
    base.field.opacity = ease.inOut(span(t, 0, 900)) * (1 - ease.inOut(span(t, P, P + 1200)));
    base.avatar.opacity = ease.inOut(span(t, L + 100, L + 1100));
    base.halo = 0.6 * base.avatar.opacity * (1 - span(t, P, P + 1200));
    base.room.opacity = ease.inOut(span(t, P, P + 1200));
    base.room.reveal = 1.2;
    return base;
  }

  // ── Shared shape of the light: wakes, swells as she forms, fades as her room opens.
  const wake = ease.inOut(span(t, 0, 1200));
  const fade = ease.inOut(span(t, P + 300, P + 2300));
  base.field.opacity = wake * (1 - fade);
  base.field.gather = ease.inOut(span(t, L, L + 2200)) * (1 - ease.inOut(span(t, P, P + 1800)));
  base.field.swell = span(t, L + 400, L + 1500) * (1 - span(t, L + 1900, P + 600));

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

  // Her room opens out around her in a soft circle.
  const open = ease.inOut(span(t, P + 150, P + 2300));
  base.room.opacity = open > 0 ? 1 : 0;
  base.room.reveal = open >= 1 ? 1.2 : open * 1.15;
  base.pulse = t >= K && t < K + 1600 ? span(t, K, K + 1600) : -1;

  // Per style: how the light moves (introFx reads style + clock); a few timing differences.
  if (style === 'bloom') {
    // The pulses draw back in a little sooner and breathe slower.
    base.field.gather = ease.inOut(span(t, L - 300, L + 1900)) * (1 - ease.inOut(span(t, P, P + 1600)));
    base.field.clock = t * 0.85;
  } else if (style === 'tide') {
    // Liquid light lingers a moment longer as it drains.
    base.field.opacity = wake * (1 - ease.inOut(span(t, P + 500, P + 2500)));
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
 * 0..1 how much of her room shows at screen point `p` (root px), the same
 * soft circle as revealMask around `centre`, times the room's opacity. The
 * HUD text switches from night ink to day ink by it (her first room is
 * white), each piece where it sits, so it never turns dark over the light.
 */
export function roomBehind(f: IntroFrame, centre: { x: number; y: number }, p: { x: number; y: number }): number {
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

/** Text over this much of her room is in day ink, under the low end night ink (0..1, eased between). */
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
