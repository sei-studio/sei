// src/bot/adapter/dontstarve/protocol.js — the mod <-> runtime wire shapes
// on the bot side (game-adapters M2, 260908). The contract is written in
// native/dst-mod/PROTOCOL.md; src/shared/dstIpc.ts carries the main-process
// half (heartbeat, summon offer, dst-listen). Pure: no Node, no I/O.
//
// Observation frames arrive DELTA-COMPRESSED from the mod (3 Hz, <= 8 KB):
// a `full` frame replaces everything; a delta carries only entities that
// appeared/moved/changed flags plus `gone` guids. Entity positions on the
// wire are RELATIVE to the body (dx, dz) so the mod can round to one
// decimal; we store them ABSOLUTE (self.x + dx) so an entity the delta did
// not re-send keeps a correct position after the body walks away.

/** The runtime holds an empty /cmd response this long (bounded long-poll). */
export const CMD_HOLD_MS = 400
/** No mod traffic for this long after spawn = the world is gone. */
export const HEARTBEAT_LOSS_MS = 10_000
/** Default per-command wait before the adapter gives up on a result. */
export const CMD_RESULT_TIMEOUT_MS = 95_000
/** Perception radius the mod scans (mirrors perception.lua RADIUS). */
export const PERCEPTION_RADIUS = 24

/** Event kinds the mod POSTs to /event. */
export const EVENT_KINDS = Object.freeze([
  'chat', 'attacked', 'death', 'enterdark', 'enterlight', 'actionfailed', 'phase',
  'survival', 'spawned', 'spawnfailed', 'despawned', 'result',
])

/** Command kinds the mod dispatches (commands.lua dispatch). */
export const COMMAND_KINDS = Object.freeze([
  'say', 'stop', 'despawn', 'fight', 'follow', 'unfollow', 'equip', 'drop', 'goto',
  'attack', 'flee', 'action', 'gather', 'build', 'container', 'lightfire', 'resync',
])

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v, d = '') => (typeof v === 'string' ? v : d)
const flags = (v) => (Array.isArray(v) ? v.filter((f) => typeof f === 'string') : [])

/**
 * Mutable observation state fed by /obs frames. Everything the snapshot,
 * telemetry and target resolution read comes from here.
 */
export function createObservationState() {
  const state = {
    seq: 0,
    hasFull: false,
    lastAt: 0,
    self: null,     // normalized self block (see normalizeSelf)
    world: null,    // { day, phase, season, raining, snowing, temp, caves }
    ents: new Map(), // guid -> { guid, prefab, x, z, flags, name?, qty?, hp? }
    truncated: false,
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null
    return {
      guid: num(raw.g, 0),
      prefab: str(raw.p, '?'),
      qty: Math.max(1, Math.round(num(raw.q, 1))),
      flags: flags(raw.f),
      spoil: typeof raw.s === 'number' ? raw.s : null,
    }
  }

  function normalizeSelf(raw) {
    if (!raw || typeof raw !== 'object') return null
    const inv = Array.isArray(raw.inv) ? raw.inv.map(normalizeItem).filter(Boolean) : []
    const equip = {}
    if (raw.equip && typeof raw.equip === 'object') {
      for (const [slot, it] of Object.entries(raw.equip)) {
        const n = normalizeItem(it)
        if (n) equip[slot] = n
      }
    }
    return {
      x: num(raw.x), z: num(raw.z),
      hp: num(raw.hp), hpMax: num(raw.hpmax),
      hunger: num(raw.hunger), hungerMax: num(raw.hungermax),
      sanity: num(raw.sanity), sanityMax: num(raw.sanitymax),
      temp: num(raw.temp), moist: num(raw.moist),
      freezing: raw.freezing === true, overheating: raw.overheating === true,
      inLight: raw.inlight === true, busy: raw.busy === true, dead: raw.dead === true,
      target: typeof raw.target === 'number' ? raw.target : null,
      follow: typeof raw.follow === 'number' ? raw.follow : null,
      cmd: typeof raw.cmd === 'string' ? raw.cmd : null,
      inv, equip,
    }
  }

  function normalizeWorld(raw) {
    if (!raw || typeof raw !== 'object') return state.world
    return {
      day: Math.max(1, Math.round(num(raw.day, 1))),
      phase: str(raw.phase, 'day'),
      season: str(raw.season, ''),
      raining: raw.raining === true,
      snowing: raw.snowing === true,
      temp: num(raw.temp),
      caves: raw.caves === true,
    }
  }

  /**
   * Apply one /obs frame. Returns false when the frame is unusable.
   * @param {any} frame
   * @param {number} [now]
   */
  function apply(frame, now = Date.now()) {
    if (!frame || typeof frame !== 'object') return false
    const self = normalizeSelf(frame.self)
    if (!self) return false
    const full = frame.full === true
    if (full) state.ents.clear()
    if (Array.isArray(frame.ents)) {
      for (const raw of frame.ents) {
        if (!raw || typeof raw !== 'object') continue
        const guid = num(raw.g, NaN)
        if (!Number.isFinite(guid)) continue
        const prev = state.ents.get(guid)
        state.ents.set(guid, {
          guid,
          prefab: str(raw.p, prev?.prefab ?? '?'),
          x: self.x + num(raw.x),
          z: self.z + num(raw.z),
          flags: flags(raw.f),
          name: typeof raw.n === 'string' ? raw.n : (prev?.name ?? null),
          qty: typeof raw.q === 'number' ? raw.q : (prev?.qty ?? null),
          hp: typeof raw.h === 'number' ? raw.h : (prev?.hp ?? null),
          seenAt: now,
        })
      }
    }
    if (Array.isArray(frame.gone)) {
      for (const g of frame.gone) state.ents.delete(num(g, NaN))
    }
    state.self = self
    state.world = normalizeWorld(frame.world)
    state.seq = num(frame.seq, state.seq + 1)
    state.hasFull = state.hasFull || full
    state.lastAt = now
    state.truncated = frame.truncated === true
    return true
  }

  /** Distance from the body to an entity (XZ plane). */
  function distTo(ent) {
    if (!state.self || !ent) return Infinity
    const dx = ent.x - state.self.x
    const dz = ent.z - state.self.z
    return Math.sqrt(dx * dx + dz * dz)
  }

  /** Entities sorted by distance, optional filter. */
  function nearby(filter = null) {
    const out = []
    for (const e of state.ents.values()) {
      if (filter && !filter(e)) continue
      out.push(e)
    }
    return out.sort((a, b) => distTo(a) - distTo(b))
  }

  /** Inventory items matching a loose name (prefab equality, then substring). */
  function findInventory(name) {
    const inv = state.self?.inv ?? []
    const want = normalizeName(name)
    if (!want) return null
    return inv.find((i) => i.prefab === want)
      ?? inv.find((i) => i.prefab.includes(want) || want.includes(i.prefab))
      ?? null
  }

  return {
    get seq() { return state.seq },
    get hasFull() { return state.hasFull },
    get lastAt() { return state.lastAt },
    get self() { return state.self },
    get world() { return state.world },
    get ents() { return state.ents },
    get truncated() { return state.truncated },
    apply, distTo, nearby, findInventory,
    reset() {
      state.ents.clear()
      state.self = null
      state.world = null
      state.hasFull = false
      state.seq = 0
    },
  }
}

/** "Science Machine" / "science_machine" / "oak log" -> a prefab-ish token. */
export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
}

/**
 * Stable `#N` handles for entity guids across a session so the model can
 * refer back to something it saw two turns ago.
 */
export function createHandleRegistry() {
  const byGuid = new Map()
  const byHandle = new Map()
  let next = 1
  return {
    handleFor(guid) {
      let h = byGuid.get(guid)
      if (!h) {
        h = `#${next++}`
        byGuid.set(guid, h)
        byHandle.set(h, guid)
      }
      return h
    },
    guidFor(handle) {
      const m = /^#?(\d+)$/.exec(String(handle ?? '').trim())
      if (!m) return null
      return byHandle.get(`#${m[1]}`) ?? null
    },
    isHandle(v) { return /^#\d+$/.test(String(v ?? '').trim()) },
  }
}
