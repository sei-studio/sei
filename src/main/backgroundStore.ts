/**
 * Custom app-background image persistence (260724). Follows the userProfile
 * profile-picture pattern: bytes land in a fixed `_bg` slot under the active
 * profile's portraits dir (atomic write + file lock), so the existing
 * `sei-portrait://local/_bg.png` protocol serves it with no new plumbing. The
 * path ref is stored in UserConfig.background_image; the renderer paints it
 * under the theme's window color with user-set opacity/brightness.
 *
 * Validation is a background-sized variant of validatePortrait: same magic
 * checks (PNG/JPEG/WebP), but a wallpaper is allowed to be bigger — the
 * renderer downscales to ≤2560px and compresses before sending.
 */
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../bot/brain/storage/fileLock.js';
import { paths } from './paths';
import { parsePngIhdr } from './skinImageUtil';
import { loadConfig, saveConfig } from './configStore';

const BG_SLOT = '_bg';

export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;
export const BACKGROUND_MAX_DIM = 4096;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

/**
 * Defense-in-depth validation at the main-process trust boundary.
 * Error vocabulary (renderer maps to copy):
 *   BACKGROUND_TOO_LARGE     — bytes > 4 MB
 *   BACKGROUND_TOO_SHORT     — bytes < 24
 *   BACKGROUND_BAD_MAGIC     — not PNG, JPEG, or WebP
 *   BACKGROUND_TOO_LARGE_DIM — PNG width or height > 4096
 */
export function validateBackground(bytes: Buffer): { format: 'png' | 'jpeg' | 'webp' } {
  if (bytes.length > BACKGROUND_MAX_BYTES) {
    throw new Error(`BACKGROUND_TOO_LARGE: ${bytes.length} > ${BACKGROUND_MAX_BYTES}`);
  }
  if (bytes.length < 24) throw new Error('BACKGROUND_TOO_SHORT');

  const isPng = PNG_MAGIC.every((b, i) => bytes[i] === b);
  const isJpeg = JPEG_MAGIC.every((b, i) => bytes[i] === b);
  const isWebp =
    WEBP_RIFF.every((b, i) => bytes[i] === b) && WEBP_TAG.every((b, i) => bytes[8 + i] === b);

  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('BACKGROUND_BAD_MAGIC: must be PNG, JPEG, or WebP');
  }

  if (isPng) {
    const { width, height } = parsePngIhdr(bytes);
    if (width > BACKGROUND_MAX_DIM || height > BACKGROUND_MAX_DIM) {
      throw new Error(`BACKGROUND_TOO_LARGE_DIM: ${width}x${height} > ${BACKGROUND_MAX_DIM}`);
    }
    return { format: 'png' };
  }
  return { format: isJpeg ? 'jpeg' : 'webp' };
}

export async function applyBackgroundImage(bytes: Buffer): Promise<string> {
  validateBackground(bytes);
  const target = paths.portraitPath(BG_SLOT);
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, bytes);
  });
  const ref = `${BG_SLOT}.png`;
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, background_image: ref });
  return ref;
}

export async function removeBackgroundImage(): Promise<void> {
  try {
    await unlink(paths.portraitPath(BG_SLOT));
  } catch {
    /* swallow ENOENT — best-effort */
  }
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, background_image: null });
}
