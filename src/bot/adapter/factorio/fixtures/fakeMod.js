// Test double: an in-memory dgram whose "game port" is a scripted stand-in
// for the sei-companion mod. Used by client.test.js and runtime.test.js.

import { EventEmitter } from 'node:events'
import { frames, parseFrame } from '../client.js'

/**
 * @param {{ handle: (req: object, meta: { id: string, n: number }) => object|null|undefined }} opts
 *   `handle` returns the reply object, or null to drop this datagram (the
 *   client resends). `n` counts how often this id has been seen.
 */
export function createFakeMod({ handle }) {
  const seen = new Map()
  const sockets = []
  let refusing = false
  const fake = {
    sent: [],
    sockets,
    /** Make the port look closed: every send gets an ECONNREFUSED. */
    refuse(on = true) { refusing = on },
    dgram: {
      createSocket() {
        const s = new EventEmitter()
        s.bind = (_port, _host, cb) => { setImmediate(cb) }
        s.connect = (_port, _host, cb) => { setImmediate(cb) }
        s.address = () => ({ port: 50001 })
        s.close = () => { s.closed = true }
        s.send = (buf) => {
          if (s.closed) return
          if (refusing) {
            setImmediate(() => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))
            return
          }
          const f = parseFrame(buf)
          if (!f) return
          const req = JSON.parse(f.body.toString('utf8'))
          const n = (seen.get(f.id) ?? 0) + 1
          seen.set(f.id, n)
          fake.sent.push(req)
          const reply = handle(req, { id: f.id, n })
          if (reply == null) return
          setImmediate(() => {
            for (const dg of frames(f.id, JSON.stringify(reply))) s.emit('message', dg)
          })
        }
        sockets.push(s)
        return s
      },
    },
  }
  return fake
}

/** A scripted mod with a feed: hello, spawn, poll, observe, cmd, cancel, pause, despawn. */
export function createScriptedMod({ world = '424242-0', protocol = 1, obs = { name: 'Sui', health: 100, at: [0, 0], inv: { items: [] }, owner: { name: 'Tester', dist: 3, dir: 'north', at: [0, 3] } } } = {}) {
  const state = {
    world,
    protocol,
    obs,
    feed: [],
    seq: 0,
    spawned: false,
    silent: false,
    jobs: new Map(),
    cmds: [],
    /** verb -> { done: {success,msg} } | { job: true } */
    verbs: {},
    pushed(ev) { state.seq += 1; state.feed.push({ ...ev, seq: state.seq }) },
    finish(id, ok, detail) { state.pushed({ t: 'result', id, ok, detail }) },
  }
  const fake = createFakeMod({
    handle(req, { id }) {
      if (state.silent) return null
      switch (req.op) {
        case 'hello':
          return { ok: true, mod: '0.1.0', game: '2.1.24', protocol: state.protocol, tick: 1, players: [{ i: 1, name: 'Tester' }], multiplayer: false, world: state.world, seed: 424242 }
        case 'spawn':
          state.spawned = true
          return { ok: true, cid: '1:sui', fresh: true, seq: state.seq, owner: 'Tester', at: [0, 0] }
        case 'poll':
          if (!state.spawned) return { ok: false, error: 'no companion 1:sui (spawn first)' }
          return { ok: true, seq: state.seq, ev: state.feed.filter((e) => e.seq > (req.since ?? 0)), alive: true }
        case 'observe':
          return { ok: true, obs: state.obs }
        case 'cmd': {
          state.cmds.push(req)
          const v = state.verbs[req.verb] ?? { done: { success: true, msg: `${req.verb} done` } }
          if (v.job) { state.jobs.set(id, req); return { ok: true, started: true, id } }
          return { ok: true, done: true, success: v.done.success, msg: v.done.msg }
        }
        case 'cancel':
          for (const [jid] of state.jobs) state.finish(jid, false, req.reason ?? 'cancelled')
          state.jobs.clear()
          return { ok: true, cancelled: true }
        case 'pause':
          return { ok: true, paused: !!req.paused }
        case 'despawn':
          state.spawned = false
          return { ok: true }
        default:
          return { ok: false, error: `unknown op ${req.op}` }
      }
    },
  })
  return { fake, state }
}
