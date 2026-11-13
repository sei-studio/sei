// src/bot/adapter/terraria/fsmWires.js — translate the mod's pushed events
// (native/terraria-mod/PROTOCOL.md) into the brain's AdapterHandlers
// (src/bot/brain/types.js). Thin, same shape as the Stardew wires.
//
//   chat      -> onChat        (own lines dropped; companion lines are history only)
//   damaged   -> onAttacked    'mob', but only the first hit of a fight: combat
//                              runs in the mod by stance, so every hit as a
//                              turn would cost tokens and say nothing new
//   survival  -> onAttacked    'reflex' + survivalKind (retreating / low_health);
//                              a reflex heal is not a turn (the snapshot shows it)
//   death     -> onDeath
//   spawned   -> onSpawn
//   obs       -> onPlayerJoined / onPlayerLeft as players come and go
//   event     -> a game-event line at P1 (bosses, blood moon, invasions,
//                dusk, the player dying or low on health)

import { foldLatin } from '../../names.js'
import { worldEventLine } from './prompts.js'
import { reflexKindOf } from './stats.js'

/** A hit from the same attacker within this window is the same fight. */
export const FIGHT_WINDOW_MS = 20_000
/** World alerts that become a turn. Dawn and slime-rain ends are left to the snapshot. */
export const EVENT_KINDS_FOR_TURN = new Set([
  'blood_moon', 'eclipse', 'pumpkin_moon', 'frost_moon', 'slime_rain',
  'invasion', 'invasion_end', 'dusk',
  'boss_spawn', 'boss_defeated', 'boss_left',
  'player_died', 'player_low',
])

const NAME_RE_CACHE = new Map()
function mentions(text, name) {
  name = foldLatin(name)
  if (!name) return false
  let re = NAME_RE_CACHE.get(name)
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    NAME_RE_CACHE.set(name, re)
  }
  return re.test(foldLatin(text))
}

/** Chat heard within this many tiles counts as nearby (the mod sends `dist` per session). */
export const HEARING_TILES = 60

/**
 * @param {ReturnType<import('./client.js').createTerrariaClient>} client
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ botName: string, companions?: () => string[], logger?: object, now?: () => number, stats?: ReturnType<import('./stats.js').createTerrariaStats> | null }} opts
 * @returns {() => void} dispose
 */
export function wireTerrariaEvents(client, handlers, { botName, companions = () => [], logger = console, now = () => Date.now(), stats = null } = {}) {
  if (!client) throw new Error('wireTerrariaEvents: client required')
  if (!handlers) throw new Error('wireTerrariaEvents: handlers required')
  const known = new Set()
  let lastHitAt = -Infinity
  let lastHitBy = null
  const safe = (label, fn) => (frame) => {
    try { fn(frame) } catch (err) { logger.error?.(`[sei/terraria wires] ${label} handler threw: ${err && err.message}`) }
  }

  const systemLine = (text, eventFact) => {
    handlers.onChat?.({
      username: 'sei',
      text,
      ...(eventFact ? { eventFact } : {}),
      playerSpoke: false,
      gameEvent: true,
      addressed: true,
      nearby: true,
    })
  }

  const onChat = safe('onChat', (f) => {
    const text = String(f.text ?? '').trim()
    if (!text) return
    const from = String(f.from ?? 'someone')
    if (from.toLowerCase() === String(botName).toLowerCase()) return
    const comps = (companions() ?? []).map((c) => String(c).toLowerCase())
    const fromCompanion = f.kind === 'companion' || comps.includes(from.toLowerCase())
    const addressed = mentions(text, botName)
    const addressedToSibling = !addressed && comps.some((c) => mentions(text, c))
    const dist = Number(f.dist)
    handlers.onChat?.({
      username: from,
      text,
      playerSpoke: !fromCompanion,
      fromCompanion,
      addressed,
      nearby: !Number.isFinite(dist) || dist <= HEARING_TILES,
      suppressInterrupt: fromCompanion || addressedToSibling,
    })
  })

  const onDamaged = safe('onDamaged', (f) => {
    const label = String(f.by ?? 'something')
    const t = now()
    const sameFight = t - lastHitAt < FIGHT_WINDOW_MS && label === lastHitBy
    lastHitAt = t
    lastHitBy = label
    if (sameFight) return
    try { stats?.reflex('fight') } catch {}
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: label,
      attackerKind: 'mob',
      pvp: false,
      damage: f.amount,
      health: f.hp,
      maxHealth: f.maxHp,
      retaliated: true,
    })
  })

  const onSurvival = safe('onSurvival', (f) => {
    const kind = String(f.kind ?? '')
    try { const k = reflexKindOf({ t: 'survival', kind }); if (k) stats?.reflex(k) } catch {}
    if (kind === 'healed') return
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: lastHitBy ?? 'danger',
      attackerKind: 'reflex',
      survivalKind: kind === 'retreating' ? 'critical_retreat' : kind,
      potions: f.potions,
      health: f.hp,
      maxHealth: f.maxHp,
    })
  })

  const onDeath = safe('onDeath', (f) => {
    lastHitAt = -Infinity
    try { stats?.reflex('knocked_out') } catch {}
    handlers.onDeath?.({ pos: null, cause: f.by ?? null, where: null })
  })

  const onSpawned = safe('onSpawned', () => { handlers.onSpawn?.() })

  const onEvent = safe('onEvent', (f) => {
    const kind = String(f.kind ?? '')
    if (kind === 'player_joined' || kind === 'player_left') return // handled from obs
    if (!EVENT_KINDS_FOR_TURN.has(kind)) return
    try { stats?.alert(kind) } catch {}
    const text = String(f.text ?? '').trim()
    if (!text) return
    systemLine(worldEventLine(text), text.replace(/[.!]+$/, '').toLowerCase())
  })

  const onObs = safe('onObs', (f) => {
    const players = Array.isArray(f.obs?.players) ? f.obs.players : null
    if (!players) return
    const here = new Set(players.map((p) => String(p.name ?? '')).filter(Boolean))
    for (const name of here) {
      if (known.has(name)) continue
      known.add(name)
      handlers.onPlayerJoined?.({ username: name, uuid: `terraria:${name}` })
    }
    for (const name of [...known]) {
      if (here.has(name)) continue
      known.delete(name)
      handlers.onPlayerLeft?.({ username: name, uuid: `terraria:${name}` })
    }
  })

  client.on('chat', onChat)
  client.on('damaged', onDamaged)
  client.on('survival', onSurvival)
  client.on('death', onDeath)
  client.on('spawned', onSpawned)
  client.on('event', onEvent)
  client.on('obs', onObs)

  return function dispose() {
    client.off('chat', onChat)
    client.off('damaged', onDamaged)
    client.off('survival', onSurvival)
    client.off('death', onDeath)
    client.off('spawned', onSpawned)
    client.off('event', onEvent)
    client.off('obs', onObs)
  }
}
