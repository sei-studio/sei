/**
 * Her entrance on the desktop (261119, product call (261119)): the first-link
 * intro's arrival, played by the wallpaper page on every move-in
 * (components/seilink/host/HostArrival.tsx; when it plays:
 * shared/seilinkEntrance.ts).
 *
 * In the intro she comes in as the solid fades off her over lift..clear
 * (introFrame.ts): seen through it, she fades in softly, rises a touch into
 * place, and starts bright and blurred, then sharpens. With no solid on the
 * desktop the same curves drive her own opacity, transform and filter, so
 * both entrances look alike. Reduced motion: a plain fade.
 */
import { AFTER, ease } from './introTimeline';

/** The intro's lift..clear (2.8 s). */
export const ENTRANCE_MS = AFTER.clear - AFTER.lift;
/** Reduced motion: a fade this long. */
export const ENTRANCE_REDUCED_MS = 1200;

export interface EntranceFrame {
  opacity: number;
  transform: string;
  filter: string;
}

/** Her look at p (0..1 through the entrance); `height` is her slot's height in px (the rise is 2% of it). */
export function entranceFrame(p: number, height: number, reduced: boolean): EntranceFrame {
  const x = Math.max(0, Math.min(1, p));
  if (reduced) return { opacity: ease.soft(x), transform: 'none', filter: 'none' };
  const rise = height * 0.02 * (1 - ease.out(x));
  const r = 1 - ease.inOut(x);
  return {
    opacity: ease.soft(x),
    transform: rise > 0.01 ? `translateY(${rise.toFixed(2)}px)` : 'none',
    filter: r > 0.001 ? `brightness(${(1 + 0.35 * r).toFixed(3)}) blur(${(4 * r).toFixed(2)}px)` : 'none',
  };
}

/** The Web Animations keyframes (sampled; linear between samples). The last frame is her at rest. */
export function entranceKeyframes(height: number, reduced: boolean, steps = 28): Keyframe[] {
  const n = Math.max(2, steps);
  const out: Keyframe[] = [];
  for (let i = 0; i <= n; i++) {
    const f = entranceFrame(i / n, height, reduced);
    out.push({ offset: i / n, opacity: f.opacity, transform: f.transform === 'none' ? 'translateY(0px)' : f.transform, filter: f.filter === 'none' ? 'brightness(1) blur(0px)' : f.filter });
  }
  return out;
}

export function entranceMs(reduced: boolean): number {
  return reduced ? ENTRANCE_REDUCED_MS : ENTRANCE_MS;
}
