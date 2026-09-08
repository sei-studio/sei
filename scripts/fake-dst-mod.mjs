#!/usr/bin/env node
// scripts/fake-dst-mod.mjs — a Node stand-in for native/dst-mod/sei that
// speaks native/dst-mod/PROTOCOL.md (game-adapters M2, 260908).
//
// Two roles, both usable as a library (the vitest suites import it) or from
// the command line (no Electron, no game):
//
//   heartbeat mode   node scripts/fake-dst-mod.mjs --hello-port 27424
//       GETs main's watcher /hello every 2 s like the real mod, prints the
//       summon offer when one arrives, and then switches to body mode against
//       the offered botPort/token.
//   body mode        node scripts/fake-dst-mod.mjs --bot-port 51234 --token abc
//       POSTs `spawned`, streams /obs at 3 Hz, long-polls /cmd, answers every
//       command with a canned result, and echoes chat typed on stdin as a
//       player line (`/attack`, `/death`, `/dark`, `/phase night` post events).
//
// The observation frames are synthetic but shaped exactly like
// perception.lua's: a full frame first, deltas after, guids stable.

import { createInterface } from 'node:readline'

const DEFAULT_ENTS = [
  { g: 1001, p: 'evergreen', x: 4.2, z: -1.1, f: ['chop'] },
  { g: 1002, p: 'evergreen', x: 7.9, z: 3.0, f: ['chop'] },
  { g: 1003, p: 'sapling', x: -2.5, z: 2.2, f: ['pick'] },
  { g: 1004, p: 'grass', x: -3.1, z: 4.0, f: ['pick'] },
  { g: 1005, p: 'rock1', x: 12.0, z: -6.5, f: ['mine'] },
  { g: 1006, p: 'flint', x: 1.5, z: 1.0, f: ['pickup'] },
  { g: 1007, p: 'berrybush', x: 6.0, z: 8.0, f: ['pick'] },
  { g: 1008, p: 'spider', x: 15.0, z: 9.0, f: ['hostile', 'monster', 'combat'], h: 1 },
  { g: 1009, p: 'campfire', x: 2.0, z: -3.0, f: ['fire', 'structure'] },
  { g: 1010, p: 'treasurechest', x: -4.0, z: -4.0, f: ['container', 'chest', 'structure'] },
  { g: 1011, p: 'researchlab', x: -6.0, z: 1.0, f: ['prototyper', 'structure'] },
]

export const DEFAULT_PLAYER = { g: 2001, p: 'wilson', x: 2.0, z: 0.5, f: ['player', 'combat'], n: 'Steve', h: 1 }

const now = () => Date.now()

/**
 * @param {object} opts
 * @param {number} opts.botPort
 * @param {string} opts.token
 * @param {string} [opts.prefab]
 * @param {string} [opts.name]
 * @param {number} [opts.obsHz]
 * @param {(cmd: object, mod: FakeDstMod) => ({ok:boolean, text:string}|null|Promise<any>)} [opts.onCommand]
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createFakeMod(opts) {
  const {
    botPort, token, prefab = 'wilson', name = 'Sui', obsHz = 3,
    onCommand = null, log = () => {}, fetchImpl = globalThis.fetch,
  } = opts
  if (!botPort || !token) throw new Error('createFakeMod: botPort and token required')
  const base = `http://127.0.0.1:${botPort}`
  const q = (path, extra = {}) => {
    const u = new URL(base + path)
    u.searchParams.set('t', token)
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v))
    return u.toString()
  }

  const self = {
    x: 10, z: -20, hp: 150, hpmax: 150, hunger: 120, hungermax: 150, sanity: 180, sanitymax: 200,
    temp: 22, moist: 0, freezing: false, overheating: false, inlight: true, busy: false, dead: false,
    target: null, follow: DEFAULT_PLAYER.g, cmd: null,
    inv: [
      { g: 3001, p: 'axe', q: 1, f: ['equip', 'tool'] },
      { g: 3002, p: 'log', q: 4, f: ['fuel'] },
      { g: 3003, p: 'berries', q: 3, f: ['eat'], s: 0.8 },
      { g: 3004, p: 'twigs', q: 2, f: ['fuel'] },
    ],
    equip: { hands: { g: 3001, p: 'axe', q: 1, f: ['equip', 'tool'] } },
  }
  const world = { day: 3, phase: 'day', season: 'autumn', raining: false, snowing: false, temp: 20, caves: false }
  const ents = new Map(DEFAULT_ENTS.map((e) => [e.g, { ...e, f: [...e.f] }]))
  ents.set(DEFAULT_PLAYER.g, { ...DEFAULT_PLAYER, f: [...DEFAULT_PLAYER.f] })

  const mod = {
    self, world, ents,
    received: [],
    obsSent: 0,
    since: 0,
    seq: 0,
    running: false,
    polling: true,
    observing: true,
    _timers: [],
    _pollAbort: null,
    lastPollHoldMs: null,
    async post(path, body) {
      const res = await fetchImpl(q(path), { method: 'POST', body: JSON.stringify(body) })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : {} } catch { json = null }
      return { ok: res.ok, status: res.status, json }
    },
    async event(kind, data = {}) {
      return mod.post('/event', { kind, t: now() / 1000, ...data })
    },
    frame(full) {
      const changed = []
      for (const e of ents.values()) changed.push({ g: e.g, p: e.p, x: e.x, z: e.z, f: e.f, ...(e.n ? { n: e.n } : {}), ...(e.q ? { q: e.q } : {}), ...(e.h != null ? { h: e.h } : {}) })
      mod.seq += 1
      return { seq: mod.seq, full: !!full, self: { ...self, inv: self.inv, equip: self.equip }, ents: full ? changed : [], gone: [], world }
    },
    async sendObs(full = false) {
      const f = mod.frame(full)
      mod.obsSent += 1
      const r = await mod.post('/obs', f)
      if (r.json?.full) mod._wantFull = true
      return r
    },
    async spawn() {
      return mod.event('spawned', { guid: 9001, prefab, name, x: self.x, z: self.z, session: 'SESSION-FAKE-1', world: 'Fake World', near: 'KU_fake' })
    },
    async despawned(reason = 'test') {
      return mod.event('despawned', { reason })
    },
    async chat(text, player = DEFAULT_PLAYER) {
      return mod.event('chat', { userid: 'KU_fake', name: player.n ?? 'Steve', prefab: player.p, text, whisper: false })
    },
    async result(id, ok, text) {
      return mod.event('result', { id, ok, text })
    },
    async pollOnce() {
      const t0 = now()
      const ctrl = new AbortController()
      mod._pollAbort = ctrl
      let res
      try {
        res = await fetchImpl(q('/cmd', { since: mod.since }), { signal: ctrl.signal })
      } finally {
        mod._pollAbort = null
      }
      mod.lastPollHoldMs = now() - t0
      if (!res.ok) return []
      const body = await res.json()
      const cmds = Array.isArray(body?.cmds) ? body.cmds : []
      for (const c of cmds) {
        if (typeof c.seq === 'number' && c.seq > mod.since) mod.since = c.seq
        mod.received.push(c)
        log(`cmd ${c.kind} ${JSON.stringify(c)}`)
        let r = null
        try { r = onCommand ? await onCommand(c, mod) : null } catch (err) { r = { ok: false, text: `error: ${err.message}` } }
        if (r === undefined || r === null) r = defaultResult(c, mod)
        if (r && r !== false) await mod.result(c.id, r.ok !== false, r.text ?? 'done')
      }
      return cmds
    },
    async start({ spawn = true } = {}) {
      mod.running = true
      if (spawn) await mod.spawn()
      await mod.sendObs(true)
      const obsTimer = setInterval(() => {
        if (!mod.running || !mod.observing) return
        mod.sendObs(mod._wantFull === true).then(() => { mod._wantFull = false }).catch(() => {})
      }, Math.round(1000 / obsHz))
      mod._timers.push(obsTimer)
      ;(async () => {
        while (mod.running) {
          if (!mod.polling) { await sleep(100); continue }
          try { await mod.pollOnce() } catch { await sleep(250) }
        }
      })()
      return mod
    },
    stop() {
      mod.running = false
      for (const t of mod._timers) clearInterval(t)
      mod._timers = []
      try { mod._pollAbort?.abort() } catch {}
    },
    /** Simulate the game freezing: no obs, no polls. */
    silence(on = true) {
      mod.observing = !on
      mod.polling = !on
      if (on) { try { mod._pollAbort?.abort() } catch {} }
    },
  }
  return mod
}

function defaultResult(c, mod) {
  switch (c.kind) {
    case 'say': return { ok: true, text: 'said' }
    case 'stop': return { ok: true, text: 'stopped' }
    case 'pause': return { ok: true, text: c.paused ? 'paused' : 'resumed' }
    case 'fight': return { ok: true, text: c.enabled ? 'will fight back when hit' : 'will not fight back' }
    case 'follow': return { ok: true, text: 'following Steve' }
    case 'unfollow': return { ok: true, text: 'stopped following' }
    case 'despawn':
      // The real mod answers, then removes the body and posts despawned.
      setTimeout(() => { mod.despawned('bot stop').catch(() => {}) }, 30)
      return { ok: true, text: 'despawning' }
    case 'goto': return { ok: true, text: 'arrived (1.8 away)' }
    case 'gather': {
      const it = mod.self.inv.find((i) => i.p === c.prefab)
      if (it) it.q += c.count ?? 1
      else mod.self.inv.push({ g: 3100 + mod.self.inv.length, p: c.prefab, q: c.count ?? 1, f: [] })
      return { ok: true, text: `gathered ${c.count ?? 1} ${c.prefab}` }
    }
    case 'action': return { ok: true, text: `${String(c.name).toLowerCase()} done` }
    case 'build': return { ok: true, text: `built ${c.recipe}` }
    case 'equip': return { ok: true, text: 'equipped axe' }
    case 'drop': return { ok: true, text: 'dropped' }
    case 'attack': return { ok: true, text: 'killed the target' }
    case 'flee': return { ok: true, text: 'running from danger' }
    case 'lightfire': return { ok: true, text: 'fed the campfire with log' }
    case 'container': return { ok: true, text: `${c.op === 'store' ? 'stored' : 'took'} ${c.count ?? 1} ${c.item}` }
    case 'resync': return { ok: true, text: 'ok' }
    default: return { ok: false, text: `unknown command ${c.kind}` }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Heartbeat against main's watcher /hello. Resolves with the first summon offer. */
export async function heartbeatUntilOffer({ helloPort, session = 'SESSION-FAKE-1', world = 'Fake World', intervalMs = 2000, maxTries = Infinity, fetchImpl = globalThis.fetch, log = () => {} }) {
  let tries = 0
  while (tries < maxTries) {
    tries += 1
    const body = {
      session, world, day: 3, season: 'autumn', phase: 'day',
      players: [{ userid: 'KU_fake', name: 'Steve', prefab: 'wilson' }],
      ismastersim: true, caves: false, mod: '0.1.0', build: 'fake',
    }
    const u = new URL(`http://127.0.0.1:${helloPort}/hello`)
    u.searchParams.set('q', JSON.stringify(body))
    try {
      const res = await fetchImpl(u.toString())
      const json = await res.json()
      log(`hello -> ${JSON.stringify(json)}`)
      if (json?.summon) return json.summon
    } catch (err) {
      log(`hello failed: ${err.message}`)
    }
    await sleep(intervalMs)
  }
  return null
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
  const log = (m) => console.log(`[fake-dst-mod] ${m}`)
  ;(async () => {
    let botPort = Number(arg('--bot-port', 0))
    let token = arg('--token', '')
    let prefab = 'wilson'
    let name = 'Sui'
    const helloPort = Number(arg('--hello-port', 0))
    if (helloPort) {
      log(`heartbeating to 127.0.0.1:${helloPort}/hello`)
      const offer = await heartbeatUntilOffer({ helloPort, log })
      botPort = offer.botPort
      token = offer.token
      prefab = offer.prefab
      name = offer.name
      log(`offer: spawn ${prefab} as ${name} -> bot ${botPort}`)
    }
    if (!botPort || !token) {
      console.error('usage: fake-dst-mod.mjs --hello-port 27424 | --bot-port N --token T')
      process.exit(2)
    }
    const mod = createFakeMod({ botPort, token, prefab, name, log })
    await mod.start()
    log('body up: type a chat line, or /attack /death /dark /phase night, Ctrl-C to quit')
    const rl = createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const l = line.trim()
      if (!l) return
      if (l === '/attack') void mod.event('attacked', { attacker: 1008, label: 'spider', isplayer: false, damage: 20, health: 130, healthpct: 0.86 })
      else if (l === '/death') void mod.event('death', { x: mod.self.x, z: mod.self.z })
      else if (l === '/dark') void mod.event('enterdark', { phase: 'night' })
      else if (l.startsWith('/phase ')) { mod.world.phase = l.slice(7); void mod.event('phase', { phase: mod.world.phase, day: mod.world.day }) }
      else void mod.chat(l)
    })
    process.on('SIGINT', () => { mod.stop(); process.exit(0) })
  })().catch((err) => { console.error(err); process.exit(1) })
}
