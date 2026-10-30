/**
 * Facepack pilot dev flag (261028).
 *
 * The whole desktop-companion face pipeline (FACE prompt block, say()
 * `expression` parameter, face cue pushes, the dev preview window, the
 * attribution line) is OFF unless BOTH hold:
 *   - the app is unpackaged (`npm run dev`), and
 *   - SEI_FACEPACK_DIR names a directory of baked packs (<dir>/<id>/facepack.json).
 * A packaged build never reads the variable, so production prompts, tools
 * and IPC traffic are byte-identical to before.
 *
 * SEI_FACEPACK_URL (dev only, https or http) is the hook for downloaded packs
 * later: the renderer's URL loader reads <url>/<id>/facepack.json. Nothing
 * fetches it yet unless the preview is pointed at it.
 */
import path from 'node:path';
import { app } from 'electron';

let testOverride: boolean | null = null;

function isUnpackaged(): boolean {
  try {
    // In vitest the 'electron' import is the npm stub (a path string), so
    // `app` is undefined: treat as packaged, i.e. disabled.
    return Boolean(app) && app.isPackaged === false;
  } catch {
    return false;
  }
}

/** Absolute pack directory, or null when the flag is off. */
export function facepackDir(): string | null {
  if (!isUnpackaged()) return null;
  const raw = process.env.SEI_FACEPACK_DIR?.trim();
  return raw ? path.resolve(raw) : null;
}

/** Dev-only remote base for the URL loader hook (never in packaged builds). */
export function facepackBaseUrl(): string | null {
  if (!isUnpackaged()) return null;
  const raw = process.env.SEI_FACEPACK_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().replace(/\/?$/, '/') : null;
  } catch {
    return null;
  }
}

/** The face pipeline is live (prompt block, say() param, cue pushes). */
export function facesEnabled(): boolean {
  if (testOverride !== null) return testOverride;
  return facepackDir() !== null;
}

/** Tests only. null restores the real check. */
export function __setFacesEnabledForTest(on: boolean | null): void {
  testOverride = on;
}
