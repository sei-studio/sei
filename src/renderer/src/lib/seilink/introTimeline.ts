/**
 * The first-link intro's timeline (261105, T337; 261106 v6, the WorldLink
 * status lines). Pure, so the view, the harness and the tests agree on where
 * each beat starts.
 *
 * v6 (product feedback (261106)): the length is set by the real pipeline. The
 * status lines (lib/seilink/worldLink.ts planLink) run one at a time over the
 * eclipse aurora, each a step brighter and faster; with the last line the
 * light builds to its climax and expands until the screen is one solid
 * colour; the success line lands on the solid, holds and fades out; then she
 * fades in on the solid (the light never comes back). Beats, for analytics: tunnel (the lines), link
 * (from the success line, she comes in), port (the settle), linked (the
 * picture the wallpaper draws).
 *
 * The solid is the theme's colour (PLAIN_COLOURS): white in light mode, black
 * in dark mode, so light mode never goes black and dark mode never goes
 * white. Nothing on the timeline is a cut: every change is a fade of at
 * least a few hundred ms.
 *
 * A failure (the failure line) holds the scene with no climax and no her,
 * until the person closes it. A skip before the success line crossfades into
 * the solid (no peak: never played fast) and plays her entrance from there.
 */
import type { IntroBeat } from '@shared/seilinkIntroTelemetry';
import { LAST_LINE_MS, type LinkPlan } from './worldLink';

/**
 * The climax and the solid (ms from the start). The light builds from `build`
 * to its peak at `peak`, then keeps expanding until the screen is one solid
 * colour at `fill`: in light mode it blooms on up into white from `peak`; in
 * dark mode it expands a moment longer and dims into black from `dim`. A
 * `calm` climax (reduced motion, a skip) has no peak and no bloom: the light
 * crossfades into the solid from `build` to `fill`.
 */
export interface IntroClimax {
  build: number;
  peak: number;
  dim: number;
  fill: number;
  calm: boolean;
}

/**
 * After the success line (or a skip). The light does not come back
 * (product feedback (261106)): the screen stays the solid colour, the success
 * line holds and fades out from `textOut` (over TEXT_OUT_MS), then from
 * `lift` she fades in on the solid, slowly, until `clear` (her place, the
 * plain colour or her room, was laid in under the solid meanwhile, so what
 * comes in is exactly what the wallpaper shows). `port` and `linked` are
 * the analytics beats; the overlay hands off at `fadeAt`..`end`.
 */
export interface IntroAfter {
  success: number;
  textOut: number;
  lift: number;
  clear: number;
  port: number;
  linked: number;
  fadeAt: number;
  end: number;
}

export interface IntroTimes {
  /** Starts of the status lines on screen (as far as known). */
  lines: number[];
  /** The success line (null: not yet, failed, or skipped before it). */
  success: number | null;
  /** The failure line. */
  fail: number | null;
  climax: IntroClimax | null;
  after: IntroAfter | null;
  /** A skip before the success line, ms. */
  skip: number | null;
}

/** The intro opens out of the solid colour (the light wakes as it fades) over this long. */
export const OPEN_MS = 1800;

/** The climax under line 9 (offsets from its start); the success line lands LAST_LINE_MS after it, on the full solid. */
export const CLIMAX = { build: 500, peak: 1500, dim: 1550, fill: 2700 } as const;
export const CALM_CLIMAX = { build: 400, fill: 2000 } as const;
/**
 * From the success line: it types in and holds about 2 s on the solid, fades
 * out over TEXT_OUT_MS, then she fades in over about 2.8 s on the solid.
 */
export const AFTER = { textOut: 3200, lift: 4400, clear: 7200, port: 7200, linked: 7800, fadeAt: 9400, end: 10000 } as const;
export const CALM_AFTER = { textOut: 2800, lift: 4000, clear: 6800, port: 6800, linked: 7200, fadeAt: 8600, end: 9200 } as const;
/** The success line fades out over this long. */
export const TEXT_OUT_MS = 1000;

/** A skip before the success line crossfades into the solid over this long, then her entrance plays (lift this long after). */
export const SKIP_SOLID_MS = 1200;
export const SKIP_LIFT_MS = 200;

/** A caption fades up over this long (starting CAPTION_GAP_MS after the line before begins to fade over CAPTION_OUT_MS). */
export const CAPTION_IN_MS = 520;
export const CAPTION_OUT_MS = 300;
export const CAPTION_GAP_MS = 120;

/** A skip in the app window fades out this fast (and the close on the failure line). */
export const SKIP_FADE_MS = 380;

function afterFrom(s: number, reduced: boolean, lift?: number): IntroAfter {
  const a = reduced ? CALM_AFTER : AFTER;
  const l = lift ?? s + a.lift;
  const d = l - (s + a.lift);
  return { success: s, textOut: s + a.textOut + d, lift: l, clear: s + a.clear + d, port: s + a.port + d, linked: s + a.linked + d, fadeAt: s + a.fadeAt + d, end: s + a.end + d };
}

/**
 * The times for a plan. `skip` (ms) is a skip before the success line: the
 * calm crossfade into the solid from there, her entrance after it.
 */
export function introTimes(plan: LinkPlan, reduced: boolean, skip: number | null = null): IntroTimes {
  const base = { lines: plan.lines, fail: plan.fail?.at ?? null };
  const skipped = skip !== null && (plan.success === null || skip < plan.success - LAST_LINE_MS + CLIMAX.build) && (plan.fail === null || skip < plan.fail.at);
  if (skipped) {
    const fill = skip + SKIP_SOLID_MS;
    return {
      ...base,
      lines: plan.lines.filter((s) => s <= skip),
      success: null,
      fail: null,
      climax: { build: skip, peak: skip, dim: skip, fill, calm: true },
      after: afterFrom(fill, reduced, fill + SKIP_LIFT_MS),
      skip,
    };
  }
  if (plan.success === null) return { ...base, success: null, climax: null, after: null, skip: null };
  const s9 = plan.success - LAST_LINE_MS;
  const climax: IntroClimax = reduced
    ? { build: s9 + CALM_CLIMAX.build, peak: s9 + CALM_CLIMAX.build, dim: s9 + CALM_CLIMAX.build, fill: s9 + CALM_CLIMAX.fill, calm: true }
    : { build: s9 + CLIMAX.build, peak: s9 + CLIMAX.peak, dim: s9 + CLIMAX.dim, fill: s9 + CLIMAX.fill, calm: false };
  return { ...base, success: plan.success, climax, after: afterFrom(plan.success, reduced), skip: null };
}

export function beatAt(times: IntroTimes, t: number): IntroBeat {
  const a = times.after;
  if (!a || t < (times.success ?? a.success)) return 'tunnel';
  if (t < a.port) return 'link';
  if (t < a.linked) return 'port';
  return 'linked';
}

/**
 * Where a skip that rushes to the end (holdEnd) runs its clock from, once it
 * is past the success line: never inside the climax or the solid, which
 * played fast would flash. Before the solid has cleared, the rush starts after it.
 */
export function skipFrom(times: IntroTimes, t: number): number {
  const clear = times.after?.clear ?? t;
  return t < clear ? clear : t;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 0..1 across [a, b] of t. */
export function span(t: number, a: number, b: number): number {
  return clamp01((t - a) / Math.max(1, b - a));
}

/** The integral over [a, t] of ease.soft(span(x, a, a + d)) dx (the motion clock's extra from an eased step). */
export function softIntegral(t: number, a: number, d: number): number {
  if (t <= a) return 0;
  if (t >= a + d) return d / 2 + (t - a - d);
  const u = (t - a) / d;
  return d * (u * u * u - (u * u * u * u) / 2);
}

export const ease = {
  out: (x: number): number => 1 - (1 - x) ** 3,
  /** Smoothstep: flat at both ends, half the steepest slope of inOut. The solid and the plain colour fade by it, so no frame jumps. */
  soft: (x: number): number => x * x * (3 - 2 * x),
  inOut: (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  in: (x: number): number => x * x * x,
};
