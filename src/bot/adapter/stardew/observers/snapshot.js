// src/bot/adapter/stardew/observers/snapshot.js — turns the mod's observation
// JSON (native/stardew-mod/PROTOCOL.md "Observation") into the line-oriented
// text the brain seeds each turn with. Same shape as the Minecraft composer:
// world tag, position, vitals, inventory, what is around, entities with #N
// handles, follow state, owner line, in_flight, last_action_result. Budget
// about 1.2k tokens; every list is already capped by the mod.

import { getInFlightLineForSnapshot } from '../../../brain/inflight.js'

const MAX_INV = 20

function n(v, d = 0) { return Number.isFinite(Number(v)) ? Number(v) : d }

function fmtItems(items) {
  const rows = Array.isArray(items) ? items : []
  const parts = rows.slice(0, MAX_INV).map((it) => {
    const tag = it.kind === 'tool' || it.kind === 'weapon' || it.kind === 'rod' || it.kind === 'scythe' ? '' : ''
    const count = n(it.count, 1) > 1 ? ` x${n(it.count)}` : ''
    const up = n(it.upgrade) > 0 ? `+${n(it.upgrade)}` : ''
    return `${it.name}${up}${count}${tag}`
  })
  if (rows.length > MAX_INV) parts.push(`+${rows.length - MAX_INV} more`)
  return parts.length ? parts.join(', ') : '(empty)'
}

function tileList(rows, render, max = 8) {
  const list = Array.isArray(rows) ? rows.slice(0, max) : []
  return list.map(render).join('; ')
}

/**
 * Pure: render one observation as snapshot text.
 * @param {object} obs   The mod's observation (may be null before the first push).
 * @param {{ lastActionResult?: string|null, inFlight?: any, pinUsername?: string|null, companions?: string[], worldTag?: string|null }} opts
 */
export function composeSnapshot(obs, opts = {}) {
  const { lastActionResult = null, inFlight = null, pinUsername = null, companions = [], worldTag = null } = opts
  if (!obs) return '(snapshot unavailable: waiting for the first observation from the game)'
  const lines = []
  if (worldTag) lines.push(`world: ${worldTag}`)
  lines.push(`location: ${obs.location} (${obs.locationKind ?? 'map'})  pos: ${n(obs.x)},${n(obs.y)}  facing: ${obs.facing ?? 'down'}`)
  lines.push(`${obs.season ?? '?'} ${n(obs.day)}, year ${n(obs.year, 1)}${obs.dayOfWeek ? ` (${obs.dayOfWeek})` : ''}  time: ${obs.timeText ?? obs.time}  weather: ${obs.weather ?? 'sunny'}${obs.isDark ? '  (dark)' : ''}`)
  const ex = obs.exhausted ? ' EXHAUSTED' : ''
  lines.push(`energy: ${n(obs.stamina)}/${n(obs.maxStamina)}${ex}  health: ${n(obs.health)}/${n(obs.maxHealth)}  gold: ${n(obs.gold)}g`)
  if (obs.sleeping) lines.push('status: resting in bed (the day ends when the player sleeps)')
  if (obs.paused) lines.push('status: paused by the player')
  lines.push(`holding: ${obs.held ?? 'nothing'}${obs.wateringCan ? `  watering can: ${n(obs.wateringCan.left)}/${n(obs.wateringCan.max)}` : ''}`)

  const inFlightLine = getInFlightLineForSnapshot(inFlight)
  if (inFlightLine) lines.push(inFlightLine)

  const inv = Array.isArray(obs.inventory) ? obs.inventory : []
  lines.push(`inventory (${inv.length}/36 slots): ${fmtItems(inv)}`)

  const t = obs.tiles ?? {}
  const c = t.counts ?? {}
  lines.push(`around you (${n(t.radius, 8)} tiles): crops ${n(c.crops)} (${n(c.dryCrops)} dry, ${n(c.readyCrops)} ready), empty soil ${n(c.emptySoil)}, twigs ${n(c.twigs)}, weeds ${n(c.weeds)}, stones ${n(c.stones)}${t.water ? `, water @${n(t.water.x)},${n(t.water.y)}` : ', no water nearby'}`)
  if (Array.isArray(t.crops) && t.crops.length) {
    lines.push(`  crops: ${tileList(t.crops, (r) => `${r.name} @${r.x},${r.y}${r.ready ? ' READY' : r.dead ? ' dead' : r.watered ? '' : ' dry'}${r.stage && !r.ready ? ` ${r.stage}` : ''}`)}`)
  }
  if (Array.isArray(t.soil) && t.soil.length) lines.push(`  empty soil: ${tileList(t.soil, (r) => `@${r.x},${r.y}`, 6)}`)
  // Resource clumps (large stumps, hollow logs, boulders) need an upgraded
  // tool the companion starts without; say so where they are listed, or the
  // model swings at them (measured 260910: chop on a hollow log, twice).
  if (Array.isArray(t.trees) && t.trees.length) lines.push(`  trees: ${tileList(t.trees, (r) => `${r.handle} ${r.kind}${r.grown === false ? ' (young)' : ''}${n(r.fruit) > 0 ? ` (${r.fruit} fruit)` : ''}${r.big ? ' (needs an upgraded axe)' : ''} @${r.x},${r.y}`)}`)
  if (Array.isArray(t.rocks) && t.rocks.length) lines.push(`  rocks: ${tileList(t.rocks, (r) => `${r.handle} ${r.kind}${r.big ? ' (needs an upgraded pickaxe)' : ''} @${r.x},${r.y}`)}`)
  if (Array.isArray(t.forage) && t.forage.length) lines.push(`  forage: ${tileList(t.forage, (r) => `${r.handle} ${r.name} @${r.x},${r.y}`)}`)
  if (Array.isArray(t.chests) && t.chests.length) lines.push(`  chests: ${tileList(t.chests, (r) => `${r.handle} chest (${n(r.items)} items) @${r.x},${r.y}`)}`)
  if (Array.isArray(t.machines) && t.machines.length) lines.push(`  machines: ${tileList(t.machines, (r) => `${r.handle} ${r.name}${r.ready ? ' READY' : n(r.minutes) > 0 ? ` (${r.minutes} min)` : ' (empty)'} @${r.x},${r.y}`)}`)
  if (Array.isArray(t.ladders) && t.ladders.length) lines.push(`  ladders: ${tileList(t.ladders, (r) => `${r.handle} ${r.kind} @${r.x},${r.y}`)}`)

  // The whole farm and the host (mod `farm` / `host`, 260910): the 8-tile
  // scan cannot say what the farm's next job is from inside the house.
  const fm = obs.farm
  if (fm && typeof fm === 'object') {
    lines.push(`whole farm: crops ${n(fm.crops)} (${n(fm.dryCrops)} dry, ${n(fm.readyCrops)} ready${n(fm.deadCrops) ? `, ${n(fm.deadCrops)} dead` : ''}), tilled empty soil ${n(fm.soil)}, debris ${n(fm.debris)} (${n(fm.twigs)} twigs, ${n(fm.weeds)} weeds, ${n(fm.stones)} stones), big stumps/logs/boulders ${n(fm.bigClumps)}, grown trees ${n(fm.grownTrees)}, shipping bin: ${n(fm.shippingBinItems)} items`)
  }
  const host = obs.host
  if (host && typeof host === 'object') {
    lines.push(`player ${host.name ?? 'host'}: ${n(host.money)}g, ${n(host.seeds)} seeds in their bag, energy ${n(host.stamina)}/${n(host.maxStamina)}, farming level ${n(host.farmingLevel)}${n(host.mailWaiting) ? `, ${n(host.mailWaiting)} letter(s) waiting in the mailbox` : ''}`)
  }

  const compSet = new Set((companions ?? []).map((s) => String(s).toLowerCase()))
  const ents = Array.isArray(obs.entities) ? obs.entities : []
  lines.push('nearby entities:')
  if (!ents.length) lines.push('  (none)')
  for (const e of ents.slice(0, 12)) {
    let label = e.name
    if (e.kind === 'monster') label = `${e.name} (monster${e.health != null ? ` ${e.health}/${e.maxHealth} hp` : ''})`
    else if (e.kind === 'player') label = `${e.name} (player${e.isHost ? ', host' : ''})`
    else if (e.kind === 'companion' || compSet.has(String(e.name).toLowerCase())) label = `${e.name} (companion)`
    else if (e.kind !== 'villager') label = `${e.name} (${e.kind})`
    lines.push(`  ${e.handle} ${label} @${e.x},${e.y} (${n(e.dist)} tiles)`)
  }

  const warps = Array.isArray(obs.warps) ? obs.warps : []
  if (warps.length) lines.push(`ways out: ${warps.map((w) => `${w.handle} to ${w.to} @${w.x},${w.y}`).join('; ')}`)

  lines.push(`follow_target: ${obs.follow ?? '(none)'}`)
  const p = obs.player
  // The host farmer IS the owner in Stardew (the mod's `player` is
  // Game1.player), so their in-game name wins over the account's pinned
  // username: measured 260910, the pin said "Sei" (the profile's preferred
  // name) while the farmer was "Ouen", two names for one person.
  const ownerName = p?.name || pinUsername || 'the player'
  if (p) {
    if (p.sameLocation) lines.push(`owner ${ownerName}: @${n(p.x)},${n(p.y)} (${n(p.dist)} tiles away)`)
    else lines.push(`owner ${ownerName}: in ${p.location} (a different map; call follow or come to reach them)`)
  } else {
    lines.push(`owner ${ownerName}: out of view (call follow to reach them)`)
  }
  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)
  return lines.join('\n')
}

/**
 * Stateful composer: adds the inventory-change and health-loss callouts the
 * Minecraft composer has, so a handoff from the player or a hit lands loudly.
 * @param {{ getObs: () => object|null }} deps
 */
export function createSnapshotComposer({ getObs }) {
  let prevCounts = null
  let prevHealth = null

  function countMap(obs) {
    const m = new Map()
    for (const it of Array.isArray(obs?.inventory) ? obs.inventory : []) {
      m.set(it.name, (m.get(it.name) ?? 0) + n(it.count, 1))
    }
    return m
  }

  return {
    next(opts = {}) {
      const obs = getObs()
      const base = composeSnapshot(obs, opts)
      if (!obs) return base
      const cur = countMap(obs)
      const changes = []
      if (prevCounts) {
        for (const [name, count] of cur) {
          const before = prevCounts.get(name) ?? 0
          if (count > before) changes.push(`+${count - before} ${name}`)
        }
        for (const [name, before] of prevCounts) {
          const count = cur.get(name) ?? 0
          if (count < before) changes.push(`-${before - count} ${name}`)
        }
      }
      const health = n(obs.health)
      const hpLoss = prevHealth != null && health < prevHealth ? prevHealth - health : 0
      prevCounts = cur
      prevHealth = health
      if (!changes.length && !hpLoss) return base
      const lines = base.split('\n')
      if (changes.length) {
        const line = `*** INVENTORY JUST CHANGED ***: ${changes.slice(0, 8).join(', ')}  <- items entered or left your inventory since last tick (a job finished, the player handed you something, or you ate/used it). React to it if it matters.`
        const i = lines.findIndex((l) => l.startsWith('inventory ('))
        if (i >= 0) lines.splice(i + 1, 0, line)
        else lines.push(line)
      }
      if (hpLoss) {
        const line = `recent_events: health -${hpLoss}`
        const i = lines.findIndex((l) => l.startsWith('last_action_result:'))
        if (i >= 0) lines.splice(i + 1, 0, line)
        else lines.push(line)
      }
      return lines.join('\n')
    },
    reset() {
      prevCounts = null
      prevHealth = null
    },
  }
}
