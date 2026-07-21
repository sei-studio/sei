/**
 * Voice-sample disk cache (260720) — MAIN only.
 *
 * The creation picker's per-voice sample line is identical for every play, so
 * each (voiceId, sample text) pair is synthesized at most once per machine:
 * the mp3 bytes land in `<userData>/voice-preview-cache/` and every repeat
 * play is served from disk for free. The text is part of the key (hashed), so
 * a changed sample line or a conversation-language switch naturally misses the
 * old entries instead of replaying stale audio.
 *
 * The cache is strictly best-effort: any filesystem or electron failure makes
 * reads miss and writes no-op — the picker then just synthesizes as before.
 * `previewCacheKey` is pure (no electron import) so it is unit-testable.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

const CACHE_DIR_NAME = 'voice-preview-cache';

/**
 * Cache filename for one (voiceId, sample text) pair. Deterministic; the
 * voice id is sanitized to filename-safe characters and the text contributes
 * through a sha256 prefix, so ids stay recognizable on disk while the exact
 * spoken line (and therefore language) is pinned by the hash.
 */
export function previewCacheKey(voiceId: string, text: string): string {
  const safeId = voiceId.replace(/[^A-Za-z0-9_-]/g, '_');
  const hash = createHash('sha256').update(`${voiceId}\n${text}`, 'utf8').digest('hex').slice(0, 16);
  return `${safeId}-${hash}.mp3`;
}

async function cacheDir(): Promise<string | null> {
  try {
    const { app } = await import('electron');
    return path.join(app.getPath('userData'), CACHE_DIR_NAME);
  } catch {
    return null; // non-electron context (tests) — cache disabled
  }
}

/** Cached sample bytes for `key`, or null on any miss/failure. */
export async function readCachedPreview(key: string): Promise<ArrayBuffer | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path.join(dir, key));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
}

/** Persist sample bytes under `key` (best-effort; failures are swallowed). */
export async function writeCachedPreview(key: string, bytes: ArrayBuffer): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  try {
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated mp3 that
    // every later play would faithfully serve.
    const file = path.join(dir, key);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, Buffer.from(bytes));
    await rename(tmp, file);
  } catch (err) {
    console.warn(`[sei/voice] preview cache write failed: ${(err as Error).message}`);
  }
}
