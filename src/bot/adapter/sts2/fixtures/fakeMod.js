// src/bot/adapter/sts2/fixtures/fakeMod.js: a fake Slay the Spire 2 mod for
// tests and the headless harness. It connects to the bot's link like the real
// mod (a WebSocket client speaking the Neuro SDK protocol + sei/*) and plays
// the synthetic run in scenario.js: every decision point is registered and
// forced, every action the bot sends is checked and applied by the scenario's
// rules, and a simulated player ends their turns in the co-op fights.
//
// `structured: false` behaves like the unmodified upstream neuro-sts2 mod
// (no sei/hello, markdown state only).

import { createScenario } from './scenario.js'

export const GAME = 'Slay the Spire 2'

/**
 * @param {{ url: string, role?: 'seat'|'host', structured?: boolean, coop?: boolean, seed?: number,
 *           playerName?: string, playerDelayMs?: number, settleMs?: number, protocol?: number,
 *           scenario?: ReturnType<typeof createScenario>, WebSocketImpl?: any, log?: (m: string) => void }} opts
 */
export function createFakeMod(opts) {
  const {
    url, role = 'seat', structured = true, coop = true, seed = 7, playerName = 'Tester',
    playerDelayMs = 200, settleMs = 20, protocol = 1, log = () => {},
    WebSocketImpl = globalThis.WebSocket,
  } = opts
  const scenario = opts.scenario ?? createScenario({ seed, coop, playerName, structured })
  const received = []
  const said = []
  let ws = null
  let registered = []
  let pending = null
  let playerTimer = null
  let closed = false
  let paused = false
  let onBye = null

  const send = (command, data) => {
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify(data === undefined ? { command, game: GAME } : { command, game: GAME, data }))
  }

  function flushEvents() {
    for (const ev of scenario.takeEvents()) send('sei/event', ev)
  }

  function publish() {
    pending = null
    if (closed || role !== 'seat') return
    flushEvents()
    if (registered.length) { send('actions/unregister', { action_names: registered }); registered = [] }
    const d = scenario.decision()
    if (structured) send('sei/state', { state: scenario.seiState() })
    if (!d) {
      // Waiting on the simulated player (co-op fight) or the run is over.
      if (scenario.phase === 'combat' && !playerTimer) {
        playerTimer = setTimeout(() => { playerTimer = null; scenario.playerActs(); publish() }, playerDelayMs)
      }
      return
    }
    registered = d.actions.map((a) => a.name)
    send('actions/register', { actions: d.actions })
    const force = { state: scenario.stateText(), query: d.query, ephemeral_context: false, priority: 'low', action_names: registered }
    if (structured) force.sei_state = scenario.seiState()
    send('actions/force', force)
    // In a co-op fight the player plays at the same time as the companion.
    if (scenario.phase === 'combat' && scenario.player && !scenario.player.ended_turn && !playerTimer) {
      const round = scenario.round
      playerTimer = setTimeout(() => {
        playerTimer = null
        scenario.playerActs()
        // The open decision point still stands only inside the same round of the same fight.
        const same = scenario.phase === 'combat' && scenario.round === round && scenario.decision() != null
        if (!same) publish()
        else { flushEvents(); if (structured) send('sei/state', { state: scenario.seiState() }) }
      }, playerDelayMs * 10)
    }
  }

  function schedule() {
    if (pending) return
    pending = setTimeout(publish, settleMs)
  }

  function onMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    received.push(msg)
    const d = msg.data ?? {}
    if (msg.command === 'action') {
      let data = {}
      try { data = d.data ? JSON.parse(d.data) : {} } catch { send('action/result', { id: d.id, success: false, message: 'Invalid JSON' }); return }
      const r = scenario.apply(d.name, data)
      log(`[fake mod] ${d.name} ${JSON.stringify(data)} -> ${r.success ? 'ok' : 'fail'} ${r.message}`)
      send('action/result', { id: d.id, success: r.success, message: r.message })
      if (r.success) schedule()
    } else if (msg.command === 'sei/say') {
      said.push(String(d.text ?? ''))
    } else if (msg.command === 'sei/pause') {
      paused = d.paused === true
    } else if (msg.command === 'sei/bye') {
      onBye?.()
    }
  }

  return {
    scenario,
    received,
    said,
    get paused() { return paused },
    get open() { return !!ws && ws.readyState === 1 },
    onBye(fn) { onBye = fn },
    connect() {
      return new Promise((resolve, reject) => {
        ws = new WebSocketImpl(url)
        ws.addEventListener('open', () => {
          send('startup')
          if (structured) send('sei/hello', { mod: 'sei-sts2', version: '0.1.0-test', protocol, role, player: role === 'host' ? playerName : undefined, coop })
          if (role === 'seat') schedule()
          resolve()
        })
        ws.addEventListener('message', (ev) => onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)))
        ws.addEventListener('error', (err) => reject(err))
        ws.addEventListener('close', () => { closed = true })
      })
    },
    /** The player typing in the game (Sei fork host role). */
    chat(text, from = playerName) { send('sei/chat', { from, text }) },
    close() {
      closed = true
      clearTimeout(pending)
      clearTimeout(playerTimer)
      try { ws?.close() } catch {}
    },
  }
}
