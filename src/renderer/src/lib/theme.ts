/**
 * Theme resolution and application.
 *
 * - applyTheme(mode): resolves 'system' to light/dark via matchMedia and writes
 *   data-theme attribute on <html>; tokens.css picks up via :root[data-theme="dark"].
 * - subscribeSystemTheme(cb): listens to prefers-color-scheme changes; only
 *   wired when current themeMode === 'system' (UI-SPEC §Theme toggle).
 *
 * Source: 04-CONTEXT.md D-33, 04-UI-SPEC.md §Interaction Contracts → Theme toggle.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute('data-theme', resolved);
}

export function subscribeSystemTheme(cb: (resolved: 'light' | 'dark') => void): () => void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => cb(e.matches ? 'dark' : 'light');
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
