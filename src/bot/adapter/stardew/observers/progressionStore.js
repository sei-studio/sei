// The Stardew progression latches on disk (261113), one record per farm, so a
// re-summon (a new bot process) keeps what the last session reached: the
// rungs done, the deepest mine level, the places visited. Before this every
// summon started the frontier from scratch and offered "walk to town" and
// "clear a patch" again on a farm in its second season.
//
// File: <character memory dir>/stardew-progress.json
//   { "<save unique id>": { flags, visited, doneNodes, mineLevel, ... , at } }
// Small, local, best-effort: a missing or broken file is an empty record.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** At most this many farms are kept (the oldest is dropped). */
export const MAX_FARMS = 20

/**
 * @param {string|null} file  the JSON path, or null for no persistence
 * @param {{ now?: () => number }} [opts]
 */
export function createProgressionStore(file, { now = () => Date.now() } = {}) {
  const readAll = () => {
    if (!file) return {}
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }
  return {
    /** The saved record for one farm, or null. */
    load(saveId) {
      if (!file || !saveId) return null
      const rec = readAll()[String(saveId)]
      return rec && typeof rec === 'object' ? rec : null
    },
    /** Replace one farm's record (atomic rename). Never throws. */
    save(saveId, record) {
      if (!file || !saveId) return false
      try {
        const all = readAll()
        all[String(saveId)] = { ...record, at: now() }
        const ids = Object.keys(all)
        if (ids.length > MAX_FARMS) {
          ids.sort((a, b) => (Number(all[a]?.at) || 0) - (Number(all[b]?.at) || 0))
          for (const id of ids.slice(0, ids.length - MAX_FARMS)) delete all[id]
        }
        mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(all))
        renameSync(tmp, file)
        return true
      } catch {
        return false
      }
    },
  }
}

/** The store file for a bot config (next to the character's MEMORY.md), or null. */
export function progressionFileFor(config) {
  const mem = config?.memory?.memory_md_path
  if (typeof mem !== 'string' || !mem.trim()) return null
  return path.join(path.dirname(mem), 'stardew-progress.json')
}
