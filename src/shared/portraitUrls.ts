/**
 * Versioned portrait / World-thumbnail URLs (261111, Supabase egress fix).
 *
 * Portraits are overwritten in place at `portraits/<owner>/<id>.png`, and
 * new uploads carry a 7-day cache-control (PORTRAIT_CACHE_CONTROL). A bare
 * URL could therefore keep serving an old image from the CDN or the Chromium
 * disk cache, so every URL the app builds for them carries
 * `?v=<characters.updated_at>`. The row's updated_at changes whenever the
 * portrait does (the app upserts the row on every save, and the proxy's
 * thumbnail route touches it again after writing the thumbnail), so a new
 * image is always a new URL, and an unchanged one is a cache hit (0 bytes).
 *
 * The World grid shows `portraits/<owner>/<id>.thumb.webp` (a 512 x 683-cover
 * WebP made by sei-proxy POST /portraits/v1/:id/thumb). Characters shared
 * before that route existed may have no thumbnail yet: the card then falls
 * back to the full portrait (browseArtSources).
 *
 * Pure (no Node / Electron imports): shared by main (browse:list) and the
 * renderer (BrowseCard, the first-rows preloader).
 */

/**
 * Seven days, seconds, as supabase-js `cacheControl` wants it. Not a year:
 * originals are overwritten in place and pre-0.7 apps load the bare URL, so a
 * long max-age would show them a replaced portrait for that long. A week still
 * makes repeat views free. (Thumbnails, read only through `?v=` URLs, keep a
 * year: proxy portraits/thumb.ts.)
 */
export const PORTRAIT_CACHE_CONTROL = '604800';

/** Bucket-relative path of a character's World thumbnail (derived, no DB column). */
export function portraitThumbPath(ownerUuid: string, characterUuid: string): string {
  return `${ownerUuid}/${characterUuid}.thumb.webp`;
}

/**
 * `url` with `v=<version>` appended (URL-encoded). Returns `url` unchanged for
 * an empty version so callers never produce `?v=`.
 */
export function withVersion(url: string, version: string | null | undefined): string {
  if (!version) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}v=${encodeURIComponent(version)}`;
}

/** What a World card loads: the thumbnail first, the full portrait if it fails. */
export interface BrowseArtSources {
  primary: string | null;
  fallback: string | null;
}

export function browseArtSources(entry: { thumbUrl?: string | null; portraitUrl: string | null }): BrowseArtSources {
  const thumb = entry.thumbUrl ?? null;
  const full = entry.portraitUrl ?? null;
  if (thumb) return { primary: thumb, fallback: full && full !== thumb ? full : null };
  return { primary: full, fallback: null };
}
