/**
 * `sei-portrait://` custom protocol — serves locally-stored character portraits
 * to the renderer.
 *
 * Why this exists: D-28 writes portrait bytes to
 * `<userData>/profiles/<scope>/portraits/<uuid>.png` and stores only the bare
 * reference `'<uuid>.png'` in `character.portrait_image`. The sandboxed renderer
 * has no way to load that on-disk file via a relative `<img src>` — it would
 * resolve against the Vite dev server / `file://…/renderer/` and 404, so the
 * portrait silently fell back to the procedural sprite everywhere. This protocol
 * is the missing render-time resolver: the renderer's `portraitSrc()` helper maps
 * a bare ref onto `sei-portrait://local/<uuid>.png`, and this handler streams the
 * file back from the active profile's portraits dir.
 *
 * Always resolves against the *active* profile scope (`paths.portraitPath`), which
 * is correct because the renderer only ever displays the active profile's library.
 *
 * Two-step registration (Electron requirement):
 *   1. registerPortraitScheme()  — before app 'ready' (privileged scheme table)
 *   2. registerPortraitProtocol() — after app 'ready' (request handler)
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths';

export const PORTRAIT_SCHEME = 'sei-portrait';

// Filenames we will serve: `<uuid>.png` (character portraits) plus the fixed
// user-profile slot `_user.png`. Restricting the charset + extension (combined
// with path.basename below) keeps the request inside the portraits dir — no
// traversal via `..` or absolute paths. The charset allows a-z, digits, dash
// and underscore so the `_user` slot resolves (the old `[0-9a-f-]` hex-only set
// rejected it → 400 → the player's avatar silently fell back everywhere).
const SAFE_FILE_RE = /^[0-9a-z_-]+\.png$/i;

// ── First-load 404 race ────────────────────────────────────────────────────
// A `sei-portrait://` request only fires when a character's `portrait_image`
// is a bare `'<uuid>.png'` ref — i.e. the app already believes a portrait
// exists. But the PNG bytes are written ASYNCHRONOUSLY and independently of
// that ref becoming visible to the renderer:
//   - portraitStore.applyPortrait writes bytes THEN saves the ref (safe order);
//   - cache-on-demand (cloud/cacheOnDemand.ts) saves the character JSON with
//     the cloud portrait ref via saveCharacterRaw and only THEN downloads +
//     atomic-writes the bytes (writePortrait / healMissingAssets).
// In the second case a card can render and request the URL in the window
// between the ref appearing and the download's rename landing. The read throws
// ENOENT → 404 → PixelPortrait's `<img onError>` latches `imgFailed` and pins
// permanently to the procedural sprite; only a later remount (bytes now on
// disk) recovers — the reported "404 on first load, works after a reload" bug.
//
// Every writer lands the file via atomicWrite (writeFile → rename), and
// rename(2) is atomic on the same filesystem, so a reader sees the file either
// absent or complete — never torn. That makes a short bounded ENOENT retry the
// correct, writer-agnostic fix: it turns the race into a brief wait, resolving
// 200 the instant the write lands. Only a genuinely-absent portrait (deleted,
// or a download that failed yet still adopted the ref) falls through to 404
// after the budget, exactly as a missing portrait should. Non-ENOENT errors
// (EACCES, EISDIR, …) are hard failures and are surfaced immediately.
const PORTRAIT_READ_RETRIES = 12;
const PORTRAIT_READ_RETRY_DELAY_MS = 60; // ~720ms total budget, run per-request

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read portrait bytes, retrying on ENOENT to ride out the write-race window
 * described above. Exported for direct unit testing (the protocol handler
 * itself needs a live Electron `protocol.handle`).
 *
 * @param filePath absolute path to the portrait PNG
 * @param retries  ENOENT retry attempts after the first read (default budget)
 * @param delayMs  delay between attempts
 */
export async function readPortraitWithRetry(
  filePath: string,
  retries: number = PORTRAIT_READ_RETRIES,
  delayMs: number = PORTRAIT_READ_RETRY_DELAY_MS,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' || attempt >= retries) throw err;
      await delay(delayMs);
    }
  }
}

/** Register the privileged scheme. MUST be called before app 'ready'. */
export function registerPortraitScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PORTRAIT_SCHEME,
      // corsEnabled + the ACAO header below let the renderer fetch() portrait
      // bytes cross-origin (dev origin is http://localhost:5173) — needed for
      // canvas color extraction (useDominantColor); a plain <img> src doesn't
      // allow readback from a custom scheme.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Attach the request handler. MUST be called after app 'ready'. */
export function registerPortraitProtocol(): void {
  protocol.handle(PORTRAIT_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.basename(decodeURIComponent(pathname));
    if (!SAFE_FILE_RE.test(file)) {
      return new Response('bad request', {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    const uuid = file.replace(/\.png$/i, '');
    try {
      const bytes = await readPortraitWithRetry(paths.portraitPath(uuid));
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          // Portrait bytes change in place on re-upload (same uuid → same URL),
          // so forbid caching to avoid a stale thumbnail surviving a "Change".
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          // Local-only bytes the renderer already displays; * lets fetch()
          // succeed from both the dev (http://localhost:5173) and packaged
          // origins for color extraction.
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      // Still absent after the ENOENT retry budget (or a hard read error) →
      // 404 so the renderer's <img onError> falls back to the procedural sprite
      // (D-14), exactly as a deleted / genuinely-missing portrait should.
      return new Response('not found', {
        status: 404,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
  });
}
