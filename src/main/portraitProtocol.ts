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

// Filenames we will serve: `<uuid>.png`. Restricting the charset + extension
// (combined with path.basename below) keeps the request inside the portraits
// dir — no traversal via `..` or absolute paths.
const SAFE_FILE_RE = /^[0-9a-f-]+\.png$/i;

/** Register the privileged scheme. MUST be called before app 'ready'. */
export function registerPortraitScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PORTRAIT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Attach the request handler. MUST be called after app 'ready'. */
export function registerPortraitProtocol(): void {
  protocol.handle(PORTRAIT_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.basename(decodeURIComponent(pathname));
    if (!SAFE_FILE_RE.test(file)) {
      return new Response('bad request', { status: 400 });
    }
    const uuid = file.replace(/\.png$/i, '');
    try {
      const bytes = await readFile(paths.portraitPath(uuid));
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          // Portrait bytes change in place on re-upload (same uuid → same URL),
          // so forbid caching to avoid a stale thumbnail surviving a "Change".
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    } catch {
      // Missing file → 404 so the renderer's <img onError> falls back to the
      // procedural sprite (D-14), exactly as a deleted portrait should.
      return new Response('not found', { status: 404 });
    }
  });
}
