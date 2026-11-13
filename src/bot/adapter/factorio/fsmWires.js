// src/bot/adapter/factorio/fsmWires.js: translate the mod's feed events
// (native/factorio-mod/PROTOCOL.md "Events") into the brain's
// AdapterHandlers (src/bot/brain/types.js). Thin: no game logic.
//
//   chat          -> onChat (a sibling companion's line is history only)
//   hit           -> onAttacked attackerKind 'mob' (her body WAS hit)
//   fight         -> onAttacked 'reflex' + survivalKind 'fight' (her reflex
//                    opened fire, near her or the player)
//   survival      -> onAttacked 'reflex' + survivalKind
//                    (critical_retreat / safe / no_ammo)
//   death         -> onDying + onDeath (detail: cause, where, respawn seconds)
//   respawned, rescued, owner_away, research_finished
//                 -> a system chat line (gameEvent) that wakes the brain at
//                    P1 without preempting
//   player_joined / player_left -> onPlayerJoined / onPlayerLeft

import { foldLatin } from '../../names.js'
import { RESPAWNED_ADDENDUM, RESCUED_ADDENDUM, OWNER_AWAY_ADDENDUM, RESEARCH_DONE_ADDENDUM } from './prompts.js'

const NAME_RE_CACHE = new Map()
export function mentions(text, name) {
  name = foldLatin(name)
  if (!name) return false
  let re = NAME_RE_CACHE.get(name)
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    NAME_RE_CACHE.set(name, re)
  }
  return re.test(foldLatin(text))
}

const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m))

/** Entity names read better without dashes ("small-biter" -> "small biter"). */
export const words = (s) => String(s ?? '').replace(/-/g, ' ')

/**
 * @param {{ on: Function, off: Function }} client  emits each feed event by its `t`
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ botName: string, companions?: () => string[], logger?: object, onEvent?: (ev: object) => void }} opts
 *   `onEvent` sees every event first (analytics counters).
 * @returns {() => void} dispose
 */
export function wireFactorioEvents(client, handlers, { botName, companions = () => [], logger = console, onEvent = null } = {}) {
  if (!client) throw new Error('wireFactorioEvents: client required')
  if (!handlers) throw new Error('wireFactorioEvents: handlers required')
  const safe = (label, fn) => (ev) => {
    try { onEvent?.(ev) } catch {}
    try { fn(ev) } catch (err) { logger.error?.(`[sei/factorio wires] ${label} threw: ${err && err.message}`) }
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

  const onChat = safe('chat', (ev) => {
    const text = String(ev.text ?? '').trim()
    if (!text) return
    const from = String(ev.from ?? 'someone')
    if (from.toLowerCase() === String(botName).toLowerCase()) return
    const comps = (companions() ?? []).map((c) => String(c).toLowerCase())
    const fromCompanion = ev.companion === true || comps.includes(from.toLowerCase())
    const addressedToSibling = !mentions(text, botName) && comps.some((c) => mentions(text, c))
    handlers.onChat?.({
      username: from,
      text,
      playerSpoke: !fromCompanion,
      fromCompanion,
      addressed: mentions(text, botName),
      nearby: true,
      suppressInterrupt: fromCompanion || addressedToSibling,
    })
  })

  const onHit = safe('hit', (ev) => {
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: words(ev.attacker ?? 'something'),
      attackerKind: 'mob',
      pvp: false,
      damage: ev.damage,
      health: ev.health,
      maxHealth: 100,
      fighting: ev.fighting === true,
    })
  })

  const onFight = safe('fight', (ev) => {
    const n = Number(ev.count) || 1
    const what = `${n > 1 ? `${n} ` : 'a '}${words(ev.enemy ?? 'enemy')}${n > 1 ? 's' : ''} attacking`
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: words(ev.enemy ?? 'enemy'),
      attackerKind: 'reflex',
      survivalKind: 'fight',
      detail: what,
      nearOwner: ev.near_owner === true,
      count: n,
    })
  })

  const onSurvival = safe('survival', (ev) => {
    const kind = String(ev.kind ?? 'retreat')
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: words(ev.attacker ?? 'danger'),
      attackerKind: 'reflex',
      survivalKind: kind === 'retreat' ? 'critical_retreat' : kind,
      health: ev.health,
      maxHealth: 100,
    })
  })

  const onDeath = safe('death', (ev) => {
    try { handlers.onDying?.() } catch {}
    handlers.onDeath?.({
      pos: null,
      diedAt: Date.now(),
      detail: { cause: ev.cause ? words(ev.cause) : null, at: ev.at ?? null, respawnS: ev.respawn_s ?? 10 },
    })
  })

  const onRespawned = safe('respawned', () => systemLine(`[${RESPAWNED_ADDENDUM} This is a game event, not the player talking.]`, 'she respawned next to the player'))
  const onRescued = safe('rescued', (ev) => systemLine(`[${fill(RESCUED_ADDENDUM, { reason: ev.reason ?? 'blocked' })} This is a game event, not the player talking.]`, 'she hopped to the player after losing the path'))
  const onOwnerAway = safe('owner_away', (ev) => systemLine(`[${fill(OWNER_AWAY_ADDENDUM, { surface: ev.surface ?? 'another surface' })} This is a game event, not the player talking.]`, `the player went to ${ev.surface ?? 'another surface'}`))
  const onResearch = safe('research_finished', (ev) => systemLine(`[${fill(RESEARCH_DONE_ADDENDUM, { tech: words(ev.tech) })} This is a game event, not the player talking.]`, `research finished: ${ev.tech}`))
  const onJoined = safe('player_joined', (ev) => { if (ev.name) handlers.onPlayerJoined?.({ username: String(ev.name), uuid: `factorio:${ev.name}` }) })
  const onLeft = safe('player_left', (ev) => { if (ev.name) handlers.onPlayerLeft?.({ username: String(ev.name), uuid: `factorio:${ev.name}` }) })
  const onQuiet = safe('other', () => {})

  const table = {
    chat: onChat,
    hit: onHit,
    fight: onFight,
    survival: onSurvival,
    death: onDeath,
    respawned: onRespawned,
    rescued: onRescued,
    owner_away: onOwnerAway,
    research_finished: onResearch,
    player_joined: onJoined,
    player_left: onLeft,
    fight_over: onQuiet,
    result: onQuiet,
    spawned: onQuiet,
  }
  for (const [t, fn] of Object.entries(table)) client.on(t, fn)
  return function dispose() {
    for (const [t, fn] of Object.entries(table)) client.off(t, fn)
  }
}
