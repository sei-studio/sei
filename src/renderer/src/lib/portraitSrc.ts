/**
 * Resolve a character's `portrait_image` reference into a renderer-loadable URL.
 *
 * `portrait_image` comes in three shapes, each already-loadable except the last:
 *   - cloud / Browse entries → a full `https://…` Supabase Storage URL.
 *   - bundled default-character portraits → a renderer-relative static asset
 *     path, e.g. `'./img/sui.png'` (the PNG ships in src/renderer/public/img/
 *     and is served at `/img/sui.png`). Any ref that carries a path is
 *     renderer-relative and loads as-is.
 *   - user-uploaded portraits (D-28) → a *bare* `'<uuid>.png'` reference. The
 *     bytes live at `<userData>/profiles/<scope>/portraits/<uuid>.png`, which the
 *     sandboxed renderer cannot reach via a relative `<img src>` (it would
 *     resolve against the Vite dev server / `file://…/renderer/` and 404). Only
 *     these map onto the `sei-portrait://` protocol (src/main/portraitProtocol.ts).
 *
 * Returns null for a nullish ref so callers fall back to the procedural
 * PixelPortrait sprite (D-14).
 */

const ABSOLUTE_URL_RE = /^(?:https?|data|blob|file|sei-portrait):/i;

export function portraitSrc(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // Already a loadable absolute URL (cloud Supabase, data:, blob:, or our scheme).
  if (ABSOLUTE_URL_RE.test(ref)) return ref;
  // Bundled defaults ship as renderer assets stored with a path ('./img/x.png').
  // Anything carrying a '/' is renderer-relative and already loadable — pass through.
  if (ref.includes('/')) return ref;
  // Bare '<uuid>.png' → a user-uploaded portrait on disk in the active profile's
  // portraits dir, reachable only via the sei-portrait:// protocol.
  return `sei-portrait://local/${ref}`;
}
