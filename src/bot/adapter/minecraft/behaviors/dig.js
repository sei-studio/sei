// src/behaviors/dig.js — single-flight dig with timeout + abort (D-22, Pitfall 2)
import { Vec3 } from 'vec3'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { goTo, stopPathfinderDig, dropWalkOpts } from './pathfind.js'
import { equipBestTool, harvestNote } from './toolSelect.js'
import { firstLine, truncate } from '../../../brain/errStrings.js'

export const DEFAULT_TIMEOUT_MS = 8000
// Hard ceiling on the derived timeout below. Anything that needs longer than
// this with the best tool we own (obsidian bare-handed is ~250s) is not worth
// standing still for — the timeout is the give-up.
export const MAX_TIMEOUT_MS = 30000
const PICKUP_TIMEOUT_MS = 3000
// Walks aim to end within this of the block (eyes to center; the goal is
// DIG_REACH - 0.3 per cell), and a block farther than this triggers a walk.
export const DIG_REACH = 4.5
/**
 * The farthest block digAction will swing at (eyes to block center).
 *
 * 261107 (quality pass 45): the refusal used to be DIG_REACH too, but a walk
 * cannot promise to end inside it. The pathfinder's goal is checked on the
 * CELL the feet are in (its center), and the walk stops as soon as the body is
 * within 0.35 of the last node on each axis, so a walk aimed at 4.2 ends with
 * the eyes up to ~0.7 farther. Free play showed it on every gather_craft run:
 * "out of range (4.5m, need ≤4.5) ... (the walk toward it ended: reached)",
 * 4.5 to 5.0m, then the block was marked unreachable and she walked off to
 * find stone that was under her feet. Nothing about the block stops that dig:
 * mineflayer's canDigBlock allows 5.1 from the eyes (it uses 1.65 for them,
 * we use 1.62) and the 1.21 server checks 4.5 + 1 to the block's box.
 */
export const DIG_MAX_REACH = 5.0

/**
 * Distance that decides whether a block is in dig reach: from the bot's EYES
 * to the block's CENTER, the way mineflayer's canDigBlock and the server
 * measure it (mineflayer allows 5.1; see DIG_MAX_REACH).
 *
 * 261011: this used to be feet to the block's min corner, which reads a log
 * five blocks up the trunk as 5.0m away while the eyes are 3.9m from it, so
 * every tree's top log came back "out of range" from the spot it could have
 * been dug from, and gather stopped short.
 */
export function digReachDistance(bot, pos) {
  const p = bot?.entity?.position
  if (!p || !pos) return Infinity
  const eye = Number.isFinite(bot.entity?.eyeHeight) ? bot.entity.eyeHeight : 1.62
  return Math.hypot(pos.x + 0.5 - p.x, pos.y + 0.5 - (p.y + eye), pos.z + 0.5 - p.z)
}

// A dig that came back out of range this close after its walk gets one more
// short walk, aimed well inside reach (see closeInForDig).
export const CLOSE_IN_MAX_M = DIG_MAX_REACH + 1.5
const CLOSE_IN_REACH = DIG_REACH - 1.0
const CLOSE_IN_TIMEOUT_MS = 4000

/**
 * 261107 (pass 45): one more short walk toward a block a dig just found out of
 * range, when it is only a step or two too far (the walk before it stopped at
 * the edge of its goal). Aims well inside reach, so where the walk stops in
 * its last cell no longer decides the dig. Returns the walk result, or null
 * when the block is too far for a step to help (that walk already failed).
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} pos
 * @param {Function} goTo pathfind.goTo (or a test double)
 * @param {AbortSignal} [signal]
 * @param {object} [walkOpts] extra goTo opts (keepItems)
 */
export async function closeInForDig(bot, pos, goTo, signal, walkOpts = {}) {
  const d = digReachDistance(bot, pos)
  if (!Number.isFinite(d) || d <= DIG_MAX_REACH || d > CLOSE_IN_MAX_M) return null
  if (signal?.aborted) return 'aborted'
  return goTo(bot, pos.x, pos.y, pos.z, 2, CLOSE_IN_TIMEOUT_MS, signal, { ...walkOpts, reach: CLOSE_IN_REACH })
}

// LLM-facing tool description moved to ../prompts.js → ACTION_DESCRIPTIONS.dig.

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
    const dist = digReachDistance(bot, c)
    if (dist > DIG_REACH) {
      await goTo(bot, c.x, c.y, c.z, 3, timeoutMs, signal, { reach: DIG_REACH - 0.3 })
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

  // A dig left running by a walk's pathfinder (a route that breaks a block)
  // is not ours: cancel it rather than refusing. 261011: the walk onto a
  // drop timed out while the pathfinder was breaking the log above it, and
  // every later dig of that tree answered "busy digging".
  if (bot.targetDigBlock != null && !(bot._seiDigActive > 0)) {
    stopPathfinderDig(bot)
    await new Promise((r) => setTimeout(r, 60))
  }

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
  const dist = digReachDistance(bot, block.position)
  if (Number.isFinite(dist) && dist > DIG_MAX_REACH) {
    const baseMsg = `out of range (${dist.toFixed(1)}m, need ≤${DIG_MAX_REACH.toFixed(1)}) for ${blockName} @${bx},${by},${bz}`
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
  // 260731: the old message here said "unbreakable or wrong tool", but
  // mineflayer's canDigBlock only checks diggability + reach — it has never
  // looked at the held item, so the tool half of that sentence was a lie the
  // model kept acting on.
  if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
    return `cannot break ${blockName} at ${bx},${by},${bz} (unbreakable)`
  }

  // Auto-equip the best tool we own for this block (see toolSelect.js). Runs
  // before every swing, including each cell of a cuboid and each block of a
  // gather; it no-ops when the right thing is already in hand, so the cost of
  // the common case is one digTime comparison per inventory item.
  const { ms: estMs, harvest } = await equipBestTool(bot, block, config)
  if (signal?.aborted) return 'aborted'

  // Derive the timeout from the ACTUAL expected dig time rather than trusting a
  // flat 8s. Bare-handed stone is 7500ms and used to lose the race under any
  // latency; a diamond pickaxe on the same block wants nowhere near 8s.
  const derived = Number.isFinite(estMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, Math.ceil(estMs * 2) + 2000))
    : DEFAULT_TIMEOUT_MS
  const timeoutMs = args.timeout_ms ?? config?.dig_timeout_ms ?? derived

  // Capture position before the block disappears — drop spawns at this location.
  const dropPos = { x: bx, y: by, z: bz }
  let pickupNote = ''

  bot._seiDigActive = (bot._seiDigActive ?? 0) + 1
  let digReleased = false
  const releaseDig = () => {
    if (digReleased) return
    digReleased = true
    bot._seiDigActive = Math.max(0, (bot._seiDigActive ?? 1) - 1)
  }
  const op = bot.dig(block)
    .then(async () => {
      releaseDig()
      // Walk onto the drop so mineflayer's auto-pickup fires. Best-effort:
      // bounded timeout, ignore result (if blocked, we still dug successfully).
      //
      // 260709: walk to where the drop LANDS, not to the block's original
      // coords. Items fall — a trunk log dug 3 blocks up drops to the ground,
      // but pathing to the old mid-air coordinate made the pathfinder CLIMB
      // (scaffold up the tree, burn the timeout, end up on the canopy). That
      // was the live tree-hopping bug: after each high log the bot stood on
      // top of a tree, and the "nearest remaining log" from up there was the
      // next tree over. Scan down to the first solid block below the drop
      // (bounded) and walk to the air cell above it.
      try {
        let ly = dropPos.y
        for (let i = 0; i < 12; i++) {
          const below = bot.blockAt?.(new Vec3(dropPos.x, ly - 1, dropPos.z))
          if (!below || !/^(air|cave_air|void_air|water)$/.test(below.name)) break
          ly--
        }
        // Range 1 is close enough for auto-pickup (the pickup box reaches a
        // block past the body). Under a tree the walk may not break anything
        // (it would start chopping the trunk); a stone or ore drop sits in the
        // hole it left and the walk may dig its way in (dropWalkOpts).
        // 261025: with the action's signal, so a stop ends this walk too
        // instead of leaving the pathfinder walking for up to 3s.
        const r = await goTo(bot, dropPos.x, ly, dropPos.z, 1, PICKUP_TIMEOUT_MS, signal, dropWalkOpts(blockName))
        if (r !== 'reached') pickupNote = ' (pickup walk did not reach)'
      } catch {}
      return `dug ${blockName}${pickupNote}${harvest ? '' : harvestNote(blockName)}`
    })
    .catch((err) => {
      releaseDig()
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

  // Tear the timer + abort listener down when the race settles. Previously the
  // timeout's setTimeout leaked: after a dig resolved normally, its stale timer
  // still fired ~timeoutMs later and called bot.stopDigging() — but by then the
  // gather/cuboid loop had MOVED ON, so it aborted the *next* block mid-swing.
  // That is the "breaks a block most of the way, then cancels and skips to
  // another" symptom. (Each gather iteration also leaked an abort listener on
  // the shared signal.) (260617)
  let timer = null
  let onAbort = null
  const cleanup = () => {
    releaseDig()
    if (timer) { clearTimeout(timer); timer = null }
    if (onAbort && signal) { signal.removeEventListener('abort', onAbort); onAbort = null }
  }

  const tmo = new Promise((r) => {
    timer = setTimeout(() => {
      try { bot.stopDigging() } catch {}
      r(`timeout digging ${blockName} @${bx},${by},${bz}`)
    }, timeoutMs)
  })

  const abrt = new Promise((r) => {
    if (!signal) return
    onAbort = () => {
      try { bot.stopDigging() } catch {}
      r('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return Promise.race([op, tmo, abrt]).finally(cleanup)
}
