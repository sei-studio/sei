/**
 * Atomic file replace via tmp + rename. Standard Unix idiom — kernel rename(2)
 * is atomic on the same filesystem, so readers either see the old file or the
 * new one, never a partial write.
 *
 * The tmp file MUST live in the same directory as the target (NOT in the
 * system temp dir) — otherwise `rename` may fail with EXDEV across
 * filesystems.
 *
 * No fsync for v1: SPEC/CONTEXT do not require crash-durability for OWNER.md /
 * DIARY.md (single-user local bot, plain markdown that's regenerable).
 *
 * Used by: src/memory/owner.js, src/memory/diary.js (and Plan 3-03 consolidation).
 */

import { writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

/**
 * @param {string} path  Target file path (will be atomically replaced).
 * @param {string} contents  UTF-8 contents to write.
 */
export async function atomicWrite(path, contents) {
  // Tmp filename includes pid + Date.now() to avoid collisions between
  // concurrent writers on the same path. Hidden (`.`) so a directory listing
  // mid-write doesn't expose it.
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}.${Date.now()}`)
  try {
    await writeFile(tmp, contents, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup if rename failed (writeFile succeeded but rename did not).
    try { await unlink(tmp) } catch {}
    throw err
  }
}
