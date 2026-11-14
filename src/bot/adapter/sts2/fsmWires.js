// src/bot/adapter/sts2/fsmWires.js: translate the game link's events into the
// brain's AdapterHandlers (src/bot/brain/types.js). Thin: no game logic, and
// never a move: a decision point only WAKES the brain, which picks the move.
//
//   actions/force  -> a system line "Your move ..." (P1), unless an act() is
//                     in flight (its result already hands the brain another
//                     turn with the new move in the snapshot)
//   force pending  -> "still your move" after nudgeMs while the brain is idle,
//                     at most maxNudges per decision point
//   sei/event      -> a system line for the moments worth a word (fight won,
//                     boss, run over, the player low); others are history only
//   sei/chat       -> onChat (the player typing in the game, Sei fork only)
//   host hello / allies -> onPlayerJoined for the player's name

import { yourMoveLine, eventLine } from './prompts.js'

/** Events that wake the brain; the rest only land in the snapshot's recent line. */
export const WAKE_EVENTS = new Set(['boss_start', 'elite_start', 'combat_won', 'run_won', 'run_lost', 'you_died', 'player_low', 'act_start'])

/**
 * @param {import('node:events').EventEmitter & { seat: any, host: any }} link
 * @param {import('../../brain/types.js').AdapterHandlers} handlers
 * @param {{ isActing: () => boolean, isPaused: () => boolean, stats?: any, logger?: object,
 *           nudgeMs?: number, maxNudges?: number, onRecent?: (line: string) => void,
 *           setTimer?: Function, clearTimer?: Function }} opts
 * @returns {() => void} dispose
 */
export function wireSts2Events(link, handlers, opts) {
  const {
    isActing, isPaused, stats = null, logger = console, nudgeMs = 25_000, maxNudges = 3, onRecent = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  } = opts
  const safe = (label, fn) => (...a) => {
    try { fn(...a) } catch (err) { logger.error?.(`[sei/sts2 wires] ${label} threw: ${err && err.message}`) }
  }
  const systemLine = (text, eventFact) => {
    handlers.onChat?.({
      username: 'sei',
      text: `[${text} This is a game event, not the player talking.]`,
      ...(eventFact ? { eventFact } : {}),
      playerSpoke: false,
      gameEvent: true,
      addressed: true,
      nearby: true,
    })
  }

  let nudgeTimer = null
  let nudgedFor = 0
  let nudges = 0
  const clearNudge = () => { if (nudgeTimer) clearTimer(nudgeTimer); nudgeTimer = null }
  const armNudge = (session) => {
    clearNudge()
    const f = session.force
    if (!f) return
    if (nudgedFor !== f.seq) { nudgedFor = f.seq; nudges = 0 }
    if (nudges >= maxNudges) return
    nudgeTimer = setTimer(safe('nudge', () => {
      nudgeTimer = null
      if (link.seat !== session || session.force?.seq !== f.seq) return
      if (isPaused()) return
      if (isActing()) { armNudge(session); return }
      nudges += 1
      stats?.nudge?.()
      systemLine(yourMoveLine(f.query, true), 'still waiting on her move')
      armNudge(session)
    }), nudgeMs)
  }

  const knownPlayers = new Set()
  const notePlayer = (name) => {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n || knownPlayers.has(n)) return
    knownPlayers.add(n)
    handlers.onPlayerJoined?.({ username: n, uuid: `sts2:${n}` })
  }

  let detachSeat = () => {}
  const attachSeat = (s) => {
    detachSeat()
    const onForce = safe('force', (f) => {
      stats?.force?.()
      if (isPaused()) return
      if (!isActing()) {
        stats?.wake?.()
        systemLine(yourMoveLine(f.query), 'her move in Slay the Spire 2')
      }
      armNudge(s)
    })
    const onCleared = safe('force-cleared', () => clearNudge())
    const onEvent = safe('event', (ev) => {
      stats?.event?.(ev.kind)
      const line = eventLine(ev.kind, ev.detail)
      if (!line) return
      onRecent(ev.kind.replace(/_/g, ' ') + (ev.detail ? ` (${String(ev.detail).slice(0, 60)})` : ''))
      if (WAKE_EVENTS.has(ev.kind) && !isPaused()) systemLine(line, ev.kind.replace(/_/g, ' '))
    })
    const onChat = safe('chat', (c) => {
      handlers.onChat?.({ username: c.from, text: c.text, playerSpoke: true, addressed: true, nearby: true })
    })
    const onState = safe('state', (st) => {
      stats?.state?.(st)
      for (const a of Array.isArray(st?.allies) ? st.allies : []) if (a?.is_player) notePlayer(a.name)
    })
    s.on('force', onForce)
    s.on('force-cleared', onCleared)
    s.on('event', onEvent)
    s.on('chat', onChat)
    s.on('state', onState)
    detachSeat = () => {
      clearNudge()
      s.off('force', onForce)
      s.off('force-cleared', onCleared)
      s.off('event', onEvent)
      s.off('chat', onChat)
      s.off('state', onState)
    }
    if (s.seiState) onState(s.seiState)
    if (s.force) onForce(s.force)
  }

  let detachHost = () => {}
  const attachHost = (h) => {
    detachHost()
    stats?.hostSeen?.()
    if (h.hello?.player) notePlayer(h.hello.player)
    const onChat = safe('host chat', (c) => {
      handlers.onChat?.({ username: c.from, text: c.text, playerSpoke: true, addressed: true, nearby: true })
    })
    h.on('chat', onChat)
    detachHost = () => h.off('chat', onChat)
  }

  const onSeat = safe('seat', (s) => attachSeat(s))
  const onHost = safe('host', (h) => attachHost(h))
  const onSeatLost = safe('seat-lost', () => { detachSeat(); detachSeat = () => {} })
  const onHostLost = safe('host-lost', () => { detachHost(); detachHost = () => {} })
  link.on('seat', onSeat)
  link.on('host', onHost)
  link.on('seat-lost', onSeatLost)
  link.on('host-lost', onHostLost)
  if (link.seat) attachSeat(link.seat)
  if (link.host) attachHost(link.host)

  return function dispose() {
    detachSeat()
    detachHost()
    link.off('seat', onSeat)
    link.off('host', onHost)
    link.off('seat-lost', onSeatLost)
    link.off('host-lost', onHostLost)
  }
}
