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
//
// Helper mod 0.3.0+ (opts.hasCaps) runs survival HABITS (light, fuel, gear,
// heal, smart eating, defending the player) that report every act as a
// survival event. Those are routine and do not wake the brain; they land in
// the snapshot's your_habits line (observers/habits.js). What still wakes it:
//   survival retreat -> reflex critical_retreat (health low near hostiles)
//   survival defend  -> attackerKind 'defend' (P1): a monster went for the
//                       player and the body took it on
//   survival dark    -> reflex dark, ONLY when opts.darkNeedsBrain() says the
//                       habits have nothing to make light with
//   enterdark        -> nothing (the light watcher lags nightfall by seconds
//                       and the habit is already on it)
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
 * @param {{ botName: string, companions: () => string[], playerName?: string|null,
 *   hasCaps?: () => boolean, darkNeedsBrain?: () => boolean }} opts
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

  const hasCaps = () => opts?.hasCaps?.() === true

  const onSurvival = safe('onSurvival', (p) => {
    const what = String(p.what ?? 'retreat')
    if (hasCaps()) {
      if (what === 'defend') {
        handlers.onAttacked?.({
          attacker: null,
          attackerLabel: String(p.threat ?? 'a monster'),
          attackerKind: 'defend',
          survivalKind: 'defend',
          player: p.player ? String(p.player) : null,
          count: 1,
        })
        return
      }
      if (what === 'dark') {
        if (opts?.darkNeedsBrain && !opts.darkNeedsBrain()) return
      } else if (what !== 'retreat') {
        return // a habit (light, fuel, equip, heal, ate): shown in your_habits
      }
    }
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
    if (hasCaps()) return
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
