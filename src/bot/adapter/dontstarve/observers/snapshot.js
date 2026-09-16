// src/bot/adapter/dontstarve/observers/snapshot.js — the per-turn text the
// brain reads (game-adapters M2, 260908). Renders the observation state
// (protocol.js) into ~1.0k tokens: world clock, the vitals triple, inventory
// + equips, nearby entities BUCKETED by what can be done to them with `#N`
// handles, threats, light, follow state and the last action result. The
// brain treats the string as opaque; nothing here reaches the user.
//
// Buckets are capped so a berry field or a spider den cannot eat the whole
// budget; the nearest entries of each bucket win.

import { PERCEPTION_RADIUS } from '../protocol.js'
import { survivorName } from '../survivors.js'

const BUCKET_CAP = 6
const INV_CAP = 20

const BUCKETS = [
  { key: 'players', label: 'players', test: (e) => e.flags.includes('player') && !e.flags.includes('companion') },
  { key: 'companions', label: 'companions', test: (e) => e.flags.includes('companion') },
  { key: 'threats', label: 'threats', test: (e) => (e.flags.includes('hostile') || e.flags.includes('monster')) && e.flags.includes('combat') },
  { key: 'fires', label: 'fires', test: (e) => e.flags.includes('fire') || e.flags.includes('burning') },
  { key: 'chop', label: 'choppable', test: (e) => e.flags.includes('chop') },
  { key: 'mine', label: 'mineable', test: (e) => e.flags.includes('mine') },
  { key: 'pick', label: 'pickable', test: (e) => e.flags.includes('pick') || e.flags.includes('harvest') },
  { key: 'pickup', label: 'on the ground', test: (e) => e.flags.includes('pickup') },
  { key: 'food', label: 'food (eatable)', test: (e) => e.flags.includes('eat') && !e.flags.includes('pickup') },
  { key: 'containers', label: 'chests', test: (e) => e.flags.includes('container') || e.flags.includes('chest') },
  { key: 'stations', label: 'stations', test: (e) => e.flags.includes('prototyper') || e.flags.includes('stewer') || e.flags.includes('cooker') || e.flags.includes('sleep') },
  { key: 'creatures', label: 'creatures', test: (e) => e.flags.includes('combat') && !e.flags.includes('player') },
  { key: 'structures', label: 'structures', test: (e) => e.flags.includes('structure') || e.flags.includes('wall') },
]

function fmt1(n) {
  return Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : '?'
}

function pct(cur, max) {
  return max > 0 ? `${Math.round(cur)}/${Math.round(max)}` : `${Math.round(cur)}`
}

function itemLine(it) {
  const q = it.qty > 1 ? ` x${it.qty}` : ''
  const spoil = it.spoil != null && it.spoil < 0.3 ? ' (spoiling)' : ''
  return `${it.prefab}${q}${spoil}`
}

/**
 * @param {object} args
 * @param {ReturnType<import('../protocol.js').createObservationState>} args.state
 * @param {ReturnType<import('../protocol.js').createHandleRegistry>} args.handles
 * @param {object} args.dst  config.adapter.dontstarve
 * @param {() => {fight: boolean, followLabel: string|null}} [args.getBodyState]
 */
export function createSnapshotComposer({ state, handles, dst, getBodyState = () => ({ fight: true, followLabel: null }) }) {
  let prevHp = null
  let prevInv = null

  function entityLine(e, withHp = false) {
    const d = state.distTo(e)
    const parts = [`${e.name ?? e.prefab} ${handles.handleFor(e.guid)} (${fmt1(d)}m`]
    if (e.qty && e.qty > 1) parts.push(`x${e.qty}`)
    if (withHp && e.hp != null) parts.push(`${Math.round(e.hp * 100)}% hp`)
    if (e.flags.includes('burning')) parts.push('burning')
    return `${parts.join(', ')})`
  }

  function invDelta(curr) {
    if (!prevInv) return []
    const before = new Map(prevInv.map((i) => [i.prefab, i.qty]))
    const after = new Map(curr.map((i) => [i.prefab, i.qty]))
    const out = []
    for (const [p, q] of after) {
      const b = before.get(p) ?? 0
      if (q > b) out.push(`+${q - b} ${p}`)
    }
    for (const [p, q] of before) {
      const a = after.get(p) ?? 0
      if (a < q) out.push(`-${q - a} ${p}`)
    }
    return out
  }

  return {
    next(opts = {}) {
      const self = state.self
      const world = state.world
      if (!self || !world) return '(snapshot unavailable: no observation from the world yet)'
      const lines = []
      const name = survivorName(dst?.prefab)
      const weather = world.raining ? ', raining' : world.snowing ? ', snowing' : ''
      lines.push(`world: ${opts.worldTag ?? (dst?.label || 'the Constant')} | day ${world.day} ${world.season}, ${world.phase}${weather} | air ${fmt1(world.temp)}`)
      const warn = []
      if (self.freezing) warn.push('FREEZING')
      if (self.overheating) warn.push('OVERHEATING')
      if (!self.inLight && (world.phase === 'night' || world.phase === 'dusk')) warn.push('IN THE DARK')
      if (self.moist > 35) warn.push(`wet ${Math.round(self.moist)}%`)
      lines.push(`you: ${name} at (${fmt1(self.x)}, ${fmt1(self.z)}) | health ${pct(self.hp, self.hpMax)} hunger ${pct(self.hunger, self.hungerMax)} sanity ${pct(self.sanity, self.sanityMax)} | body temp ${fmt1(self.temp)} | light: ${self.inLight ? 'yes' : 'no'}${warn.length ? ` | ${warn.join(', ')}` : ''}`)
      const inv = self.inv.slice(0, INV_CAP).map(itemLine)
      lines.push(`inventory (${self.inv.length}): ${inv.length ? inv.join(', ') : 'empty'}`)
      const changes = invDelta(self.inv)
      if (changes.length) lines.push(`*** INVENTORY JUST CHANGED ***: ${changes.join(', ')}`)
      const eq = Object.entries(self.equip).map(([slot, it]) => `${slot}=${it.prefab}`)
      lines.push(`equipped: ${eq.length ? eq.join(' ') : 'nothing'}`)
      const body = getBodyState() || {}
      const followEnt = self.follow != null ? state.ents.get(self.follow) : null
      const followLabel = body.followLabel ?? (followEnt ? (followEnt.name ?? followEnt.prefab) : null)
      lines.push(`follow: ${followLabel ?? 'nobody'} | fight back when hit: ${body.fight === false ? 'off' : 'on'}${self.target != null ? ` | fighting: ${state.ents.get(self.target)?.prefab ?? 'something'}` : ''}`)
      if (prevHp != null && self.hp < prevHp - 0.5) lines.push(`recent_events: health -${Math.round(prevHp - self.hp)}`)

      const all = state.nearby()
      const used = new Set()
      lines.push(`nearby (within ${PERCEPTION_RADIUS}m, ${all.length} things${state.truncated ? ', list was cut' : ''}):`)
      const pin = String(opts.pinUsername ?? '').toLowerCase()
      for (const b of BUCKETS) {
        const members = all.filter((e) => !used.has(e.guid) && b.test(e))
        if (!members.length) continue
        let chosen = members.slice(0, BUCKET_CAP)
        if (b.key === 'players' && pin) {
          const pinned = members.find((e) => (e.name ?? '').toLowerCase() === pin)
          if (pinned && !chosen.includes(pinned)) chosen = [pinned, ...chosen.slice(0, BUCKET_CAP - 1)]
        }
        for (const e of chosen) used.add(e.guid)
        const more = members.length > chosen.length ? ` +${members.length - chosen.length} more` : ''
        lines.push(`  ${b.label}: ${chosen.map((e) => entityLine(e, b.key === 'threats' || b.key === 'creatures')).join(', ')}${more}`)
      }
      const rest = all.filter((e) => !used.has(e.guid))
      if (rest.length) {
        const counts = new Map()
        for (const e of rest) counts.set(e.prefab, (counts.get(e.prefab) ?? 0) + 1)
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        lines.push(`  other: ${top.map(([p, n]) => (n > 1 ? `${p} x${n}` : p)).join(', ')}`)
      }

      if (opts.inFlight) {
        const f = opts.inFlight
        lines.push(`in_flight: ${f.name}${f.progress ? ` (${JSON.stringify(f.progress)})` : ''}`)
      }
      lines.push(`last_action_result: ${opts.lastActionResult ?? 'none'}`)
      if (Array.isArray(opts.companions) && opts.companions.length) lines.push(`companions here: ${opts.companions.join(', ')}`)

      prevHp = self.hp
      prevInv = self.inv.map((i) => ({ prefab: i.prefab, qty: i.qty }))
      return lines.join('\n')
    },
    reset() {
      prevHp = null
      prevInv = null
    },
  }
}
