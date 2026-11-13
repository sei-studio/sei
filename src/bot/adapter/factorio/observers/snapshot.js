// src/bot/adapter/factorio/observers/snapshot.js: turns the mod's observation
// (native/factorio-mod/sei-companion/scripts/observe.lua, PROTOCOL.md
// "Observation") into the short text the brain reads each turn. The mod
// already caps every list; this side words it. Budget: a few hundred tokens,
// because it rides every turn (free-tier cost is per-turn tokens).

import { getInFlightLineForSnapshot } from '../../../brain/inflight.js'

/** Lua's JSON writes an empty table as {}: read every list through this. */
export const arr = (v) => (Array.isArray(v) ? v : [])
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const at = (p) => (Array.isArray(p) ? `${Math.round(num(p[0]))},${Math.round(num(p[1]))}` : '?')

function pairs(list, max) {
  const rows = arr(list).slice(0, max).map((r) => (Array.isArray(r) ? `${num(r[1])} ${r[0]}` : String(r)))
  return rows
}

function bigNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function timeWord(daytime) {
  const d = num(daytime, -1)
  if (d < 0) return null
  // Factorio's daytime: 0 is noon, 0.5 midnight; dusk ~0.25-0.45, dawn ~0.55-0.75.
  if (d < 0.2 || d > 0.8) return 'day'
  if (d < 0.45) return 'evening'
  if (d < 0.55) return 'night'
  return 'dawn'
}

/**
 * Pure: one observation as snapshot text.
 * @param {object|null} obs
 * @param {{ lastActionResult?: string|null, inFlight?: any, worldTag?: string|null }} [opts]
 */
export function composeSnapshot(obs, opts = {}) {
  const { lastActionResult = null, inFlight = null, worldTag = null } = opts
  if (!obs) return '(snapshot unavailable: waiting for the first observation from the game)'
  const lines = []
  if (worldTag) lines.push(`world: ${worldTag}`)
  if (obs.gone) return [...lines, 'you are not in the world right now'].join('\n')
  if (obs.dead) {
    lines.push(`you are DEAD; back next to the player in ${num(obs.respawn_s, 10)}s`)
    if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)
    return lines.join('\n')
  }

  const state = []
  if (obs.fleeing) state.push('RETREATING (low health)')
  else if (obs.fighting) state.push('fighting')
  if (obs.paused) state.push('paused by the player')
  const tw = timeWord(obs.daytime)
  lines.push(`you: ${obs.name ?? 'you'} at ${at(obs.at)} on ${obs.surface ?? 'nauvis'}, health ${num(obs.health)}%, stance ${obs.stance ?? 'defensive'}, ${obs.follow ? 'following the player' : 'staying put'}${state.length ? `, ${state.join(', ')}` : ''}${tw ? `; it is ${tw}` : ''}`)

  const inFlightLine = getInFlightLineForSnapshot(inFlight)
  if (inFlightLine) lines.push(inFlightLine)
  if (obs.job?.progress) lines.push(`  progress: ${obs.job.progress}`)
  if (num(obs.crafting) > 0) lines.push(`crafting queue: ${num(obs.crafting)} recipe${num(obs.crafting) === 1 ? '' : 's'} in progress`)

  const o = obs.owner ?? {}
  if (o.missing) {
    lines.push('player: not in the world (or you cannot find them)')
  } else {
    const where = o.dist == null
      ? `on ${o.surface ?? 'another surface'} (not where you are)`
      : o.dist <= 2 ? 'right next to you' : `${o.dist} tiles ${o.dir}`
    const bits = [where]
    if (o.vehicle) bits.push(`in a ${o.vehicle}`)
    if (o.health != null && num(o.health) < 100) bits.push(`health ${num(o.health)}%`)
    if (o.holding) bits.push(`holding ${o.holding}`)
    if (o.pointing) bits.push(`pointing at #${o.pointing.h ?? '?'} ${o.pointing.name} (${at(o.pointing.at)})`)
    lines.push(`player ${o.name ?? ''}: ${bits.join(', ')}`.replace('player :', 'player:'))
  }

  const inv = obs.inv ?? {}
  const items = pairs(inv.items, 14)
  const more = num(inv.kinds) > items.length ? ` +${num(inv.kinds) - items.length} more kinds` : ''
  lines.push(`inventory (${num(inv.free)} free slots): ${items.length ? items.join(', ') + more : 'empty'}`)
  const guns = arr(inv.guns)
  lines.push(`weapon: ${guns.length ? guns.join(', ') : 'none (you cannot fight)'}`)

  const res = arr(obs.res)
  const nature = []
  if (num(obs.trees) > 0) nature.push(`${num(obs.trees)} trees`)
  if (num(obs.rocks) > 0) nature.push(`${num(obs.rocks)} rocks`)
  if (res.length || nature.length) {
    const parts = res.map((r) => `${r.name} ${bigNumber(num(r.amount))} (nearest ${r.dist <= 1 ? 'under you' : `${num(r.dist)} tiles ${r.dir}`})`)
    lines.push(`resources near: ${[...parts, ...(nature.length ? [`${nature.join(', ')} within 16 tiles`] : [])].join('; ')}`)
  } else {
    lines.push('resources near: none within 32 tiles')
  }

  const en = obs.enemies
  if (en && typeof en === 'object' && !Array.isArray(en)) {
    const units = pairs(en.units, 4)
    const nests = num(en.nests)
    const what = [...units, ...(nests ? [`${nests} nest${nests === 1 ? '' : 's'} or worms`] : [])].join(', ')
    lines.push(`ENEMIES: ${what}; nearest ${en.nearest} ${num(en.dist)} tiles ${en.dir}${en.near_owner ? ' (close to the player!)' : ''}`)
  }

  const base = obs.base ?? {}
  const blds = pairs(base.buildings, 10)
  if (blds.length) {
    const extra = num(base.kinds) > blds.length ? ` +${num(base.kinds) - blds.length} more kinds` : ''
    lines.push(`buildings within 24 tiles: ${blds.join(', ')}${extra}`)
  }
  if (num(base.ghosts) > 0) lines.push(`ghosts to build nearby: ${num(base.ghosts)} (buildGhosts)`)
  const problems = arr(base.problems)
  if (problems.length) lines.push(`problems: ${problems.map((p) => `#${p.h ?? '?'} ${p.name} (${at(p.at)}) ${p.status}`).join('; ')}`)
  const chests = arr(base.chests)
  if (chests.length) lines.push(`chests: ${chests.map((c) => `#${c.h ?? '?'} ${c.name} (${at(c.at)}): ${c.has}`).join('; ')}`)

  const rs = obs.research ?? {}
  if (rs.none) lines.push('research: none selected')
  else if (rs.name) lines.push(`research: ${rs.name} ${num(rs.pct)}%${num(rs.queue) > 1 ? ` (${num(rs.queue) - 1} more queued)` : ''}`)

  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)
  return lines.join('\n')
}

/**
 * Stateful composer: adds the inventory-change and health-loss callouts the
 * other composers have, so a hand-off from the player or a hit lands loudly.
 * @param {{ getObs: () => object|null, getWorldTag?: () => string|null }} deps
 */
export function createSnapshotComposer({ getObs, getWorldTag = () => null }) {
  let prevCounts = null
  let prevHealth = null

  function countMap(obs) {
    const m = new Map()
    for (const r of arr(obs?.inv?.items)) if (Array.isArray(r)) m.set(String(r[0]), num(r[1]))
    return m
  }

  return {
    next(opts = {}) {
      const obs = getObs()
      const base = composeSnapshot(obs, { worldTag: getWorldTag(), ...opts })
      if (!obs || obs.dead || obs.gone) return base
      const cur = countMap(obs)
      const changes = []
      if (prevCounts) {
        for (const [name, count] of cur) {
          const before = prevCounts.get(name) ?? 0
          if (count > before) changes.push(`+${count - before} ${name}`)
        }
        for (const [name, before] of prevCounts) {
          // The inventory line only lists the top kinds; a kind that dropped
          // off the list is not "gone" unless the list was short.
          if (cur.has(name)) {
            const count = cur.get(name)
            if (count < before) changes.push(`-${before - count} ${name}`)
          } else if (cur.size < 14) {
            changes.push(`-${before} ${name}`)
          }
        }
      }
      const health = num(obs.health)
      const hpLoss = prevHealth != null && health < prevHealth ? prevHealth - health : 0
      prevCounts = cur
      prevHealth = health
      if (!changes.length && !hpLoss) return base
      const lines = base.split('\n')
      if (changes.length) {
        const line = `inventory changed since last look: ${changes.slice(0, 8).join(', ')}`
        const i = lines.findIndex((l) => l.startsWith('inventory ('))
        if (i >= 0) lines.splice(i + 1, 0, line)
        else lines.push(line)
      }
      if (hpLoss) lines.push(`recent_events: health -${hpLoss}%`)
      return lines.join('\n')
    },
    reset() {
      prevCounts = null
      prevHealth = null
    },
  }
}
