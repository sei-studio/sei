/**
 * Phase 11 D-28 — Portrait validation (defense-in-depth).
 *
 * Source: 11-RESEARCH §Code Example 4 + §Pattern 5.
 * Reuses skinImageUtil's PNG IHDR parser for PNG dimension check.
 * JPEG/WebP dimensions trust the renderer canvas-resize upstream.
 *
 * Error vocabulary (renderer maps to copy):
 *   PORTRAIT_TOO_LARGE      — bytes > 500 KB
 *   PORTRAIT_TOO_SHORT      — bytes < 24
 *   PORTRAIT_BAD_MAGIC      — not PNG, JPEG, or WebP
 *   PORTRAIT_TOO_LARGE_DIM  — PNG width or height > 1024
 */

import { parsePngIhdr } from './skinImageUtil';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

export const PORTRAIT_MAX_BYTES = 500 * 1024;
export const PORTRAIT_MAX_DIM = 1024;

export function validatePortrait(bytes: Buffer): { format: 'png' | 'jpeg' | 'webp' } {
  if (bytes.length > PORTRAIT_MAX_BYTES) {
    throw new Error(`PORTRAIT_TOO_LARGE: ${bytes.length} > ${PORTRAIT_MAX_BYTES}`);
  }
  if (bytes.length < 24) throw new Error('PORTRAIT_TOO_SHORT');

  const isPng = PNG_MAGIC.every((b, i) => bytes[i] === b);
  const isJpeg = JPEG_MAGIC.every((b, i) => bytes[i] === b);
  const isWebp =
    WEBP_RIFF.every((b, i) => bytes[i] === b) &&
    WEBP_TAG.every((b, i) => bytes[8 + i] === b);

  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('PORTRAIT_BAD_MAGIC: must be PNG, JPEG, or WebP');
  }

  if (isPng) {
    const { width, height } = parsePngIhdr(bytes);
    if (width > PORTRAIT_MAX_DIM || height > PORTRAIT_MAX_DIM) {
      throw new Error(`PORTRAIT_TOO_LARGE_DIM: ${width}x${height} > ${PORTRAIT_MAX_DIM}`);
    }
    return { format: 'png' };
  }
  return { format: isJpeg ? 'jpeg' : 'webp' };
}
