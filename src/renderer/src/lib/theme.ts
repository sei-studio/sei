/**
 * Theme resolution and application.
 *
 * Four named themes ship (260724):
 *   midnight — the dark "Summoning Terminal" hero (formerly 'dark')
 *   ice      — the pastel-sky light theme (formerly 'light')
 *   acorn    — pastel beige/brown light theme
 *   mint     — green light theme
 *
 * - applyTheme(mode): resolves 'system' to midnight/ice via matchMedia and
 *   writes BOTH `data-theme="<name>"` (per-theme token blocks in tokens.css)
 *   and `data-scheme="light|dark"` (scheme-scoped CSS like the HUD grain and
 *   any TS that needs a light/dark decision) on <html>.
 * - subscribeSystemTheme(cb): listens to prefers-color-scheme changes; only
 *   wired when current themeMode === 'system' (UI-SPEC §Theme toggle).
 * - clampThemeMode(v): maps persisted legacy values ('dark'/'light') and any
 *   unknown junk onto the current vocabulary, so old config.json files keep
 *   working.
 *
 * Source: 04-CONTEXT.md D-33, 04-UI-SPEC.md §Interaction Contracts → Theme toggle.
 */

export type ThemeName = 'midnight' | 'ice' | 'acorn' | 'mint';
export type ThemeMode = 'system' | ThemeName;

export const THEME_NAMES: readonly ThemeName[] = ['midnight', 'ice', 'acorn', 'mint'];

/** Which scheme a theme belongs to — midnight is the only dark theme. */
export function themeScheme(name: ThemeName): 'light' | 'dark' {
  return name === 'midnight' ? 'dark' : 'light';
}

/**
 * Coerce a persisted theme_mode value onto the current vocabulary.
 * Legacy 'dark'→'midnight', 'light'→'ice'; anything unknown → 'system'.
 */
export function clampThemeMode(v: unknown): ThemeMode {
  if (v === 'dark') return 'midnight';
  if (v === 'light') return 'ice';
  if (v === 'system' || (THEME_NAMES as readonly string[]).includes(v as string)) {
    return v as ThemeMode;
  }
  return 'system';
}

function resolveMode(mode: ThemeMode): ThemeName {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'ice';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-scheme', themeScheme(resolved));
}

/**
 * The currently-applied scheme ('light' | 'dark'), read off <html>. The
 * replacement for the old `getAttribute('data-theme') as 'light'|'dark'`
 * pattern now that data-theme carries a theme NAME.
 */
export function resolvedScheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-scheme') === 'dark' ? 'dark' : 'light';
}

export function subscribeSystemTheme(cb: (resolved: 'light' | 'dark') => void): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches ? 'dark' : 'light');
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
