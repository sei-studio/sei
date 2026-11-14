// src/bot/adapter/sts2/link.js: the Neuro SDK protocol session between the bot
// and the Slay the Spire 2 mod (native/sts2-mod/PROTOCOL.md). The bot is the
// Neuro side (the WebSocket SERVER); the mod (a fork of VedalAI/neuro-sts2,
// MIT) is the game side and connects out. Sei's additions are vendor-prefixed
// `sei/*` commands, which the spec says an unaware peer silently ignores, so
// the link also works with the unmodified upstream mod (text state only).
//
// Roles. A `seat` connection is the companion's own game window: it registers
// actions, forces decisions and executes what the bot picks. A `host`
// connection is the player's window (Sei fork only): it reports the run for
// conversation and opens the local co-op lobby on request; it never gets
// actions. Upstream neuro-sts2 never says its role, so it counts as a seat.

import { EventEmitter } from 'node:events'

export const GAME_NAME = 'Slay the Spire 2'
/** The `sei/hello` protocol this side speaks (native/sts2-mod/PROTOCOL.md). */
export const SEI_PROTOCOL = 1
/** The spec gives the game ~20s to answer an action before Neuro gives up. */
export const ACTION_RESULT_TIMEOUT_MS = 20_000
export const MAX_CONTEXTS = 12

function parse(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return null }
  if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') return null
  return msg
}

/** A registered action as the spec defines it; junk entries are dropped. */
export function normalizeAction(a) {
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name.trim()) return null
  const schema = a.schema && typeof a.schema === 'object' && a.schema.type === 'object' ? a.schema : null
  return {
    name: a.name.trim().slice(0, 80),
    description: typeof a.description === 'string' ? a.description.slice(0, 600) : '',
    schema,
  }
}

/**
 * One game connection (seat or host).
 * Emits: 'startup', 'hello', 'context' {message, silent}, 'actions' (Map),
 * 'force' (force), 'force-cleared', 'state' (seiState), 'event' {kind, ...},
 * 'chat' {from, text}, 'close'.
 */
export class GameSession extends EventEmitter {
  constructor(conn, { logger = console, now = () => Date.now() } = {}) {
    super()
    this.conn = conn
    this.logger = logger
    this.now = now
    this.role = 'seat'
    this.hello = null
    this.started = false
    /** @type {Map<string, {name:string, description:string, schema:object|null}>} */
    this.actions = new Map()
    this.force = null
    this.seiState = null
    this.contexts = []
    this.lastMessageAt = now()
    this._seq = 0
    this._forceSeq = 0
    this._pending = new Map()
    conn.on('message', (t) => this._onMessage(t))
    conn.on('close', () => this._onClose())
  }

  get open() { return this.conn.open !== false }

  send(command, data) {
    const msg = data === undefined ? { command } : { command, data }
    return this.conn.send(JSON.stringify(msg))
  }

  _onMessage(text) {
    this.lastMessageAt = this.now()
    const msg = parse(text)
    if (!msg) return
    const d = msg.data && typeof msg.data === 'object' ? msg.data : {}
    switch (msg.command) {
      case 'startup': {
        // Clears every action this game registered (spec: Startup).
        this.started = true
        this.game = typeof msg.game === 'string' ? msg.game : null
        this.actions.clear()
        this._clearForce()
        this.emit('startup', { game: this.game })
        break
      }
      case 'sei/hello': {
        this.hello = {
          mod: typeof d.mod === 'string' ? d.mod : 'unknown',
          version: typeof d.version === 'string' ? d.version : null,
          protocol: Number(d.protocol) || 0,
          role: d.role === 'host' ? 'host' : 'seat',
          player: typeof d.player === 'string' ? d.player.slice(0, 64) : null,
          gameVersion: typeof d.game_version === 'string' ? d.game_version.slice(0, 32) : null,
          coop: d.coop === true,
        }
        this.role = this.hello.role
        this.emit('hello', this.hello)
        break
      }
      case 'context': {
        const message = typeof d.message === 'string' ? d.message.trim() : ''
        if (!message) break
        const c = { message: message.slice(0, 4000), silent: d.silent === true, at: this.now() }
        this.contexts.push(c)
        if (this.contexts.length > MAX_CONTEXTS) this.contexts.splice(0, this.contexts.length - MAX_CONTEXTS)
        this.emit('context', c)
        break
      }
      case 'actions/register': {
        for (const raw of Array.isArray(d.actions) ? d.actions : []) {
          const a = normalizeAction(raw)
          if (a) this.actions.set(a.name, a)
        }
        this.emit('actions', this.actions)
        break
      }
      case 'actions/unregister': {
        for (const n of Array.isArray(d.action_names) ? d.action_names : []) this.actions.delete(String(n))
        if (this.force && !this.force.actionNames.some((n) => this.actions.has(n))) this._clearForce()
        this.emit('actions', this.actions)
        break
      }
      case 'actions/force': {
        const names = (Array.isArray(d.action_names) ? d.action_names : []).map(String).filter(Boolean)
        if (d.sei_state && typeof d.sei_state === 'object') this._setState(d.sei_state)
        this.force = {
          seq: ++this._forceSeq,
          state: typeof d.state === 'string' ? d.state : null,
          query: typeof d.query === 'string' ? d.query.slice(0, 2000) : '',
          ephemeral: d.ephemeral_context === true,
          priority: ['low', 'medium', 'high', 'critical'].includes(d.priority) ? d.priority : 'low',
          silent: d.silent === true,
          actionNames: names,
          at: this.now(),
        }
        this.emit('force', this.force)
        break
      }
      case 'action/result': {
        const id = String(d.id ?? '')
        const p = this._pending.get(id)
        if (!p) break
        this._pending.delete(id)
        clearTimeout(p.timer)
        const success = d.success === true
        // A move that went through ends its decision point. A failed one
        // leaves the force standing: in the Neuro protocol the SERVER retries
        // a force after a failure, the game does not send it again.
        if (success && this.force && this.force === p.force) this._clearForce()
        p.resolve({ success, message: typeof d.message === 'string' ? d.message.slice(0, 2000) : '' })
        break
      }
      case 'sei/state': {
        if (d.state && typeof d.state === 'object') this._setState(d.state)
        break
      }
      case 'sei/event': {
        if (typeof d.kind === 'string' && d.kind) this.emit('event', { ...d, kind: d.kind.slice(0, 40) })
        break
      }
      case 'sei/chat': {
        const text = typeof d.text === 'string' ? d.text.trim() : ''
        if (text) this.emit('chat', { from: typeof d.from === 'string' ? d.from.slice(0, 64) : 'someone', text: text.slice(0, 500) })
        break
      }
      default:
        // speech/started etc.: not used by StS2; unknown commands are ignored (spec).
        break
    }
  }

  _setState(s) {
    this.seiState = s
    this.emit('state', s)
  }

  _clearForce() {
    if (!this.force) return
    this.force = null
    this.emit('force-cleared')
  }

  /**
   * Send one action and wait for the game's action/result.
   * A successful move clears the force it answered; a failed one keeps it.
   * @returns {Promise<{success: boolean, message: string}>}
   */
  sendAction(name, data, { timeoutMs = ACTION_RESULT_TIMEOUT_MS, signal = null } = {}) {
    if (!this.open) return Promise.reject(new Error('the game link is closed'))
    const id = `sei-${this.now().toString(36)}-${++this._seq}`
    const payload = { id, name }
    if (data && typeof data === 'object' && Object.keys(data).length) payload.data = JSON.stringify(data)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error('the game did not answer the action in time'))
      }, timeoutMs)
      this._pending.set(id, { resolve, reject, timer, force: this.force })
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); this._pending.delete(id); reject(new Error('aborted')); return }
        signal.addEventListener('abort', () => {
          // The game may still run it; only the wait is dropped.
          if (this._pending.delete(id)) { clearTimeout(timer); reject(new Error('aborted')) }
        }, { once: true })
      }
      if (!this.send('action', payload)) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(new Error('the game link is closed'))
      }
    })
  }

  close(code = 1000, reason = '') { try { this.conn.close(code, reason) } catch {} }

  _onClose() {
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('the game link closed')) }
    this._pending.clear()
    this.emit('close')
  }
}

/**
 * The bot's link: accepts game connections from a WsServer and keeps the
 * current seat and host session. Emits 'seat' (GameSession) when a seat says
 * startup, 'host' (GameSession) on a host hello, 'seat-lost', 'host-lost'.
 */
export function createSts2Link({ server, logger = console, now = () => Date.now() }) {
  const link = new EventEmitter()
  link.seat = null
  link.host = null

  server.on('connection', (conn) => {
    const s = new GameSession(conn, { logger, now })
    let placed = false
    const place = () => {
      if (placed) return
      placed = true
      if (s.role === 'host') {
        if (link.host && link.host !== s) link.host.close(4000, 'replaced')
        link.host = s
        link.emit('host', s)
      } else {
        if (link.seat && link.seat !== s && link.seat.open) {
          // One seat per companion: the newest window wins (a restarted game).
          logger.info?.('[sei/sts2] a new companion window connected; replacing the old link')
          link.seat.close(4000, 'replaced')
        }
        link.seat = s
        link.emit('seat', s)
      }
    }
    // The Sei fork says hello right after startup; upstream never does, so a
    // startup with no hello within a moment is placed as a seat.
    let helloTimer = null
    s.on('hello', () => { clearTimeout(helloTimer); place() })
    s.on('startup', () => {
      try { s.send('startup', { session: { sessionId: `sei-${now().toString(36)}`, characterId: 'sei', displayName: link.displayName ?? 'Sei' } }) } catch {}
      if (s.hello) { place(); return }
      clearTimeout(helloTimer)
      helloTimer = setTimeout(place, 400)
    })
    s.on('close', () => {
      clearTimeout(helloTimer)
      if (link.seat === s) { link.seat = null; link.emit('seat-lost', s) }
      if (link.host === s) { link.host = null; link.emit('host-lost', s) }
    })
  })
  return link
}
