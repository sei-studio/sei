// src/bot/adapter/dontstarve/fsmWires.js — mod events -> AdapterHandlers
// (game-adapters M2, 260908). Thin translation, no business logic: the
// runtime's link emits the /event kinds the mod POSTs and this maps them onto
// the five brain handlers (src/bot/brain/types.js).
//
//   chat        -> onChat        (P1; the player spoke in game chat)
//   attacked    -> onAttacked    (P0 mob/player hit; the body already swings back)
//   survival    -> onAttacked    attackerKind 'reflex' (P1): the safety layer
//                                retreated / walked to light / ate on its own
//   enterdark   -> onAttacked    attackerKind 'reflex', survivalKind 'dark' (P1)
//   death       -> onDeath       (P1)
//   spawned     -> onSpawn
//   phase       -> a P3 idle tick with reason 'phase_change' via onIdleNudge
//                  (the brain has no phase concept; the runtime enqueues it as
//                  an idle-flavored wake through the handler set's onIdle when
//                  present, else it is folded into the next snapshot)
//
// Chat lines from the companion itself are skipped by the mod (guid match);
// lines from OTHER Sei companions are recorded but do not wake the brain
// (suppressInterrupt), mirroring behaviors/chat.js.

const ADDRESS_RE = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i')

/**
 * @param {import('node:events').EventEmitter} link  the runtime's event bus
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ botName: string, companions: () => string[], playerName?: string|null }} opts
 * @returns {() => void} dispose
 */
export function wireLinkEvents(link, handlers, opts) {
  if (!link) throw new Error('wireLinkEvents: link required')
  if (!handlers) throw new Error('wireLinkEvents: handlers required')
  const botName = String(opts?.botName ?? 'Sei')
  const addressed = ADDRESS_RE(botName)
  const safe = (label, fn) => (payload) => {
    try { fn(payload ?? {}) } catch (err) {
      console.error?.(`[sei/dst-wires] ${label} handler threw: ${err && err.message}`)
    }
  }

  const onChat = safe('onChat', (p) => {
    const text = String(p.text ?? '')
    if (!text.trim()) return
    const username = String(p.name || p.userid || 'player')
    const companions = (opts?.companions?.() ?? []).map((c) => String(c).toLowerCase())
    const fromCompanion = companions.includes(username.toLowerCase())
    const isAddressed = addressed.test(text)
    // A sibling companion's line is context, not a wake, unless it names us.
    const suppressInterrupt = fromCompanion && !isAddressed
    handlers.onChat?.({
      username,
      text,
      playerSpoke: !fromCompanion,
      fromCompanion,
      addressed: isAddressed,
      nearby: true,
      suppressInterrupt,
    })
  })

  const onAttacked = safe('onAttacked', (p) => {
    handlers.onAttacked?.({
      attacker: p.attacker != null ? { username: p.isplayer ? String(p.label ?? 'a player') : null, uuid: String(p.attacker) } : null,
      attackerLabel: String(p.label ?? 'something'),
      attackerKind: p.isplayer ? 'player' : 'mob',
      pvp: false,
      healthPct: typeof p.healthpct === 'number' ? p.healthpct : null,
      damage: typeof p.damage === 'number' ? p.damage : null,
    })
  })

  const onSurvival = safe('onSurvival', (p) => {
    const what = String(p.what ?? 'retreat')
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: String(p.threat ?? 'danger'),
      attackerKind: 'reflex',
      survivalKind: what === 'dark' ? 'dark' : what === 'ate' ? 'ate' : 'critical_retreat',
      phase: p.phase ?? null,
      item: p.item ?? null,
      count: 1,
    })
  })

  const onEnterDark = safe('onEnterDark', (p) => {
    handlers.onAttacked?.({
      attacker: null,
      attackerLabel: 'the darkness',
      attackerKind: 'reflex',
      survivalKind: 'dark',
      phase: p.phase ?? 'night',
      count: 1,
    })
  })

  const onDeath = safe('onDeath', (p) => {
    const pos = typeof p.x === 'number' && typeof p.z === 'number' ? { x: p.x, y: 0, z: p.z } : null
    handlers.onDeath?.({ pos })
  })

  const onSpawned = safe('onSpawn', () => { handlers.onSpawn?.() })

  const onPhase = safe('onPhase', (p) => {
    handlers.onIdleNudge?.({ reason: 'phase_change', phase: p.phase ?? null, day: p.day ?? null })
  })

  const onPlayerJoined = safe('onPlayerJoined', (p) => {
    handlers.onPlayerJoined?.({ username: String(p.name ?? p.userid ?? 'player'), uuid: String(p.userid ?? '') })
  })
  const onPlayerLeft = safe('onPlayerLeft', (p) => {
    handlers.onPlayerLeft?.({ username: String(p.name ?? p.userid ?? 'player'), uuid: String(p.userid ?? '') })
  })

  link.on('chat', onChat)
  link.on('attacked', onAttacked)
  link.on('survival', onSurvival)
  link.on('enterdark', onEnterDark)
  link.on('death', onDeath)
  link.on('spawned', onSpawned)
  link.on('phase', onPhase)
  link.on('playerjoined', onPlayerJoined)
  link.on('playerleft', onPlayerLeft)

  return function dispose() {
    link.off('chat', onChat)
    link.off('attacked', onAttacked)
    link.off('survival', onSurvival)
    link.off('enterdark', onEnterDark)
    link.off('death', onDeath)
    link.off('spawned', onSpawned)
    link.off('phase', onPhase)
    link.off('playerjoined', onPlayerJoined)
    link.off('playerleft', onPlayerLeft)
  }
}
