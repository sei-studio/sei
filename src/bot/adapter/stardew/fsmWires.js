// src/bot/adapter/stardew/fsmWires.js — translate the mod's pushed events
// (PROTOCOL.md) into the brain's AdapterHandlers (src/bot/brain/types.js).
// Thin: no business logic, the same shape as the Minecraft wires.
//
//   chat        -> onChat        (own name / companion lines filtered like chat.js)
//   damaged     -> onAttacked    attackerKind 'mob' (the body WAS hit); when the
//                                reflex is already retreating it is tagged
//                                'reflex' + survivalKind so it lands at P1
//   survival    -> onAttacked    attackerKind 'reflex' + survivalKind
//   death       -> onDeath
//   spawned     -> onSpawn       (+ onPlayerJoined for the host, so sessionState
//                                 can adopt the player without a join event)
//   obs         -> onPlayerJoined / onPlayerLeft as players come and go
//   day_started / night_soon -> a system chat line that wakes the brain at P1
//                                without preempting (playerSpoke:false); there
//                                is no idle-tick handler in the contract.

const NAME_RE_CACHE = new Map()
function mentions(text, name) {
  if (!name) return false
  let re = NAME_RE_CACHE.get(name)
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    NAME_RE_CACHE.set(name, re)
  }
  return re.test(String(text ?? ''))
}

/**
 * @param {ReturnType<import('./client.js').createStardewClient>} client
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ botName: string, companions?: () => string[], logger?: object }} opts
 * @returns {() => void} dispose
 */
export function wireStardewEvents(client, handlers, { botName, companions = () => [], logger = console } = {}) {
  if (!client) throw new Error('wireStardewEvents: client required')
  if (!handlers) throw new Error('wireStardewEvents: handlers required')
  const known = new Map() // farmerId -> username
  const safe = (label, fn) => (frame) => {
    try { fn(frame) } catch (err) { logger.error?.(`[sei/stardew wires] ${label} handler threw: ${err && err.message}`) }
  }

  const onChat = safe('onChat', (f) => {
    const text = String(f.text ?? '').trim()
    if (!text) return
    const from = String(f.from ?? 'someone')
    if (from.toLowerCase() === String(botName).toLowerCase()) return
    const comps = (companions() ?? []).map((c) => String(c).toLowerCase())
    const fromCompanion = comps.includes(from.toLowerCase())
    const addressedToSibling = !mentions(text, botName) && comps.some((c) => mentions(text, c))
    handlers.onChat?.({
      username: from,
      text,
      playerSpoke: !fromCompanion,
      addressed: mentions(text, botName),
      nearby: f.sameLocation !== false,
      // A sibling companion's own chatter, or a line aimed by name at a
      // sibling, is history only (chat.js semantics).
      suppressInterrupt: fromCompanion || addressedToSibling,
    })
  })

  const onDamaged = safe('onDamaged', (f) => {
    const label = String(f.attacker ?? 'something')
    if (f.retreating) {
      handlers.onAttacked?.({
        attacker: null,
        attackerLabel: label,
        attackerKind: 'reflex',
        survivalKind: 'critical_retreat',
        health: f.health, maxHealth: f.maxHealth,
      })
      return
    }
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: label,
      attackerKind: 'mob',
      pvp: false,
      damage: f.damage,
      health: f.health,
      maxHealth: f.maxHealth,
      retaliated: !!f.retaliated,
    })
  })

  const onSurvival = safe('onSurvival', (f) => {
    const kind = String(f.kind ?? 'retreat')
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: String(f.attacker ?? 'danger'),
      attackerKind: 'reflex',
      survivalKind: kind === 'retreat' ? 'critical_retreat' : kind,
      detail: f.detail,
      health: f.health, maxHealth: f.maxHealth,
      time: f.time,
    })
  })

  const onDeath = safe('onDeath', (f) => {
    handlers.onDeath?.({ pos: null, cause: f.cause ?? null, where: f.where ?? null })
  })

  const onSpawned = safe('onSpawned', () => {
    handlers.onSpawn?.()
  })

  const onObs = safe('onObs', (f) => {
    const obs = f.obs
    if (!obs) return
    const seen = new Map()
    for (const e of Array.isArray(obs.entities) ? obs.entities : []) {
      if (e.kind === 'player' && e.farmerId) seen.set(String(e.farmerId), String(e.name))
    }
    if (obs.player?.farmerId) seen.set(String(obs.player.farmerId), String(obs.player.name))
    for (const [id, username] of seen) {
      if (!known.has(id)) {
        known.set(id, username)
        handlers.onPlayerJoined?.({ username, uuid: `stardew:${id}` })
      }
    }
    // A player who left the SESSION (not just the map) stops appearing in
    // `player` too; the entity list only covers the current map, so only the
    // owner slot is trusted for leave detection.
    if (obs.player?.farmerId == null && known.size > 0 && Array.isArray(obs.entities) && obs.entities.length === 0) {
      // No signal either way; keep the roster.
    }
  })

  // 260921: gameEvent marks a line nobody SAID. Without it the brain framed
  // the new-day notice as a line spoken to the companion ("a direct message
  // never gets silence"), which contradicts the notice's own "only speak if
  // it fits" and produced a second "morning" seconds after the first; it also
  // filed the notice in the chat transcript as a speaker.
  const systemLine = (text) => {
    handlers.onChat?.({
      username: 'sei',
      text,
      playerSpoke: false,
      gameEvent: true,
      addressed: true,
      nearby: true,
    })
  }
  const onDayStarted = safe('onDayStarted', (f) => {
    systemLine(`[A new day: ${f.season ?? ''} ${f.day ?? ''}, ${f.weather ?? 'sunny'}. Your energy and health are full. This is a game event, not the player talking; act on it, and only speak if it fits.]`)
  })
  const onNightSoon = safe('onNightSoon', () => {
    systemLine('[It is 10 PM. The day ends at 2 AM and you pass out if you are still up. This is a game event, not the player talking; wrap up what you are doing and consider heading home, and only speak if it fits.]')
  })

  client.on('chat', onChat)
  client.on('damaged', onDamaged)
  client.on('survival', onSurvival)
  client.on('death', onDeath)
  client.on('spawned', onSpawned)
  client.on('obs', onObs)
  client.on('day_started', onDayStarted)
  client.on('night_soon', onNightSoon)

  return function dispose() {
    client.off('chat', onChat)
    client.off('damaged', onDamaged)
    client.off('survival', onSurvival)
    client.off('death', onDeath)
    client.off('spawned', onSpawned)
    client.off('obs', onObs)
    client.off('day_started', onDayStarted)
    client.off('night_soon', onNightSoon)
  }
}
