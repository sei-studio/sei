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

// 260909 — per-ref cache-buster. A bare '<uuid>.png' ref keeps the SAME URL
// when its bytes change in place (regenerate / select a stored version), so
// an <img> that already shows the old bytes never refetches even though the
// protocol answers with no-store headers. bumpPortraitRef(ref) after such a
// swap makes every subsequent portraitSrc(ref) carry a fresh `?v=` so the
// next render (the store refresh re-renders every consumer) repaints. The
// protocol handler reads only the pathname, so the query is inert server-side.
const busts = new Map<string, number>();

export function bumpPortraitRef(ref: string | null | undefined): void {
  if (!ref) return;
  busts.set(ref, (busts.get(ref) ?? 0) + 1);
}

export function portraitSrc(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // Already a loadable absolute URL (cloud Supabase, data:, blob:, or our scheme).
  if (ABSOLUTE_URL_RE.test(ref)) return ref;
  // Bundled defaults ship as renderer assets stored with a path ('./img/x.png').
  // Anything carrying a '/' is renderer-relative and already loadable — pass through.
  if (ref.includes('/')) return ref;
  // Bare '<uuid>.png' → a user-uploaded portrait on disk in the active profile's
  // portraits dir, reachable only via the sei-portrait:// protocol.
  const v = busts.get(ref);
  return v ? `sei-portrait://local/${ref}?v=${v}` : `sei-portrait://local/${ref}`;
}
