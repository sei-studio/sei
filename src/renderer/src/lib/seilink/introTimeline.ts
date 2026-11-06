/**
 * The first-link intro's timeline (261105, T337). Pure, so the view, the
 * harness and the tests agree on where each beat starts.
 *
 * Three beats and an end card, about 11.3 s (8.4 s calm):
 *   tunnel  the light wakes and builds to its climax (the beat keeps its
 *           261105 name for analytics), then everything cuts to black
 *   link    the black fades out as she comes in (261106 v4, product feedback: "climax
 *           the lights and cut it all to black, then as the black fades out
 *           the character comes in")
 *   port    the light settles into the plain colour (or her room) around her
 *   linked  "Linked." over that picture, then the window steps aside and the
 *           same picture is there as the wallpaper (desktopStage)
 *
 * The intro never delays the host start: it plays while the host comes up.
 * Only the end card waits for the start's answer (HOLD_MAX_MS at most), so
 * "Linked." is not said before she is there. A failed start ends it early
 * (abort), a skip ends it at once.
 */
import type { IntroBeat } from '@shared/seilinkIntroTelemetry';

/**
 * The climax and the cut (ms from the start). The light builds from `build`
 * to its peak at `peak` and holds it to `cut` (= beats.link), where the whole
 * picture cuts to black in one frame. Black holds to `lift`, then fades out
 * by `clear` while she comes in. Reduced motion has no peak and no cut: the
 * light fades gently into black from `build` to `cut` instead.
 */
export interface IntroClimax {
  build: number;
  peak: number;
  cut: number;
  lift: number;
  clear: number;
}

export interface IntroTimeline {
  /** Start of each beat, ms from the intro's start. */
  beats: Record<IntroBeat, number>;
  climax: IntroClimax;
  /** When each beat's caption starts to fade up. */
  lineAt: Record<IntroBeat, number>;
  /** The first caption (and the caption block) has faded out this long before the cut, so no text rides the peak or the cut. */
  lineOut: number;
  /** When the fade out starts, and the end. */
  fadeAt: number;
  end: number;
}

export const FULL_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 3600, port: 6500, linked: 9000 },
  climax: { build: 2100, peak: 3200, cut: 3600, lift: 3950, clear: 4950 },
  lineAt: { tunnel: 250, link: 4500, port: 6750, linked: 9250 },
  lineOut: 2400,
  fadeAt: 10600,
  end: 11300,
};

/** Reduced motion: calm crossfades (a gentle fade through black), shorter. */
export const CALM_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 2600, port: 4600, linked: 6300 },
  climax: { build: 1800, peak: 1800, cut: 2600, lift: 2800, clear: 3700 },
  lineAt: { tunnel: 150, link: 3300, port: 4750, linked: 6450 },
  lineOut: 1350,
  fadeAt: 7800,
  end: 8400,
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
 * climax or the black, which played fast would flash. Before the black has
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
  inOut: (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  in: (x: number): number => x * x * x,
};
