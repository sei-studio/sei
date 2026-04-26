// src/observers/snapshot.js — composes line-oriented world snapshot (D-26)
// and registers #N targeting handles via setHandles() (D-25).
import { vitals } from './vitals.js'
import { world } from './world.js'
import { inventory, heldItem } from './inventory.js'
import { nearbyBlocks, INTERESTING_BLOCK_NAMES } from './blocks.js'
import { nearbyEntities } from './entities.js'
import { setHandles, HANDLE_TTL_MS } from './targeting.js'

const MAX_BLOCKS = 8
const MAX_ENTITIES = 6

/**
 * Compose a compact snapshot of the bot's current world state.
 * Side effect: replaces the targeting handle table with the #N entries from this snapshot.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ goals?:{owner_goals?:string[], self_goals?:string[]}, lastActionResult?:string }} [opts]
 * @returns {string}
 */
export function composeSnapshot(bot, opts = {}) {
  const { goals, lastActionResult } = opts
  const v = vitals(bot)
  const w = world(bot)
  const held = heldItem(bot)
  const inv = inventory(bot)
  const blocks = nearbyBlocks(bot, { radius: 16, count: MAX_BLOCKS, interesting: INTERESTING_BLOCK_NAMES })
  const ents = nearbyEntities(bot, { radius: 24, count: MAX_ENTITIES })

  const lines = []
  // Position / biome / time
  lines.push(`pos: ${w.pos.x},${w.pos.y},${w.pos.z}`)
  lines.push(`biome: ${w.biome}  time: ${w.time.isDay ? 'day' : 'night'} (${w.time.timeOfDay})`)

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

  // Inventory
  const invEntries = Object.entries(inv)
  const invStr = invEntries.length
    ? invEntries.map(([k, n]) => `${k}×${n}`).join(' ')
    : 'empty'
  lines.push(`inventory: ${invStr}`)

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

  // Last action result
  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)

  // Side effect: install handle table.
  setHandles(handles)

  return lines.join('\n')
}
