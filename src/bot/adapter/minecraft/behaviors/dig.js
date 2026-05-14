// src/behaviors/dig.js — single-flight dig with timeout + abort (D-22, Pitfall 2)
import { Vec3 } from 'vec3'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { goTo } from './pathfind.js'
import { firstLine, truncate } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 8000
const PICKUP_TIMEOUT_MS = 3000
export const DIG_REACH = 4.5  // mineflayer's effective reach for breaking blocks

/**
 * Plan 03.1-05 Task 2 (D-W-3, D-W-6): tool description shown to the LLM.
 * Earlier versions buried the `maxDistance:32` semantic and the LLM was
 * reading it as a SWING REACH (so it would walk away thinking "32 blocks is
 * too far") rather than a SEARCH RADIUS for finding the named block.
 * Adding the #N rotation caveat stops the snapshot-handle-stale-target loop
 * (D-W-6 — five identical {target:'#3'} digs after the snapshot rotated).
 * Lives in dig.js so the description sits next to the implementation it
 * describes (orchestrator imports it via ACTION_DESCRIPTIONS).
 */
export const DIG_DESCRIPTION = "Break a block. Prefer `{ block: \"<name>\" }` to dig the NEAREST EXPOSED block of that name within maxDistance (default 32, max 64) — `maxDistance` is a SEARCH RADIUS for finding the named block, not a reach radius. Actual swing reach is fixed at 4.5m and the bot pathfinds into reach automatically. For repeated digs of the same block type, prefer `{block:\"<name>\"}` which auto-finds nearest each call. `#N` references (e.g. {target:\"#3\"}) rotate every snapshot — only valid in the SAME turn the snapshot listed them; switch to `{block:\"<name>\"}` if you see \"stale target\". Use `{ x, y, z }` only when you must dig a precise coordinate. CUBOID MODE: pass `{x,y,z, to:{x,y,z}, hollow?}` to dig every block in the axis-aligned region between two corners (≤256 cells; iteration top-down). See seed_cuboid_grammar for tunnel/room recipes. Air cells are silently skipped."

export const CUBOID_ITERATION_ORDER = 'Y-desc → X-asc → Z-asc' // D-07

export function enumerateDigCells(from, to, hollow) {
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x)
  const minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y)
  const minZ = Math.min(from.z, to.z), maxZ = Math.max(from.z, to.z)
  const cells = []
  for (let y = maxY; y >= minY; y--) {            // Y descending
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (hollow) {
          const isWall = (x === minX || x === maxX || z === minZ || z === maxZ)
          if (!isWall) continue
        }
        cells.push({ x, y, z })
      }
    }
  }
  return cells
}

/**
 * Cuboid dig. Mirrors gatherAction loop discipline: per-cell signal
 * check, pre-pathfind to dig reach (range:3) ONLY when out of reach,
 * skip air cells silently (D-06), accumulate K/N + skipped count.
 */
export async function digCuboid(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  const timeoutMs = config?.pathfinder_timeout_ms ?? 12000
  const from = { x: args.x, y: args.y, z: args.z }
  const cells = enumerateDigCells(from, args.to, args.hollow === true)
  const total = cells.length
  let dug = 0, skippedAir = 0

  for (const c of cells) {
    if (signal?.aborted) return `aborted after ${dug}/${total}`
    const blk = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!blk || blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air') {
      skippedAir++
      config?.onProgress?.({ dug, skippedAir, total, currentY: c.y })
      continue
    }
    const p = bot.entity?.position
    const dist = p ? Math.sqrt((p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2) : Infinity
    if (dist > DIG_REACH) {
      await goTo(bot, c.x, c.y, c.z, 3, timeoutMs)
      if (signal?.aborted) return `aborted after ${dug}/${total}`
    }
    const r = await digAction({ x: c.x, y: c.y, z: c.z }, bot, config)
    if (r === 'aborted') return `aborted after ${dug}/${total}`
    if (typeof r === 'string' && r.startsWith('dug ')) dug++
    config?.onProgress?.({ dug, skippedAir, total, currentY: c.y })
  }
  const skipNote = skippedAir > 0 ? ` (${skippedAir} skipped air)` : ''
  return `dug ${dug}/${total}${skipNote}`
}

/**
 * Dig a block. Single-flight; refuses if another dig is in flight.
 * Returns deterministic *what*-only result strings (D-35) — every failure
 * carries enough context that the LLM does not have to guess (e.g. it does
 * NOT need to invent "I need an axe" from a generic "cannot dig").
 */
export async function digAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // D-01: cuboid mode when `to` is present + explicit from coords.
  if (args.to && typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    return digCuboid(args, bot, config)
  }

  const block = await resolveBlock(args, bot)
  if (!block) return isStaleHandle(args) ? 'stale target' : 'no target'

  const blockName = block.name
  const bx = block.position.x, by = block.position.y, bz = block.position.z

  // Single-flight guard (Pitfall 2: re-entry into mineflayer dig is fatal).
  // Surface what is currently being dug so the LLM doesn't reflexively retry.
  if (bot.targetDigBlock != null) {
    const cur = bot.targetDigBlock
    const cn = cur?.name ?? 'block'
    const cp = cur?.position
    const where = cp ? ` @${cp.x},${cp.y},${cp.z}` : ''
    return `busy digging ${cn}${where}`
  }

  // Reach check — pathfinder is best-effort, the LLM should know it needs to
  // walk closer before issuing another dig at this block.
  const dist = bot.entity?.position?.distanceTo?.(block.position)
  if (typeof dist === 'number' && dist > DIG_REACH) {
    const baseMsg = `out of range (${dist.toFixed(1)}m, need ≤${DIG_REACH}) for ${blockName} @${bx},${by},${bz}`
    const bp = bot.entity?.position
    if (bp && by > bp.y + 2) {
      return `${baseMsg} — unreachable — try build to Y=${by}`
    }
    return baseMsg
  }

  // Distinguish "no block at coord" (snapshot stale, model picked empty
  // space) from "block exists but cannot be broken" (bedrock, water, ...).
  // The held-item suffix is gone — Haiku was reading "with stick" as
  // causal ("stick is wrong tool for log") when the real issue was empty
  // space. (260505-twx)
  if (blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air') {
    return `no block at ${bx},${by},${bz} (target was ${blockName})`
  }
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
    return `cannot break ${blockName} at ${bx},${by},${bz} (unbreakable or wrong tool)`
  }

  const timeoutMs = args.timeout_ms ?? config?.dig_timeout_ms ?? DEFAULT_TIMEOUT_MS

  // Capture position before the block disappears — drop spawns at this location.
  const dropPos = { x: bx, y: by, z: bz }
  let pickupNote = ''

  const op = bot.dig(block)
    .then(async () => {
      // Walk onto the drop so mineflayer's auto-pickup fires. Best-effort:
      // bounded timeout, ignore result (if blocked, we still dug successfully).
      try {
        const r = await goTo(bot, dropPos.x, dropPos.y, dropPos.z, 0, PICKUP_TIMEOUT_MS)
        if (r !== 'reached') pickupNote = ' (pickup walk did not reach)'
      } catch {}
      return `dug ${blockName}${pickupNote}`
    })
    .catch((err) => {
      // Distinguish target-already-changed from generic dig failures.
      const reason = truncate(firstLine(err?.message ?? err), 80)
      // If the block at the original coords no longer matches, mineflayer
      // tends to throw something like "Block changed" / "out of range".
      try {
        const live = bot.blockAt?.(block.position)
        if (!live || live.name !== blockName) {
          return `target changed (was ${blockName} @${bx},${by},${bz}, now ${live?.name ?? 'unknown'})`
        }
      } catch {}
      return reason
        ? `dig failed: ${reason}`
        : `dig failed for ${blockName} @${bx},${by},${bz}`
    })

  const tmo = new Promise((r) => setTimeout(() => {
    try { bot.stopDigging() } catch {}
    r(`timeout digging ${blockName} @${bx},${by},${bz}`)
  }, timeoutMs))

  const abrt = new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', () => {
      try { bot.stopDigging() } catch {}
      r('aborted')
    }, { once: true })
  })

  return Promise.race([op, tmo, abrt])
}
