/**
 * Atomic file replace via tmp + rename. Standard Unix idiom — kernel rename(2)
 * is atomic on the same filesystem, so readers either see the old file or the
 * new one, never a partial write.
 *
 * The tmp file MUST live in the same directory as the target (NOT in the
 * system temp dir) — otherwise `rename` may fail with EXDEV across
 * filesystems.
 *
 * No fsync for v1: SPEC/CONTEXT do not require crash-durability for PLAYER.md /
 * MEMORY.md (single-user local bot, plain markdown that's regenerable).
 *
 * Used by: src/bot/brain/memory/player.js, src/bot/brain/memory/memoryLog.js.
 */

import { writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

/**
 * @param {string} path  Target file path (will be atomically replaced).
 * @param {string | Uint8Array} contents  Contents to write. Strings go out as
 *   UTF-8 (legacy default for OWNER.md/DIARY.md callers); Uint8Array / Buffer
 *   inputs (for binary PNGs under <userData>/skins/) are written as raw
 *   bytes with no encoding transform.
 */
export async function atomicWrite(path, contents) {
  // Tmp filename includes pid + Date.now() to avoid collisions between
  // concurrent writers on the same path. Hidden (`.`) so a directory listing
  // mid-write doesn't expose it.
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
  try {
    // 260517: if `contents` is a Buffer / Uint8Array, omit
    // the encoding arg so Node writes raw bytes. The previous hardcoded
    // 'utf8' silently corrupted PNGs (non-UTF-8 byte sequences got replaced
    // by U+FFFD). String inputs preserve the legacy UTF-8 behavior.
    if (typeof contents === 'string') {
      await writeFile(tmp, contents, 'utf8')
    } else {
      await writeFile(tmp, contents)
    }
    await rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup if rename failed (writeFile succeeded but rename did not).
    try { await unlink(tmp) } catch {}
    throw err
  }
}
