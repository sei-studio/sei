/**
 * The plain background's colour (261106, first-link v3, product feedback: "start with
 * plain black or white background when the AI spawns in"): black while the
 * computer is in dark mode, white in light mode. Read from the OS through
 * `prefers-color-scheme` (the app never overrides nativeTheme.themeSource, so
 * this is the OS setting in the app window and in the wallpaper host alike)
 * and followed live, so the wallpaper turns over with the OS.
 *
 * The intro (FirstLinkIntroView), RoomCanvas (the wallpaper and the editor)
 * and the dock's glass all take their colours from here, so the intro's end,
 * the editor on the desktop stage and the wallpaper are the same picture.
 */
import { useEffect, useState } from 'react';
import type { RoomOverlay } from '@shared/seilinkDraw';
import type { IntroEndOn } from '@shared/seilinkIntroTelemetry';
import type { RoomState } from '@shared/seilinkRoom';

export type PlainTone = 'dark' | 'light';

/** The two colours (the wallpaper draws exactly these, so the intro's last frame must too). */
export const PLAIN_COLOURS: Readonly<Record<PlainTone, string>> = { dark: '#000000', light: '#ffffff' };

const QUERY = '(prefers-color-scheme: dark)';

export function plainTone(): PlainTone {
  try {
    return window.matchMedia?.(QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/** The OS tone now, following changes. */
export function usePlainTone(): PlainTone {
  const [tone, setTone] = useState<PlainTone>(plainTone);
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    try {
      mql = window.matchMedia?.(QUERY) ?? null;
    } catch {
      mql = null;
    }
    if (!mql) return;
    const on = (): void => setTone(mql!.matches ? 'dark' : 'light');
    on();
    mql.addEventListener?.('change', on);
    return () => mql?.removeEventListener?.('change', on);
  }, []);
  return tone;
}

/** Glass over a plain background (the dock, the editor): the same rule as a room's overlay, light room, light glass. */
export function plainOverlay(tone: PlainTone): RoomOverlay {
  return tone === 'light' ? { color: '#f2f3f7', light: true, ink: '#1d1b22' } : { color: '#1a1c24', light: false, ink: '#f4f1ee' };
}

/** What the intro ends on for this room: the plain colour (by the OS theme) while she has no room yet, else her room. */
export function introEndFor(state: RoomState | null | undefined, tone: PlainTone = plainTone()): IntroEndOn {
  if (state && state.plain !== true) return 'room';
  return tone === 'light' ? 'plain_light' : 'plain_dark';
}
