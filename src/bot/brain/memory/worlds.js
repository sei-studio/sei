/**
 * World registry — per-character map of the LAN worlds this character has
 * joined, so memories and game-state can be organized by world.
 *
 * Why: a character accumulates memories across many worlds over time. Without
 * world separation it gets confused — progress and relationships from world A
 * bleed into world B. We assign each distinct world a STABLE small number
 * (1, 2, 3 …) keyed by a fingerprint derived from the world's spawn point, and:
 *   - record it in worlds.json next to MEMORY.md,
 *   - drop a `## World <n> — <label>` section header into MEMORY.md on join
 *     (only when the world changes), so the memory log reads as world-segmented,
 *   - expose `current()` so the per-turn snapshot can tell the bot which world
 *     it's standing in.
 *
 * The fingerprint is the world spawn (floored) + dimension — deterministic from
 * the seed, stable across sessions, and different per world. The LAN port is
 * NOT used (it changes every time the host re-opens to LAN).
 *
 * worlds.json shape:
 *   { version: 1, worlds: [{ num, fingerprint, label, firstSeen, lastSeen }] }
 */

import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../storage/atomicWrite.js'
import { withFileLock } from '../storage/fileLock.js'

/**
 * @param {Object} opts
 * @param {string} opts.worldsPath           Path to worlds.json (sibling of MEMORY.md).
 * @param {Object} [opts.memoryLog]          createMemoryLog() instance — used for .noteWorld().
 * @param {{warn?:Function,info?:Function}} [opts.logger]
 */
export function createWorldRegistry({ worldsPath, memoryLog, logger = console } = {}) {
  if (!worldsPath) throw new Error('createWorldRegistry: worldsPath required')
  let current = null // { num, label } for this session, once resolved

  async function readRegistry() {
    try {
      const raw = await readFile(worldsPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.worlds)) return parsed
    } catch {
      /* ENOENT or parse error → start fresh */
    }
    return { version: 1, worlds: [] }
  }

  /**
   * Resolve (or assign) the world number for this session's fingerprint,
   * persist the registry, and append a section header to MEMORY.md when the
   * world differs from the last one written. Idempotent across re-spawns in the
   * same session (noteWorld skips a duplicate trailing header).
   *
   * @param {{ fingerprint: string, label?: string, when?: Date }} args
   * @returns {Promise<{num:number,label:string}|null>}
   */
  async function resolveOnSpawn({ fingerprint, label, when } = {}) {
    if (!fingerprint) return null
    const ts = (when instanceof Date ? when : new Date()).toISOString()
    let resolved = null
    try {
      await withFileLock(worldsPath, async () => {
        const reg = await readRegistry()
        let entry = reg.worlds.find((w) => w.fingerprint === fingerprint)
        if (entry) {
          entry.lastSeen = ts
          if (label && !entry.label) entry.label = label
        } else {
          const num = reg.worlds.reduce((m, w) => Math.max(m, w.num || 0), 0) + 1
          entry = { num, fingerprint, label: label || `World ${num}`, firstSeen: ts, lastSeen: ts }
          reg.worlds.push(entry)
        }
        await atomicWrite(worldsPath, JSON.stringify(reg, null, 2) + '\n')
        resolved = { num: entry.num, label: entry.label }
      })
    } catch (err) {
      logger.warn?.(`[sei/worlds] resolve failed: ${err.message}`)
      return null
    }
    if (resolved) {
      current = resolved
      if (memoryLog?.noteWorld) {
        try {
          await memoryLog.noteWorld(resolved.num, resolved.label)
        } catch (err) {
          logger.warn?.(`[sei/worlds] noteWorld failed: ${err.message}`)
        }
      }
    }
    return resolved
  }

  return {
    resolveOnSpawn,
    /** The world resolved for this session, or null until the first spawn. */
    current: () => current,
  }
}
