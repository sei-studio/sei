// src/bot/adapter/terraria/observers/snapshot.js — turns the mod's
// observation (native/terraria-mod/PROTOCOL.md "Observation") into the
// line-oriented text the brain reads each turn. Every list is already capped
// by the mod; this keeps the text to a few short lines because it is paid for
// on every turn.

import { getInFlightLineForSnapshot } from '../../../brain/inflight.js'

function n(v, d = 0) { return Number.isFinite(Number(v)) ? Number(v) : d }
const arr = (v) => (Array.isArray(v) ? v : [])

/** "Wood x12" -> ["Wood", 12]; "Work Bench" -> ["Work Bench", 1]. */
export function parseBagEntry(s) {
  const m = /^(.*?)(?: x(\d+))?$/.exec(String(s ?? '').trim())
  if (!m || !m[1]) return null
  return [m[1], m[2] ? Number(m[2]) : 1]
}

/**
 * Who the player is for this companion: the one she follows, else the
 * account's pinned name, else the first player in the world.
 */
export function ownerOf(obs, pinUsername = null) {
  const players = arr(obs?.players)
  if (!players.length) return null
  const lc = (s) => String(s ?? '').toLowerCase()
  const following = obs?.self?.following
  return players.find((p) => following && lc(p.name) === lc(following))
    ?? players.find((p) => pinUsername && lc(p.name) === lc(pinUsername))
    ?? players[0]
}

/**
 * Pure: render one observation as snapshot text.
 * @param {object|null} obs
 * @param {{ lastActionResult?: string|null, inFlight?: any, pinUsername?: string|null, companions?: string[], worldTag?: string|null }} [opts]
 */
export function composeSnapshot(obs, opts = {}) {
  const { lastActionResult = null, inFlight = null, pinUsername = null, companions = [], worldTag = null } = opts
  if (!obs) return '(snapshot unavailable: waiting for the first observation from the game)'
  const self = obs.self ?? {}
  if (self.absent) return '(your body is not in the world right now; it comes back by itself)'
  const lines = []
  if (worldTag) lines.push(`world: ${worldTag}`)

  const place = obs.place ?? {}
  const biomes = arr(place.biomes)
  const where = [place.layer, ...biomes].filter(Boolean).join(', ')
  lines.push(`you: @${n(self.x)},${n(self.y)}${where ? ` (${where})` : ''}  health ${n(self.hp)}/${n(self.maxHp)}  defense ${n(self.defense)}  stance ${self.stance ?? 'defensive'}`)
  const gear = `weapon: ${self.weapon ?? 'none (fists)'}  armor: ${arr(self.armor).join(', ') || 'none'}`
  const status = []
  if (n(self.knockedOut) > 0) status.push(`KNOCKED OUT, up again in ${n(self.knockedOut)}s`)
  if (n(self.potionCooldown) > 0) status.push(`potion sickness ${n(self.potionCooldown)}s`)
  if (self.paused) status.push('paused by the player')
  lines.push(status.length ? `${gear}  (${status.join(', ')})` : gear)

  const inFlightLine = getInFlightLineForSnapshot(inFlight)
  if (inFlightLine) lines.push(inFlightLine)

  const bag = arr(obs.bag)
  lines.push(`bag: ${bag.length ? bag.join(', ') : '(empty)'}`)

  const events = arr(obs.events)
  lines.push(`time: ${obs.time ?? '?'} (${obs.day === false ? 'night' : 'day'})${events.length ? `  events: ${events.join(', ')}` : ''}`)

  const world = obs.world ?? {}
  const downs = arr(world.bossesDown)
  lines.push(`progress: ${world.hardmode ? 'hardmode' : 'pre-hardmode'}, bosses defeated: ${downs.length ? downs.join(', ') : 'none yet'}`)

  const compSet = new Set((companions ?? []).map((s) => String(s).toLowerCase()))
  const owner = ownerOf(obs, pinUsername)
  const others = arr(obs.players).filter((p) => p !== owner && !compSet.has(String(p.name).toLowerCase()))
  if (owner) {
    const hold = owner.holding ? `, holding ${owner.holding}` : ''
    lines.push(`owner ${owner.name}: ${owner.dead ? 'DEAD (respawning)' : `@${n(owner.x)},${n(owner.y)} (${n(owner.dist)} tiles away), health ${n(owner.hp)}/${n(owner.maxHp)}${hold}`}`)
  } else {
    lines.push(`owner ${pinUsername || 'the player'}: not in the world`)
  }
  if (others.length) lines.push(`other players: ${others.slice(0, 4).map((p) => `${p.name} @${n(p.x)},${n(p.y)} (${n(p.dist)} tiles)`).join('; ')}`)
  lines.push(`follow_target: ${self.following ?? '(none)'}`)

  const hostiles = arr(obs.hostiles)
  lines.push(`hostiles: ${hostiles.length ? hostiles.map((h) => `#${n(h.id)} ${h.name}${h.boss ? ' (BOSS)' : ''} ${n(h.hp)}/${n(h.maxHp)} @${n(h.x)},${n(h.y)} (${n(h.dist)} tiles)`).join('; ') : 'none close'}`)

  const items = arr(obs.items)
  if (items.length) lines.push(`on the ground: ${items.map((i) => `${i.name}${n(i.stack, 1) > 1 ? ` x${n(i.stack)}` : ''} (${n(i.dist)} tiles)`).join(', ')}`)
  const near = []
  const trees = arr(obs.trees)
  if (trees.length) near.push(`trees ${trees.map((t) => `@${n(t.x)},${n(t.y)}`).join(' ')}`)
  const ores = arr(obs.ores)
  if (ores.length) near.push(`ore ${ores.map((o) => `${o.name} @${n(o.x)},${n(o.y)}`).join(', ')}`)
  const stations = arr(obs.stations)
  near.push(`crafting here: ${stations.length ? stations.join(', ') : 'nothing (hand recipes only)'}`)
  lines.push(`near you: ${near.join('; ')}`)

  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)
  return lines.join('\n')
}

/**
 * Stateful composer: adds the bag-change and health-loss callouts the other
 * surfaces have, so a hand-over from the player or a hit lands loudly.
 * @param {{ getObs: () => object|null }} deps
 */
export function createSnapshotComposer({ getObs }) {
  let prevCounts = null
  let prevHealth = null

  const countMap = (obs) => {
    const m = new Map()
    for (const s of arr(obs?.bag)) {
      const e = parseBagEntry(s)
      if (e) m.set(e[0], (m.get(e[0]) ?? 0) + e[1])
    }
    return m
  }

  return {
    next(opts = {}) {
      const obs = getObs()
      const base = composeSnapshot(obs, opts)
      if (!obs || !obs.self || obs.self.absent) return base
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
      const health = n(obs.self.hp)
      const hpLoss = prevHealth != null && health < prevHealth ? prevHealth - health : 0
      prevCounts = cur
      prevHealth = health
      if (!changes.length && !hpLoss) return base
      const lines = base.split('\n')
      if (changes.length) {
        const line = `*** BAG JUST CHANGED ***: ${changes.slice(0, 8).join(', ')}  <- since last turn (a job finished, the player handed you something, or you used it). React if it matters.`
        const i = lines.findIndex((l) => l.startsWith('bag: '))
        lines.splice(i >= 0 ? i + 1 : lines.length, 0, line)
      }
      if (hpLoss) {
        const i = lines.findIndex((l) => l.startsWith('you: '))
        lines.splice(i >= 0 ? i + 1 : lines.length, 0, `*** HEALTH DROPPED ***: -${hpLoss} since last turn`)
      }
      return lines.join('\n')
    },
  }
}
