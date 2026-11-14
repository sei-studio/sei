// End to end: the real runtime + link + adapter against the fake mod over a
// real localhost WebSocket. The "brain" here is a test policy (it stands in
// for the LLM): it wakes on the adapter's system lines and moves through the
// one `act` tool, exactly the surface the real brain sees.
import { describe, it, expect, afterEach } from 'vitest'
import { createRuntime } from './runtime.js'
import { createWsServer } from './wsServer.js'
import { createFakeMod } from './fixtures/fakeMod.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const cleanups = []
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()() } catch {} } })

const until = async (pred, ms = 8000, step = 10) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, step)) }
  return pred()
}

/** A test move policy: always a legal-looking move from what the snapshot shows. */
function pickMove(seat) {
  const f = seat.force
  if (!f) return null
  const names = f.actionNames
  const st = seat.seiState
  if (names.includes('embark')) return { action: 'embark' }
  if (names.includes('select_character')) return { action: 'select_character', args: { character_index: 0 } }
  if (names.includes('select_map_node')) return { action: 'select_map_node', args: {} }
  if (names.includes('select_card')) return { action: 'select_card', args: { card_index: 0 } }
  if (names.includes('select_event_option')) return { action: 'select_event_option', args: { option_index: 0 } }
  if (names.includes('play_card')) {
    if (st) {
      const card = st.hand.find((c) => c.playable)
      const foe = st.enemies.find((e) => e.hp > 0)
      if (card) return { action: 'play_card', args: { card: card.name, ...(card.target === 'enemy' && foe ? { target: foe.name } : {}) } }
    } else {
      return { action: 'play_card', args: { card_index: 0, enemy_index: 0 } }
    }
  }
  return { action: 'end_turn' }
}

function makeBrain(adapter, { log }) {
  const brain = { paused: false, wakes: 0, results: [], pauses: [], chats: [], joined: [], stopped: false }
  let busy = false
  const turn = async () => {
    if (busy || brain.paused || brain.stopped) return
    busy = true
    try {
      for (let i = 0; i < 12 && !brain.paused && !brain.stopped; i++) {
        const seat = adapter.currentSeat()
        const mv = seat && pickMove(seat)
        if (!mv) break
        const r = await adapter.executeAction('act', mv)
        brain.results.push(`${mv.action}: ${r}`)
        log?.(`${mv.action} ${JSON.stringify(mv.args ?? {})} -> ${r}`)
        if (/no new move for you yet|^paused|^aborted/.test(r)) break
        if (/^failed/.test(r) && mv.action === 'play_card') {
          await adapter.executeAction('act', { action: 'end_turn' })
          break
        }
      }
    } finally { busy = false }
  }
  adapter.attach({
    onChat: (m) => {
      brain.chats.push(m)
      if (m.gameEvent) { brain.wakes += 1; setTimeout(turn, 0) }
    },
    onPlayerJoined: (p) => brain.joined.push(p.username),
    onSpawn: () => {},
  })
  brain.setGamePaused = (on) => { brain.paused = on; brain.pauses.push(on); if (!on) setTimeout(turn, 0) }
  brain.stop = async () => { brain.stopped = true; adapter.detach() }
  return brain
}

async function boot({ structured = true, coop = true, protocol = 1, seatGraceMs = 90_000, connectTimeoutMs = 4000, startMod = true, token = null } = {}) {
  let server = null
  const errors = []
  const posts = []
  const dash = []
  let brain = null
  const config = { adapter: { kind: 'sts2', sts2: { host: '127.0.0.1', port: 0, token, username: 'Sui', seat_grace_ms: seatGraceMs } }, llm: {} }
  const modRef = {}
  const createServer = async (o) => {
    server = await createWsServer(o)
    if (startMod) {
      const q = token ? `?token=${token}` : ''
      modRef.mod = createFakeMod({ url: `ws://127.0.0.1:${server.port}/sei-sts2${q}`, structured, coop, protocol, playerDelayMs: 15, settleMs: 5 })
      cleanups.push(() => modRef.mod.close())
      setTimeout(() => modRef.mod.connect().catch(() => {}), 10)
    }
    return server
  }
  const handlePromise = createRuntime(config, {
    logger: quiet,
    createServer,
    connectTimeoutMs,
    adapterOpts: { settleMs: 300, endTurnSettleMs: 50, nudgeMs: 400 },
    postPortMessage: (m) => posts.push(m),
    createBrain: async (adapter) => {
      brain = makeBrain(adapter, {})
      return brain
    },
    onBrainReady: () => {},
    onBrainLost: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    onError: (e) => errors.push(e),
    onDashboard: (d) => dash.push(d),
  })
  const handle = await handlePromise
  cleanups.push(() => handle.stop())
  return { handle, errors, posts, dash, get brain() { return brain }, get mod() { return modRef.mod }, get server() { return server }, config }
}

describe('sts2 runtime against the fake mod', () => {
  it('plays a co-op run to the end with structured state', async () => {
    const t = await boot()
    expect(t.errors).toEqual([])
    expect(t.config.llm.idle_fallback_ms).toBe(600_000)
    const sc = t.mod.scenario
    const done = await until(() => sc.phase === 'won' || sc.phase === 'lost', 20_000)
    if (!done) console.log(sc.phase, sc.run, t.brain.results.slice(-15), sc.log?.slice?.(-10))
    expect(done).toBe(true)
    expect(await until(() => t.brain.chats.some((c) => /^run (won|lost)$/.test(c.eventFact ?? '')))).toBe(true)
    expect(t.brain.wakes).toBeGreaterThan(3)
    expect(t.brain.joined).toContain('Tester')
    // Names were mapped to indexes and the game accepted real plays.
    const plays = t.mod.received.filter((m) => m.command === 'action' && m.data.name === 'play_card')
    expect(plays.length).toBeGreaterThan(2)
    expect(JSON.parse(plays[0].data.data)).toHaveProperty('card_index')
    await t.handle.stop()
    const last = t.posts.filter((p) => p.type === 'sts2-stats').pop()
    expect(last.stats.acts).toBeGreaterThan(5)
    expect(last.stats.structured_state).toBe(true)
    expect(last.stats.coop).toBe(true)
    expect(last.stats.by_family.play_card).toBeGreaterThan(0)
    expect(last.stats.run_end).toBe(sc.phase)
    expect(await until(() => t.mod.received.some((m) => m.command === 'sei/bye'), 1000)).toBe(true)
  }, 30_000)

  it('runs on the unmodified upstream mod (no hello, markdown only)', async () => {
    const t = await boot({ structured: false })
    expect(t.errors).toEqual([])
    const sc = t.mod.scenario
    const ok = await until(() => sc.run.floor >= 2 || sc.phase === 'won' || sc.phase === 'lost', 20_000)
    if (!ok) console.log(sc.phase, sc.run, t.brain.results.slice(-15), sc.log?.slice?.(-10), t.brain.chats.length)
    expect(ok).toBe(true)
    const snap = t.handle.adapter.createSnapshotComposer().next()
    expect(typeof snap === 'string' ? snap : JSON.stringify(snap)).toBeTruthy()
  }, 30_000)

  it('speech and pause reach the game window', async () => {
    const t = await boot()
    await until(() => !!t.handle.link?.seat?.force)
    t.handle.adapter.chat('nice block!')
    t.handle.adapter.setWorldPaused(true)
    expect(await until(() => t.mod.said.includes('nice block!') && t.mod.paused)).toBe(true)
    expect(await t.handle.adapter.executeAction('act', { action: 'end_turn' })).toMatch(/^paused/)
  })

  it('ends with GAME_WORLD_NOT_OPEN when no window connects', async () => {
    const t = await boot({ startMod: false, connectTimeoutMs: 200 })
    expect(t.errors[0].error).toBe('GAME_WORLD_NOT_OPEN')
  })

  it('refuses a mod speaking another protocol', async () => {
    const t = await boot({ protocol: 99 })
    expect(t.errors[0].error).toBe('GAME_VERSION_UNSUPPORTED')
  })

  it('holds the brain while the window is gone and resumes on a new window', async () => {
    const t = await boot({ seatGraceMs: 3000 })
    await until(() => !!t.handle.link?.seat?.force)
    t.mod.close()
    expect(await until(() => t.brain.paused)).toBe(true)
    const mod2 = createFakeMod({ url: `ws://127.0.0.1:${t.server.port}/sei-sts2`, playerDelayMs: 15, settleMs: 5 })
    cleanups.push(() => mod2.close())
    await mod2.connect()
    expect(await until(() => !t.brain.paused)).toBe(true)
    expect(t.errors).toEqual([])
  })

  it('ends as world_closed after the grace', async () => {
    const t = await boot({ seatGraceMs: 150 })
    await until(() => !!t.handle.link?.seat?.force)
    t.mod.close()
    expect(await until(() => t.errors.length > 0)).toBe(true)
    expect(t.errors[0]).toMatchObject({ error: 'GAME_WORLD_NOT_OPEN', endReason: 'world_closed' })
  })

  it('nudges a pending move a bounded number of times', async () => {
    const t = await boot()
    await until(() => t.brain.wakes > 0)
    t.brain.paused = true // the stand-in brain stops answering, the adapter does not know
    const before = t.brain.chats.length
    await new Promise((r) => setTimeout(r, 2000))
    const nudges = t.brain.chats.slice(before).filter((c) => /still/i.test(c.text))
    expect(nudges.length).toBeGreaterThan(0)
    expect(nudges.length).toBeLessThanOrEqual(3)
  })
})
