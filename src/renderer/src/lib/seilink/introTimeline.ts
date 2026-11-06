/**
 * The first-link intro's timeline (261105, T337). Pure, so the view, the
 * harness and the tests agree on where each beat starts.
 *
 * Three beats and an end card, about 11.4 s (9.5 s calm):
 *   tunnel  the light wakes out of the solid colour and builds to its climax
 *           (the beat keeps its 261105 name for analytics), then keeps
 *           expanding until the whole screen is one solid colour
 *   link    the solid fades back into the scene as she comes in (261106 v5,
 *           product feedback: "fade to black not hard cut, like the light expands until
 *           fully bright or dark depending on dark or light theme")
 *   port    the light expands once more and settles into the plain colour
 *           (or her room opens) around her
 *   linked  "Linked." over that picture, then the window steps aside and the
 *           same picture is there as the wallpaper (desktopStage)
 *
 * The solid is the theme's colour (PLAIN_COLOURS): white in light mode, black
 * in dark mode, so light mode never goes black and dark mode never goes
 * white. Nothing on the timeline is a cut: every change is a fade of at
 * least a few hundred ms.
 *
 * The intro never delays the host start: it plays while the host comes up.
 * Only the end card waits for the start's answer (HOLD_MAX_MS at most), so
 * "Linked." is not said before she is there. A failed start ends it early
 * (abort), a skip ends it at once.
 */
import type { IntroBeat } from '@shared/seilinkIntroTelemetry';

/**
 * The climax and the solid (ms from the start). The light builds from `build`
 * to its peak at `peak`, then keeps expanding until the screen is one solid
 * colour at `fill` (= beats.link): in light mode it blooms on up into white
 * from `peak`; in dark mode it expands a moment longer and dims into black
 * from `dim`. The solid holds to `lift`, then fades back into the scene by
 * `clear` while she comes in. Reduced motion has no peak and no bloom: the
 * still light crossfades into the solid from `build` to `fill` instead.
 */
export interface IntroClimax {
  build: number;
  peak: number;
  dim: number;
  fill: number;
  lift: number;
  clear: number;
}

/** The intro opens out of the solid colour (the light wakes as it fades) over this long. */
export const OPEN_MS = 1800;

export interface IntroTimeline {
  /** Start of each beat, ms from the intro's start. */
  beats: Record<IntroBeat, number>;
  climax: IntroClimax;
  /** When each beat's caption starts to fade up. */
  lineAt: Record<IntroBeat, number>;
  /** The first caption (and the caption block) fades out from here, so no text rides the peak or the solid. */
  lineOut: number;
  /** When the fade out starts, and the end. */
  fadeAt: number;
  end: number;
}

export const FULL_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 4300, port: 6800, linked: 9200 },
  climax: { build: 2100, peak: 3100, dim: 3150, fill: 4300, lift: 4500, clear: 5800 },
  lineAt: { tunnel: 300, link: 5000, port: 7050, linked: 9450 },
  lineOut: 2400,
  fadeAt: 10800,
  end: 11400,
};

/** Reduced motion: calm crossfades (a gentle fade through the solid colour), shorter. */
export const CALM_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 3800, port: 5800, linked: 7500 },
  climax: { build: 2200, peak: 2200, dim: 2200, fill: 3800, lift: 4000, clear: 5500 },
  lineAt: { tunnel: 300, link: 4500, port: 5950, linked: 7650 },
  lineOut: 1800,
  fadeAt: 8900,
  end: 9500,
};

/** A caption fades up over this long, and the first one fades out over CAPTION_OUT_MS. */
export const CAPTION_IN_MS = 520;
export const CAPTION_OUT_MS = 350;

/** The end card waits at most this long for the host's answer, then says Linked anyway (it is starting). */
export const HOLD_MAX_MS = 6000;
/** A skip fades out this fast; an abort (the start failed) shows its line this long. */
export const SKIP_FADE_MS = 380;
export const ABORT_MS = 1400;

/**
 * Where a skip that rushes to the end (holdEnd) starts from: never inside the
 * climax or the solid, which played fast would flash. Before the solid has
 * cleared it starts from the frame where it has (her, in the settled light).
 */
export function skipFrom(tl: IntroTimeline, t: number): number {
  return t < tl.climax.clear ? tl.climax.clear : t;
}

const ORDER: readonly IntroBeat[] = ['tunnel', 'link', 'port', 'linked'];

export function beatAt(tl: IntroTimeline, t: number): IntroBeat {
  let out: IntroBeat = 'tunnel';
  for (const b of ORDER) if (t >= tl.beats[b]) out = b;
  return out;
}

/** 0..1 progress through a beat. */
export function beatProgress(tl: IntroTimeline, t: number, beat: IntroBeat): number {
  const i = ORDER.indexOf(beat);
  const start = tl.beats[beat];
  const end = i + 1 < ORDER.length ? tl.beats[ORDER[i + 1]] : tl.fadeAt;
  return clamp01((t - start) / Math.max(1, end - start));
}

/**
 * The timeline position for a real elapsed time, holding at the end card's
 * start while the host has not answered (up to HOLD_MAX_MS). `answeredAt` is
 * the real elapsed ms the answer came in (null = not yet).
 */
export function timelineTime(tl: IntroTimeline, elapsed: number, answeredAt: number | null): number {
  const hold = tl.beats.linked;
  if (elapsed <= hold) return elapsed;
  const releasedAt = answeredAt === null ? hold + HOLD_MAX_MS : Math.min(Math.max(answeredAt, hold), hold + HOLD_MAX_MS);
  if (elapsed <= releasedAt) return hold;
  return hold + (elapsed - releasedAt);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 0..1 across [a, b] of t. */
export function span(t: number, a: number, b: number): number {
  return clamp01((t - a) / Math.max(1, b - a));
}

export const ease = {
  out: (x: number): number => 1 - (1 - x) ** 3,
  /** Smoothstep: flat at both ends, half the steepest slope of inOut. The solid and the plain colour fade by it, so no frame jumps. */
  soft: (x: number): number => x * x * (3 - 2 * x),
  inOut: (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  in: (x: number): number => x * x * x,
};
