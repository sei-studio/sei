/**
 * The first-link intro's timeline (261105, T337). Pure, so the view, the
 * harness and the tests agree on where each beat starts.
 *
 * Three beats and an end card, about 11 s (8 s calm):
 *   tunnel  the light wakes (the beat keeps its 261105 name for analytics)
 *   link    she forms out of the light
 *   port    her blank room opens out around her, full screen
 *   linked  "Linked." over her room, then the window steps aside and the
 *           same room is there as the wallpaper (desktopStage)
 *
 * The intro never delays the host start: it plays while the host comes up.
 * Only the end card waits for the start's answer (HOLD_MAX_MS at most), so
 * "Linked." is not said before she is there. A failed start ends it early
 * (abort), a skip ends it at once.
 */
import type { IntroBeat } from '@shared/seilinkIntroTelemetry';

export interface IntroTimeline {
  /** Start of each beat, ms from the intro's start. */
  beats: Record<IntroBeat, number>;
  /** When the fade out starts, and the end. */
  fadeAt: number;
  end: number;
  /** A line starts this long after its beat. */
  lineDelay: number;
}

export const FULL_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 3400, port: 6300, linked: 8900 },
  fadeAt: 10500,
  end: 11200,
  lineDelay: 250,
};

/** Reduced motion: calm crossfades, shorter. */
export const CALM_TIMELINE: IntroTimeline = {
  beats: { tunnel: 0, link: 2400, port: 4400, linked: 6200 },
  fadeAt: 7700,
  end: 8300,
  lineDelay: 150,
};

/** The end card waits at most this long for the host's answer, then says Linked anyway (it is starting). */
export const HOLD_MAX_MS = 6000;
/** A skip fades out this fast; an abort (the start failed) shows its line this long. */
export const SKIP_FADE_MS = 380;
export const ABORT_MS = 1400;

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
