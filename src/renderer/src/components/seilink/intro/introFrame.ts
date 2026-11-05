/**
 * One frame of the first-link intro (261105, T337), as plain numbers and CSS
 * strings: computeFrame(style, timeline, t, size) is pure, so a seek redraws
 * exactly the same picture (the video harness depends on it) and the view
 * just writes the result to the DOM and the two effect canvases.
 *
 * Three treatments, same beats and copy, one style key each:
 *   holo    clean holographic wireframe: a perspective grid and a wireframe
 *           box, the room printed top to bottom by a scan beam out of a cyan
 *           hologram tint; she builds bottom to top on a projector ring.
 *   glitch  a glitch portal: data rain, a jagged chromatic ring that opens
 *           onto the room through glitch bursts; she flickers in on data
 *           streams; the room snaps into the monitor in glitching steps.
 *   tunnel  a calm light tunnel: flying through soft rings of light, a
 *           window opens and the room settles out of a bloom; light motes
 *           gather into her; the room glides into the monitor with a ripple.
 * Reduced motion (any style): plain crossfades on the calm timeline.
 */
import type { IntroBeat, IntroStyle } from '@shared/seilinkIntroTelemetry';
import { beatAt, beatProgress, ease, hash01, span, type IntroTimeline } from '../../../lib/seilink/introTimeline';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Scale of the room once it sits in the monitor, and how far up the monitor sits (of the height). */
export const PORT_SCALE = 0.6;
export const PORT_LIFT = 0.075;

export interface IntroFrame {
  t: number;
  beat: IntroBeat;
  W: number;
  H: number;
  reduced: boolean;
  style: IntroStyle;
  stage: { scale: number; ty: number; tx: number; opacity: number };
  /** tint: the hologram's cyan wash over the room (a colour-blend layer), 0..1. */
  room: { opacity: number; filter: string; clip: string; mask: string; glitch: number; tint: number };
  /** holo: how far her colours are mapped to the hologram's cyan (an SVG colour matrix), 0..1. */
  avatar: { opacity: number; filter: string; clip: string; transform: string; glitch: number; holo: number };
  scanlines: number;
  /** The monitor's outer box (screen + bezel), and its fade. */
  bezel: Box & { opacity: number };
  /** The screen box at the end of the port (the room's final rect). */
  screen: Box;
  desk: number;
  icons: number[];
  brand: number;
  /** Progress of the three beat bars. */
  bars: [number, number, number];
  /** Effects (0 = off). */
  fx: {
    grid: number;
    wire: number;
    beam: number; // y fraction of the room's scan edge (holo), <0 = none
    rain: number;
    portalR: number; // px, glitch portal radius (0 = none)
    rim: number;
    tunnel: number;
    tunnelPhase: number;
    window: number; // tunnel window progress 0..1
    ring: number; // projector ring under her (holo)
    herScan: number; // holo: y fraction (of her box) of her build line, <0 none
    stream: number; // glitch data streams 0..1 progress, <0 none
    motes: number; // tunnel motes 0..1 progress, <0 none
    outline: number; // holo monitor outline draw progress
    ripple: number; // tunnel landing ripple 0..1, <0 none
    linkedPulse: number;
  };
}

const GLITCH_BURSTS: ReadonlyArray<readonly [number, number, number]> = [
  [1000, 120, 0.7],
  [1650, 160, 1],
  [2300, 120, 0.8],
  [2950, 180, 1],
  [3320, 90, 0.5],
];

function burst(t: number, list: ReadonlyArray<readonly [number, number, number]>): number {
  for (const [a, d, s] of list) {
    if (t >= a && t < a + d) {
      const x = (t - a) / d;
      return s * (x < 0.3 ? x / 0.3 : 1 - (x - 0.3) / 0.7) * (0.7 + 0.3 * hash01(Math.floor(t / 30), a));
    }
  }
  return 0;
}

/** The room's part of the hologram look: drained and lifted; the cyan comes from the tint layer (room.tint). */
function holoFilter(g: number): string {
  if (g <= 0.001) return 'none';
  return `grayscale(${(0.85 * g).toFixed(3)}) brightness(${(1 + 0.18 * g).toFixed(3)}) contrast(${(1 + 0.08 * g).toFixed(3)})`;
}

/** The final screen rect (the room in the monitor). */
export function screenBox(W: number, H: number): Box {
  const w = W * PORT_SCALE;
  const h = H * PORT_SCALE;
  return { x: (W - w) / 2, y: (H - h) / 2 - PORT_LIFT * H, w, h };
}

export function computeFrame(style: IntroStyle, tl: IntroTimeline, t: number, W: number, H: number, reduced: boolean): IntroFrame {
  const B = tl.beats;
  const L = B.link;
  const P = B.port;
  const K = B.linked;
  const beat = beatAt(tl, t);
  const screen = screenBox(W, H);
  const pad = Math.max(10, Math.round(W * 0.011));
  const bezelBox: Box = { x: screen.x - pad, y: screen.y - pad, w: screen.w + pad * 2, h: screen.h + pad * 2 };
  const bars: [number, number, number] =
    beat === 'linked' ? [1, 1, 1] : [beatProgress(tl, t, 'tunnel'), beat === 'tunnel' ? 0 : beatProgress(tl, t, 'link'), beat === 'port' ? beatProgress(tl, t, 'port') : 0];
  const iconsAt = (start: number): number[] => [0, 1, 2, 3].map((i) => ease.out(span(t, start + i * 110, start + 380 + i * 110)));
  const fx: IntroFrame['fx'] = {
    grid: 0,
    wire: 0,
    beam: -1,
    rain: 0,
    portalR: 0,
    rim: 0,
    tunnel: 0,
    tunnelPhase: 0,
    window: 1,
    ring: 0,
    herScan: -1,
    stream: -1,
    motes: -1,
    outline: 0,
    ripple: -1,
    linkedPulse: span(t, K, K + 500) * (1 - span(t, K + 500, K + 1400)),
  };
  const base: IntroFrame = {
    t,
    beat,
    W,
    H,
    reduced,
    style,
    stage: { scale: 1, ty: 0, tx: 0, opacity: 1 },
    room: { opacity: 1, filter: 'none', clip: 'none', mask: 'none', glitch: 0, tint: 0 },
    avatar: { opacity: 0, filter: 'none', clip: 'none', transform: 'none', glitch: 0, holo: 0 },
    scanlines: 0,
    bezel: { ...bezelBox, opacity: 0 },
    screen,
    desk: 0,
    icons: [0, 0, 0, 0],
    brand: ease.out(span(t, 100, 800)),
    bars,
    fx,
  };

  if (reduced) {
    // Calm: crossfades only. The room fades in, she fades in, the room is
    // swapped for the monitor view with a fade, then the end card.
    base.room.opacity = ease.inOut(span(t, 200, 1300));
    base.avatar.opacity = ease.inOut(span(t, L + 100, L + 1200));
    const out = span(t, P, P + 450);
    const back = span(t, P + 450, P + 1150);
    const swapped = t >= P + 450;
    base.stage.opacity = swapped ? ease.inOut(back) : 1 - ease.inOut(out);
    if (swapped) {
      base.stage.scale = PORT_SCALE;
      base.stage.ty = -PORT_LIFT * H;
    }
    base.bezel.opacity = swapped ? ease.inOut(back) : 0;
    base.desk = swapped ? ease.inOut(span(t, P + 700, P + 1400)) : 0;
    base.icons = swapped ? [1, 1, 1, 1] : [0, 0, 0, 0];
    fx.grid = 0.25 * base.bezel.opacity;
    fx.linkedPulse = 0;
    return base;
  }

  // ── Beat 3, shared geometry: the stage glides (or snaps) into the monitor.
  const portRaw = span(t, P + 150, P + 1900);
  let pe = ease.inOut(portRaw);
  if (style === 'glitch') {
    const raw = span(t, P + 200, P + 1700);
    const n = raw * 4;
    const frac = n % 1;
    const smooth = frac > 0.72 ? ease.inOut((frac - 0.72) / 0.28) : 0;
    pe = raw >= 1 ? 1 : ease.out((Math.floor(n) + smooth) / 4);
  }
  base.stage.scale = 1 - (1 - PORT_SCALE) * pe;
  base.stage.ty = -PORT_LIFT * H * pe;

  if (style === 'holo') {
    fx.grid = 0.9 * span(t, 0, 900) * (1 - 0.55 * span(t, 2400, 3400));
    fx.wire = t < 3400 ? ease.out(span(t, 250, 1700)) * (1 - span(t, 2600, 3300)) : 0;
    const rp = ease.inOut(span(t, 1200, 3000));
    const edge = rp * 1.15 - 0.075;
    if (rp > 0 && rp < 1) {
      base.room.mask = `linear-gradient(to bottom, #000 0%, #000 ${((edge - 0.05) * 100).toFixed(2)}%, transparent ${(edge * 100).toFixed(2)}%)`;
      fx.beam = edge;
    } else if (rp <= 0) {
      base.room.opacity = 0;
    }
    const g = 1 - span(t, 2300, 3500);
    base.room.filter = holoFilter(g);
    base.room.tint = g > 0.001 ? g : 0;
    base.scanlines = 0.55 * g * span(t, 1200, 1600);
    // She builds bottom to top on the projector ring.
    const ap = ease.out(span(t, L + 250, L + 1900));
    const g2 = 1 - span(t, L + 1500, L + 2500);
    base.avatar.opacity = span(t, L + 150, L + 400);
    if (ap < 1) {
      const top = ((1 - ap) * 100).toFixed(2);
      base.avatar.clip = `polygon(-60% ${top}%, 160% ${top}%, 160% 130%, -60% 130%)`;
      if (ap > 0) fx.herScan = 1 - ap;
    }
    base.avatar.holo = g2 > 0.001 ? g2 : 0;
    base.avatar.filter = g2 > 0.001 ? `drop-shadow(0 0 ${(14 * g2).toFixed(1)}px rgba(127, 176, 255, ${(0.85 * g2).toFixed(3)}))` : 'none';
    base.scanlines = Math.max(base.scanlines, 0.28 * g2 * span(t, L, L + 300));
    fx.ring = span(t, L, L + 400) * (1 - span(t, L + 2100, L + 2800));
    // Beat 3: the monitor outline draws, then it fills.
    fx.outline = ease.inOut(span(t, P + 600, P + 1700));
    base.bezel.opacity = ease.out(span(t, P + 1300, P + 1900));
    base.desk = span(t, P + 1500, P + 1800);
    base.icons = iconsAt(P + 1550);
    fx.grid = Math.max(fx.grid, 0.4 * span(t, P, P + 900));
    return base;
  }

  if (style === 'glitch') {
    fx.rain = span(t, 0, 500) * (1 - 0.8 * span(t, 2000, 3200));
    if (t >= L) fx.rain = 0.2 * (1 - span(t, L + 1200, L + 2200));
    const pr = ease.out(span(t, 600, 2800));
    const R = pr * 0.62 * Math.hypot(W, H);
    if (pr < 1) {
      base.room.clip = `circle(${R.toFixed(1)}px at 50% 50%)`;
      fx.portalR = R;
      fx.rim = pr > 0 ? 1 : 0;
      if (pr <= 0) base.room.opacity = 0;
    }
    const gb = t < L ? burst(t, GLITCH_BURSTS) : t >= P ? burst(t, [[P + 220, 130, 0.9], [P + 590, 130, 1], [P + 960, 140, 1], [P + 1330, 170, 0.8], [P + 1520, 120, 0.5]]) : 0;
    base.room.glitch = gb;
    base.stage.tx = gb > 0 ? (hash01(Math.floor(t / 30), 11) - 0.5) * 26 * gb : 0;
    const desat = 1 - span(t, 2600, 3400);
    base.room.filter = desat > 0.001 ? `saturate(${(1 - 0.45 * desat).toFixed(3)}) contrast(${(1 + 0.15 * desat).toFixed(3)})` : 'none';
    base.scanlines = 0.22 * desat * span(t, 600, 1000) + 0.5 * gb;
    // She flickers in on the data streams.
    const fp = span(t, L + 200, L + 1900);
    if (t < L + 200) base.avatar.opacity = 0;
    else if (fp >= 1) base.avatar.opacity = 1;
    else {
      const slot = Math.floor(t / 45);
      base.avatar.opacity = hash01(slot, 3) < 0.15 + fp * 0.95 ? 1 : 0;
      base.avatar.glitch = (1 - fp) * (0.6 + 0.4 * hash01(slot, 5));
      base.avatar.transform = `translateX(${((hash01(slot, 7) - 0.5) * 34 * (1 - fp)).toFixed(1)}px)`;
    }
    fx.stream = t >= L && t < L + 2300 ? span(t, L, L + 2300) : -1;
    // Beat 3: the monitor flickers on.
    const bz = span(t, P + 1250, P + 1800);
    base.bezel.opacity = bz >= 1 ? 1 : bz > 0 ? (hash01(Math.floor(t / 40), 13) < 0.3 + bz ? bz : 0.1) : 0;
    base.desk = bz >= 1 ? 1 : bz * (hash01(Math.floor(t / 50), 17) < 0.5 + bz ? 1 : 0.3);
    base.icons = iconsAt(P + 1500);
    return base;
  }

  // tunnel
  fx.tunnel = span(t, 0, 450) * (1 - 0.72 * span(t, 2500, 3600));
  if (t >= P) fx.tunnel = Math.max(fx.tunnel, 0.32 * span(t, P, P + 900));
  fx.tunnelPhase = 0.95 * ease.out(span(t, 0, 3900)) + t * 0.000035;
  const wp = ease.inOut(span(t, 1100, 3000));
  fx.window = wp;
  if (wp < 1) {
    const ins = ((1 - wp) * 50).toFixed(3);
    base.room.clip = `inset(${ins}% ${ins}% round 2px)`;
    if (wp <= 0) base.room.opacity = 0;
  }
  const b = 1 - span(t, 1500, 3400);
  base.room.filter = b > 0.001 ? `brightness(${(1 + 1.4 * b).toFixed(3)}) saturate(${(1 - 0.5 * b).toFixed(3)}) blur(${(5 * b).toFixed(2)}px)` : 'none';
  fx.motes = t >= L && t < L + 2400 ? span(t, L, L + 2400) : -1;
  const q = ease.inOut(span(t, L + 800, L + 2150));
  base.avatar.opacity = q;
  base.avatar.filter = q < 0.999 ? `brightness(${(1 + 2.6 * (1 - q)).toFixed(3)}) saturate(${q.toFixed(3)}) blur(${(4 * (1 - q)).toFixed(2)}px)` : 'none';
  base.bezel.opacity = ease.inOut(span(t, P + 1100, P + 2000));
  base.desk = ease.inOut(span(t, P + 1500, P + 2100));
  base.icons = iconsAt(P + 1550);
  fx.ripple = t >= P + 1700 && t < P + 2700 ? span(t, P + 1700, P + 2700) : -1;
  return base;
}
