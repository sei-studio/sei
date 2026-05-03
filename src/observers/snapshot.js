// src/observers/snapshot.js — composes line-oriented world snapshot (D-26)
// and registers #N targeting handles via setHandles() (D-25).
import { vitals } from './vitals.js'
import { world } from './world.js'
import { inventory, heldItem } from './inventory.js'
import { nearbyBlocks, aroundFeet, INTERESTING_BLOCK_NAMES } from './blocks.js'
import { nearbyEntities } from './entities.js'
import { setHandles, HANDLE_TTL_MS } from './targeting.js'
import { getFollowTargetLabel } from '../behaviors/follow.js'

const MAX_BLOCKS = 8
const MAX_ENTITIES = 6

// Compact inline rendering of inflight args (avoid pulling describeArgs from
// inflight.js to keep snapshot.js dependency-free of llm/).
function describeInflightArgs(args) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  if (typeof args.block === 'string') parts.push(args.block)
  else if (typeof args.target === 'string') parts.push(args.target)
  else if (typeof args.item === 'string') parts.push(args.item)
  else if (typeof args.entity === 'string') parts.push(args.entity)
  if (typeof args.x === 'number' && typeof args.y === 'number' && typeof args.z === 'number') {
    parts.push(`@${args.x},${args.y},${args.z}`)
  }
  return parts.join(' ').slice(0, 64)
}

/**
 * Compose a compact snapshot of the bot's current world state.
 * Side effect: replaces the targeting handle table with the #N entries from this snapshot.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ goals?:{owner_goals?:string[], self_goals?:string[]}, lastActionResult?:string, inFlight?:{name:string,args:any,startedAt:number}|null }} [opts]
 * @returns {string}
 */
export function composeSnapshot(bot, opts = {}) {
  const { goals, lastActionResult, inFlight } = opts
  const v = vitals(bot)
  const w = world(bot)
  const held = heldItem(bot)
  const inv = inventory(bot)
  const blocks = nearbyBlocks(bot, { radius: 16, count: MAX_BLOCKS, interesting: INTERESTING_BLOCK_NAMES })
  const ents = nearbyEntities(bot, { radius: 24, count: MAX_ENTITIES })

  const lines = []
  // Position / biome / time
  lines.push(`pos: ${w.pos.x},${w.pos.y},${w.pos.z}`)
  lines.push(`biome: ${w.biome}  surroundings: ${w.surroundings}  time: ${w.time.isDay ? 'day' : 'night'} (${w.time.timeOfDay})`)

  // Vitals
  lines.push(`hp: ${v.hp}/20  food: ${v.food}/20  xp: lvl ${v.xp.level}`)
  if (v.sleeping) lines.push('status: sleeping')

  // Holding
  if (held) {
    const dur = held.durability ? ` (${held.durability.current}/${held.durability.max})` : ''
    lines.push(`holding: ${held.name}${dur}`)
  } else {
    lines.push('holding: nothing')
  }

  // In-flight action — surfaced early so the LLM sees it before reasoning
  // about new actions. Format: `in_flight: <name> <argblurb> (<elapsed>s)`.
  if (inFlight && typeof inFlight.name === 'string') {
    const elapsed = Math.max(0, (Date.now() - (inFlight.startedAt ?? Date.now())) / 1000).toFixed(1)
    const blurb = describeInflightArgs(inFlight.args)
    lines.push(`in_flight: ${inFlight.name}${blurb ? ' ' + blurb : ''} (${elapsed}s)`)
  }

  // Inventory
  const invEntries = Object.entries(inv)
  const invStr = invEntries.length
    ? invEntries.map(([k, n]) => `${k}×${n}`).join(' ')
    : 'empty'
  lines.push(`inventory: ${invStr}`)

  // Around feet — grouped non-air blocks in 5x4x5 cube. Implicit coords (bot
  // is standing in them); no #N handles minted (would flood the table).
  // (D-1sk-03)
  const feet = aroundFeet(bot)
  if (feet.total === 0) {
    lines.push('terrain at feet: (clear)')
  } else {
    // count-first, comma-separated — distinct from inventory's `name×N` format
    // so the LLM can't confuse environmental blocks with carried items.
    const parts = feet.groups.map(g => `${g.count} ${g.name}`)
    const tail = feet.more > 0 ? ` (+${feet.more} more types)` : ''
    lines.push(`terrain at feet: ${parts.join(', ')}${tail}`)
  }

  // Build #N handles in a single monotonic numbering across blocks then entities.
  const handles = []
  const expiresAt = Date.now() + HANDLE_TTL_MS
  let n = 1

  // Nearby blocks
  lines.push('nearby blocks:')
  if (blocks.positions.length === 0) {
    lines.push('  (none)')
  } else {
    for (const p of blocks.positions) {
      const tag = `#${n++}`
      lines.push(`  ${tag} ${p.name} @${p.x},${p.y},${p.z}`)
      handles.push([tag, { kind: 'block', pos: { x: p.x, y: p.y, z: p.z }, expiresAt }])
    }
    if (blocks.more > 0) lines.push(`  +${blocks.more} more`)
  }

  // Nearby entities
  lines.push('nearby entities:')
  if (ents.entries.length === 0) {
    lines.push('  (none)')
  } else {
    for (const { entity: e } of ents.entries) {
      const tag = `#${n++}`
      const label = e.username ?? e.name ?? `entity-${e.id}`
      const x = Math.round(e.position.x)
      const y = Math.round(e.position.y)
      const z = Math.round(e.position.z)
      lines.push(`  ${tag} ${label} @${x},${y},${z}`)
      handles.push([tag, { kind: 'entity', entityId: e.id, expiresAt }])
    }
    if (ents.more > 0) lines.push(`  +${ents.more} more`)
  }

  // Goals
  const owner = goals?.owner_goals ?? []
  const self = goals?.self_goals ?? []
  lines.push(`owner_goals: ${owner.length ? owner.join(' | ') : '(none)'}`)
  lines.push(`self_goals: ${self.length ? self.join(' | ') : '(none)'}`)

  // Follow status — bot's awareness of its own auto-follow behavior
  const followLabel = getFollowTargetLabel()
  lines.push(`follow_target: ${followLabel ?? '(none)'}`)

  // Last action result
  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)

  // Side effect: install handle table.
  setHandles(handles)

  return lines.join('\n')
}

// v1 deltas are heuristic and observational. "killed X" infers from
// disappearance from a 24-block radius — a mob that walked away will also
// register. This is acceptable: the recent_events line is a hint, not an
// authoritative event log. A future refinement would subscribe to
// bot.on('entityDead') to confirm kills, but that wiring is out of scope
// for this quick task.
/**
 * Create a stateful snapshot composer that tracks per-instance previous
 * inventory / hp / mob-id state and injects a `recent_events:` line into
 * each composed snapshot describing diffs since the prior call.
 *
 * The bare {@link composeSnapshot} export remains stateless for any callers
 * that don't want delta tracking.
 *
 * @param {{ bot: import('mineflayer').Bot }} deps
 */
export function createSnapshotComposer({ bot }) {
  let prevInventory = null
  let prevHp = null
  let prevEntityIds = null
  let prevEntityMeta = new Map()

  function sampleMobs() {
    const me = bot.entity
    if (!me) return { ids: new Set(), meta: new Map() }
    const ids = new Set()
    const meta = new Map()
    for (const e of Object.values(bot.entities ?? {})) {
      if (!e || e === me || !e.position) continue
      if (e.username) continue   // players excluded from kill tracking
      let dist
      try { dist = e.position.distanceTo(me.position) } catch { continue }
      if (dist > 24) continue
      ids.add(e.id)
      meta.set(e.id, { name: e.name ?? `entity-${e.id}` })
    }
    return { ids, meta }
  }

  function computeEvents(currInv, currHp, currMobs) {
    const events = []

    // 1. Inventory deltas — gains then losses, capped to 6 entries total.
    if (prevInventory) {
      const invEvents = []
      // Gains / increases
      for (const [k, v] of Object.entries(currInv)) {
        const prev = prevInventory[k] ?? 0
        if (v > prev) invEvents.push(`+${v - prev} ${k}`)
      }
      // Losses / removed keys
      for (const [k, v] of Object.entries(prevInventory)) {
        const curr = currInv[k] ?? 0
        if (curr < v) invEvents.push(`-${v - curr} ${k}`)
      }
      const cap = 6
      if (invEvents.length > cap) {
        const extra = invEvents.length - cap
        events.push(...invEvents.slice(0, cap), `(+${extra} more)`)
      } else {
        events.push(...invEvents)
      }
    }

    // 2. Kill heuristic — group disappearances by name.
    if (prevEntityIds) {
      const killCounts = new Map()
      for (const id of prevEntityIds) {
        if (currMobs.ids.has(id)) continue
        const live = bot.entities?.[id]
        if (live && live.isValid !== false) continue
        const meta = prevEntityMeta.get(id)
        const name = meta?.name ?? `entity-${id}`
        killCounts.set(name, (killCounts.get(name) ?? 0) + 1)
      }
      for (const [name, count] of killCounts) {
        events.push(count > 1 ? `killed ${name} ×${count}` : `killed ${name}`)
      }
    }

    // 3. HP loss only — regen is noisy.
    if (prevHp != null && currHp < prevHp) {
      events.push(`hp -${prevHp - currHp}`)
    }

    return events
  }

  return {
    next(opts = {}) {
      const base = composeSnapshot(bot, opts)
      const currInv = inventory(bot)
      const currHp = Math.round(bot.health ?? 0)
      const currMobs = sampleMobs()
      const events = computeEvents(currInv, currHp, currMobs)

      // Update state AFTER computing — first call has no deltas.
      prevInventory = currInv
      prevHp = currHp
      prevEntityIds = currMobs.ids
      prevEntityMeta = currMobs.meta

      if (events.length === 0) return base
      const line = `recent_events: ${events.join('; ')}`
      const lines = base.split('\n')
      const idx = lines.findIndex(l => l.startsWith('last_action_result:'))
      if (idx >= 0) lines.splice(idx + 1, 0, line)
      else lines.push(line)
      return lines.join('\n')
    },
    reset() {
      prevInventory = null
      prevHp = null
      prevEntityIds = null
      prevEntityMeta = new Map()
    },
  }
}
