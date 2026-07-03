// src/observers/snapshot.js — composes line-oriented world snapshot (D-26)
// and registers #N targeting handles via setHandles() (D-25).
import { vitals } from './vitals.js'
import { world } from './world.js'
import { inventory, heldItem } from './inventory.js'
import { aroundFeet } from './blocks.js'
import { surveyBlocks } from './veins.js'
import { nearbyEntities, droppedItemName } from './entities.js'
import { setHandles, HANDLE_TTL_MS } from './targeting.js'
import { getCraftableEntries } from './craftable.js'
import { getFollowTargetLabel, getFollowStuckInfo } from '../behaviors/follow.js'
import { nextMilestone, readProgressionState } from './progression.js'
// 260513-wkd: centralised in_flight line rendering. Helper preserves the
// em-dash + y=<currentY> channels byte-stable; only the elapsed
// trailer changes from `(Xs)` to `started=Xs ago` (locked in CONTEXT.md).
import { getInFlightLineForSnapshot } from '../../../brain/inflight.js'

const MAX_ENTITIES = 6

// Resolve the owner's live player entry. `pinUsername` is the name the bot
// calls the player (config.player_username — often a preferred_name like
// "Ouen"), but on a LAN world bot.players is keyed by the actual login (e.g.
// "SSk1tz"). A hard bot.players[pinUsername] lookup then ALWAYS misses, so the
// snapshot reported the owner "out of view — position unknown" on EVERY tick
// even when the player was standing adjacent (field bug 260625), which left the
// model unable to do anything but follow(). Resolve by exact name, then
// case-insensitively, then — single-human LAN — the lone human in the tab list
// that is neither this bot nor a companion. Returns {username, player} or null.
export function resolveOwner(bot, pinUsername, companions) {
  if (!pinUsername) return null
  const players = bot?.players || {}
  if (players[pinUsername]) return { username: pinUsername, player: players[pinUsername] }
  const lc = String(pinUsername).toLowerCase()
  for (const [name, p] of Object.entries(players)) {
    if (name.toLowerCase() === lc) return { username: name, player: p }
  }
  const self = bot?.username
  const compSet = new Set(
    (Array.isArray(companions) ? companions : []).map(c => String(c).toLowerCase()),
  )
  const humans = Object.entries(players).filter(
    ([name]) => name !== self && !compSet.has(name.toLowerCase()),
  )
  if (humans.length === 1) return { username: humans[0][0], player: humans[0][1] }
  return null
}

// 260703 — owner-distance NaN guard. Right after combat / a teleport / a
// respawn, a player or the bot's own entity can be partially loaded with NaN
// position components. The old owner-whereabouts line did
// `Math.round(ownerEnt.position.distanceTo(me.position))`, which returns NaN
// for such a position; `NaN != null` is true, so the snapshot printed
// "(NaN blocks away)". Compute the straight-line distance from the raw coords
// with a hard Number.isFinite gate on every component and return null (→ omit
// the parenthetical) when any is non-finite. Pure + exported for unit testing.
export function ownerDistanceBlocks(ownerPos, selfPos) {
  if (!ownerPos || !selfPos) return null
  const ax = Number(ownerPos.x), ay = Number(ownerPos.y), az = Number(ownerPos.z)
  const bx = Number(selfPos.x), by = Number(selfPos.y), bz = Number(selfPos.z)
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return null
  const d = Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2)
  return Number.isFinite(d) ? Math.round(d) : null
}
// Entity visibility radius (blocks). 64 = 4 chunks, the rough distance at
// which a real Minecraft player can see and identify another player. Bumped
// from 24 so the player stays visible (with coords) as they walk a few chunks
// ahead, instead of dropping out of the snapshot and forcing the model to
// hallucinate a `goTo` target. The kill heuristic in createSnapshotComposer
// intentionally stays at its tighter radius — wider tracking there produces
// false-positive "killed mob" events when entities just wander out of range.
const ENTITY_RADIUS = 64

// 260618: the standalone "you have not moved in Xs" snapshot line was removed.
// It fired on every still moment (including intentional standing, building, and
// waiting on the player) and forced reasoning about a stuck path that usually
// was not stuck. The "your path is not working, look(around) then explore()"
// guidance now lives in the idle tick and the in-flight check-in tick, which
// fire in the situations where it actually applies.

/**
 * Compose a compact snapshot of the bot's current world state.
 * Side effect: replaces the targeting handle table with the #N entries from this snapshot.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ lastActionResult?:string, inFlight?:{name:string,args:any,startedAt:number}|null, pinUsername?:string|null, companions?:string[], worldTag?:string|null, sessionStartedAtMs?:number }} [opts]
 * @returns {string}
 */
export function composeSnapshot(bot, opts = {}) {
  // NB: `world` (the import) is the world-observer fn; the per-world tag comes
  // in as `worldTag` to avoid shadowing it.
  const { lastActionResult, inFlight, pinUsername, worldTag, sessionStartedAtMs } = opts
  // 260618: other AI companions in a multi-bot session. Pinned like the owner
  // (always visible with coords) and labeled "(companion)" so the model can see
  // and coordinate with its teammates instead of confusing them for the human.
  const companions = (Array.isArray(opts.companions) ? opts.companions : [])
    .filter(c => typeof c === 'string' && c.trim())
  const v = vitals(bot)
  const w = world(bot)
  const held = heldItem(bot)
  const inv = inventory(bot)
  const survey = surveyBlocks(bot, { radius: 16, maxNames: 10 })
  // requireLineOfSight (260618): list only entities the bot can actually see
  // (within ENTITY_RADIUS and not occluded by terrain/fluids — so no underground
  // or behind-wall mobs). Entities behind the bot still count; the pinned owner
  // + companions are exempt so their coords never drop out.
  // Resolve the owner's live entity ONCE (handles preferred_name vs LAN login
  // mismatch — see resolveOwner). The resolved actual username is what we pin in
  // `nearby entities` so the player can't be evicted by entity congestion, and
  // it's what the owner-whereabouts line reads coords from below.
  const owner = resolveOwner(bot, pinUsername ?? null, companions)
  const ownerPinName = owner?.username ?? (pinUsername ?? null)
  const ents = nearbyEntities(bot, { radius: ENTITY_RADIUS, count: MAX_ENTITIES, pin: ownerPinName, pins: companions, requireLineOfSight: true })

  const lines = []
  // Which world this is (multi-world memory). Surfaced first so the bot anchors
  // its memory to the right world before reasoning — memories from other worlds
  // are labeled `## World N` in MEMORY.md.
  if (worldTag) lines.push(`world: ${worldTag}`)
  // Position / biome / time
  lines.push(`pos: ${w.pos.x},${w.pos.y},${w.pos.z}`)
  lines.push(`biome: ${w.biome}  surroundings: ${w.surroundings}  time: ${w.time.isDay ? 'day' : 'night'} (${w.time.timeOfDay})`)
  // Real-world clock + session age (260703). The model has no sense of elapsed
  // time and guessed session length wrong ("probably 8-9 mins" on a 7-minute
  // session) — give it the wall clock and minutes-since-join so "how long have
  // we been playing" is answered from data, not vibes.
  if (typeof sessionStartedAtMs === 'number') {
    const mins = Math.floor((Date.now() - sessionStartedAtMs) / 60_000)
    const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    lines.push(`real time: ${clock} — you joined this session ${mins < 1 ? 'under a minute' : `${mins} min`} ago`)
  }

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
  // about new actions. 260513-wkd: rendered via getInFlightLineForSnapshot so
  // brain + adapter share a single source-of-truth formatter. The helper
  // preserves the em-dash + y=<currentY> channels byte-stable;
  // only the elapsed trailer changes from `(Xs)` to `started=Xs ago`.
  const inFlightLine = getInFlightLineForSnapshot(inFlight)
  if (inFlightLine) lines.push(inFlightLine)

  // Inventory — append `(K/36 slots)` so the LLM can't confabulate "inventory
  // full" when downstream actions return "no X in inventory" (the real cause
  // is usually a dig-drop that hasn't been auto-collected yet, not capacity).
  // bot.inventory.items() returns the 36 main-inventory slots only (excludes
  // armor / offhand / crafting), so .length is the used-slot count.
  const invEntries = Object.entries(inv)
  const invStr = invEntries.length
    ? invEntries.map(([k, n]) => `${k}×${n}`).join(' ')
    : 'empty'
  const slotsUsed = (typeof bot.inventory?.items === 'function') ? bot.inventory.items().length : 0
  lines.push(`inventory (${slotsUsed}/36 slots): ${invStr}`)

  // Craftable — what the bot can make RIGHT NOW from its materials. Gated by a
  // crafting table in reach: without one only 2×2 (inventory-grid) recipes show;
  // within reach of a crafting_table the 3×3 recipes appear too. Crafting
  // CONSUMES the listed materials and the bot sees only the product here (not the
  // ingredients) — the capability text tells it to plan crafts carefully.
  // Defensive + cached inside getCraftableEntries; omitted entirely when empty.
  const craftable = getCraftableEntries(bot)
  if (craftable.entries.length > 0) {
    const where = craftable.nearTable
      ? 'crafting_table in reach — 3×3 recipes included'
      : 'no crafting_table in reach — 2×2 (inventory) recipes only; more unlock at a table'
    lines.push(`craftable (${where}): crafting uses up materials, plan carefully`)
    for (const e of craftable.entries) {
      lines.push(`  ${e.name} craftable - ${e.count}x`)
    }
  }

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

  // Nearby blocks: one line per unique block name within radius. The #N
  // handle is anchored at the NEAREST member of that name — pass it to
  // dig/gather/goTo when the LLM wants to act on this resource.
  lines.push('nearby blocks:')
  if (survey.groups.length === 0) {
    lines.push('  (none)')
  } else {
    for (const g of survey.groups) {
      const tag = `#${n++}`
      lines.push(`  ${tag} ${g.name} x${g.total} @${g.nearest.x},${g.nearest.y},${g.nearest.z}`)
      handles.push([tag, { kind: 'block', pos: { x: g.nearest.x, y: g.nearest.y, z: g.nearest.z }, expiresAt }])
    }
    if (survey.more > 0) lines.push(`  +${survey.more} more`)
  }

  // Nearby entities
  lines.push('nearby entities:')
  if (ents.entries.length === 0) {
    lines.push('  (none)')
  } else {
    for (const { entity: e } of ents.entries) {
      const tag = `#${n++}`
      let label = e.username ?? e.name ?? `entity-${e.id}`
      // Decode dropped-item entities to `item(<name>)` so the LLM can see what
      // it's looking at (e.g. an unpicked-up dirt drop from a recent dig).
      if (label === 'item' || label === 'item_stack') {
        const itemName = droppedItemName(e)
        if (itemName) label = `item(${itemName})`
      }
      // 260618: mark fellow AI companions so the model treats them as teammates
      // (coordinate / direct) and never mistakes one for the human player.
      if (e.username && companions.includes(e.username)) label = `${e.username} (companion)`
      const x = Math.round(e.position.x)
      const y = Math.round(e.position.y)
      const z = Math.round(e.position.z)
      lines.push(`  ${tag} ${label} @${x},${y},${z}`)
      handles.push([tag, { kind: 'entity', entityId: e.id, expiresAt }])
    }
    if (ents.more > 0) lines.push(`  +${ents.more} more`)
  }

  // Follow status — bot's awareness of its own auto-follow behavior
  const followLabel = getFollowTargetLabel()
  const followStuck = followLabel ? getFollowStuckInfo() : null
  if (followStuck) {
    // No forward progress for a while — the target likely climbed terrain the
    // pathfinder can't scale. Surface it loudly so the model REACTS (the check-
    // in nudge has a matching stuck-exception) instead of trailing a frozen
    // follow. The 'try goTo/pillar up' hint mirrors goTo's vertical recovery.
    const highHint = followStuck.deltaY >= 3
      ? ` and ${followStuck.deltaY} blocks ABOVE you — you can't path up a climb that steep`
      : ''
    lines.push(`follow_target: ${followLabel} — STUCK: no progress for ${followStuck.stuckSec}s, ${followLabel} is ${followStuck.dist}m away${highHint}. Don't just wait: call them back to you (one say()), or unfollow and do your own thing, or goTo them / pillar up toward them.`)
  } else {
    lines.push(`follow_target: ${followLabel ?? '(none)'}`)
  }

  // Advisory next: line (17-04, D-07). One per-turn surfacing of the nearest
  // progression milestone + the single action that advances it, so the model
  // always sees "what's next" without re-deriving it. Best-effort: any error
  // (or a malformed spine) just skips the line — a snapshot tick never throws.
  // This is ADDITIVE; the heartbeat frontier path (orchestrator renderHeartbeat)
  // is complementary and untouched.
  try {
    const nm = nextMilestone(readProgressionState(bot))
    if (nm?.node) lines.push(`next: ${nm.node.label} — ${nm.action}`)
  } catch { /* progression advisory is best-effort; never break a snapshot tick */ }

  // Owner whereabouts (260607). The pinned owner can be BEYOND the entity
  // render radius — then they're absent from `nearby entities` and the model
  // has no coords for "come to me", so it hallucinates (in the field logs it
  // walked to its OWN position and claimed it arrived). Resolve the owner from
  // the players tab list and state their position explicitly, or say plainly
  // that it's unknown so the model asks/follows instead of guessing.
  if (pinUsername) {
    const me = bot.entity
    const ownerEnt = owner?.player?.entity
    if (ownerEnt?.position && me?.position) {
      const ox = Math.round(ownerEnt.position.x)
      const oy = Math.round(ownerEnt.position.y)
      const oz = Math.round(ownerEnt.position.z)
      // A partially-loaded player/self entity can carry NaN coords right after
      // combat/teleport; the old `Math.round(distanceTo(...))` then yielded NaN
      // and `NaN != null` is true, so the snapshot printed "(NaN blocks away)".
      // ownerDistanceBlocks computes the distance from the coords with a
      // Number.isFinite gate and returns null when any coord is non-finite, so
      // the parenthetical is omitted rather than showing garbage.
      let dist = null
      try { dist = ownerDistanceBlocks(ownerEnt.position, me.position) } catch { /* leave null */ }
      // Show the live in-game name when it differs from the name we call them,
      // so the model connects `owner Ouen` with `SSk1tz` in `nearby entities`
      // (otherwise it can read them as two different people).
      const liveName = owner?.username && owner.username !== pinUsername ? ` (in-game ${owner.username})` : ''
      lines.push(`owner ${pinUsername}${liveName}: @${ox},${oy},${oz}${dist != null ? ` (${dist} blocks away)` : ''}`)
    } else {
      lines.push(`owner ${pinUsername}: out of view — position unknown (to reach them call follow; if they are not loaded, ask them to come closer or share coords — do NOT guess a destination)`)
    }
  }

  // Last action result
  if (lastActionResult) lines.push(`last_action_result: ${lastActionResult}`)

  // Side effect: install handle table.
  setHandles(handles)

  return lines.join('\n')
}

// recent_events deltas are observational hints, not an authoritative log.
// Kills are sourced from REAL bot.on('entityDead') events (260607). The prior
// implementation inferred "killed X" from any entity leaving a 24-block radius,
// which fired on mobs that merely walked away, on every teleport (the whole
// nearby set despawns at once → "killed wolf; killed arrow"), and on picked-up
// or despawned dropped items ("killed item"). That fed the model fabricated
// history. Inventory + hp deltas remain diff-based.
/**
 * Create a stateful snapshot composer that tracks per-instance previous
 * inventory / hp state and injects a `recent_events:` line into each composed
 * snapshot describing diffs since the prior call. Genuine entity deaths near
 * the bot are captured live via an entityDead subscription.
 *
 * The bare {@link composeSnapshot} export remains stateless for any callers
 * that don't want delta tracking.
 *
 * @param {{ bot: import('mineflayer').Bot }} deps
 */
export function createSnapshotComposer({ bot }) {
  let prevInventory = null
  let prevHp = null
  // Session clock anchor: the composer is created once per bot session (right
  // around join), so "now minus this" is minutes-in-world for the `real time`
  // snapshot line.
  const sessionStartedAtMs = Date.now()

  // Real deaths since the last snapshot, grouped by entity name. Populated by
  // the entityDead subscription below; drained each next() call.
  let deaths = new Map()

  // Entities that "die"/despawn in the protocol but are NOT creature kills.
  // Excluding them is what stops the old "killed arrow" / "killed item" noise.
  const NON_CREATURE = new Set([
    'arrow', 'spectral_arrow', 'item', 'item_stack', 'experience_orb',
    'snowball', 'egg', 'potion', 'splash_potion', 'fishing_bobber',
    'eye_of_ender', 'firework_rocket', 'llama_spit', 'trident',
  ])

  function onEntityDead(entity) {
    try {
      if (!entity || entity.username) return            // players are not kills
      const name = entity.name ?? ''
      if (NON_CREATURE.has(name)) return                // projectiles / drops / xp
      // Only deaths within view — far-world deaths are not the bot's business.
      const me = bot.entity
      if (me?.position && entity.position) {
        let d
        try { d = entity.position.distanceTo(me.position) } catch { d = Infinity }
        if (d > 32) return
      }
      const key = name || `entity-${entity.id}`
      deaths.set(key, (deaths.get(key) ?? 0) + 1)
    } catch { /* never let an observer throw into the event loop */ }
  }
  bot.on('entityDead', onEntityDead)

  // Returns { inv, other }: inventory deltas are split out so next() can render
  // them as their OWN prominent section right under the inventory line (260617
  // — the bot kept overlooking handoffs like "i'll turn your logs to planks"
  // because the gain/loss was buried in a trailing recent_events line). Deaths +
  // hp stay in `other` → the existing recent_events line.
  function computeEvents(currInv, currHp) {
    // 1. Inventory deltas — gains then losses, capped to 6 entries total.
    const inv = []
    if (prevInventory) {
      // Gains / increases
      for (const [k, v] of Object.entries(currInv)) {
        const prev = prevInventory[k] ?? 0
        if (v > prev) inv.push(`+${v - prev} ${k}`)
      }
      // Losses / removed keys
      for (const [k, v] of Object.entries(prevInventory)) {
        const curr = currInv[k] ?? 0
        if (curr < v) inv.push(`-${v - curr} ${k}`)
      }
    }
    const cap = 6
    const invCapped = inv.length > cap
      ? [...inv.slice(0, cap), `(+${inv.length - cap} more)`]
      : inv

    const other = []
    // 2. Real creature deaths near the bot (from entityDead — see above). No
    //    attacker attribution from the protocol, so phrase as "X died" rather
    //    than claiming a kill the bot may not have made.
    for (const [name, count] of deaths) {
      other.push(count > 1 ? `${name} died ×${count}` : `${name} died`)
    }

    // 3. HP loss only — regen is noisy.
    if (prevHp != null && currHp < prevHp) {
      other.push(`hp -${prevHp - currHp}`)
    }

    return { inv: invCapped, other }
  }

  return {
    next(opts = {}) {
      const base = composeSnapshot(bot, { ...opts, sessionStartedAtMs })
      const currInv = inventory(bot)
      const currHp = Math.round(bot.health ?? 0)
      const { inv, other } = computeEvents(currInv, currHp)

      // Update inv/hp state AFTER computing — first call has no deltas.
      prevInventory = currInv
      prevHp = currHp
      deaths = new Map()   // drain the death buffer for the next window

      if (inv.length === 0 && other.length === 0) return base
      const lines = base.split('\n')

      // Inventory changes get a LOUD, dedicated section right under the
      // inventory line — the bot reads inventory there, so a handoff / pickup /
      // drop is impossible to miss, and it knows to act on what just arrived.
      if (inv.length > 0) {
        const invLine = `*** INVENTORY JUST CHANGED ***: ${inv.join(', ')}  <- items entered or left your inventory since last tick (the player handed you something, you picked it up, or you used/dropped it). React to it: equip a new tool, eat new food, build with new blocks. If you were waiting on something you asked for, this is it arriving.`
        const i = lines.findIndex(l => l.startsWith('inventory ('))
        if (i >= 0) lines.splice(i + 1, 0, invLine)
        else lines.unshift(invLine)
      }

      // Deaths + hp loss stay in the quieter recent_events line near the bottom.
      if (other.length > 0) {
        const line = `recent_events: ${other.join('; ')}`
        const idx = lines.findIndex(l => l.startsWith('last_action_result:'))
        if (idx >= 0) lines.splice(idx + 1, 0, line)
        else lines.push(line)
      }
      return lines.join('\n')
    },
    reset() {
      prevInventory = null
      prevHp = null
      deaths = new Map()
    },
    dispose() {
      try { bot.removeListener('entityDead', onEntityDead) } catch { /* ignore */ }
    },
  }
}
