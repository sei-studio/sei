import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { GameSession, createSts2Link } from './link.js'
import { createSts2Adapter } from './index.js'
import { composeSnapshot } from './observers/snapshot.js'
import { wireSts2Events } from './fsmWires.js'
import { createSts2Stats, actionFamily, failureClass } from './stats.js'
import { eventAddendum } from './prompts.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** A connection double: records what the bot sends, lets the test speak as the game. */
function fakeConn() {
  const c = new EventEmitter()
  c.open = true
  c.sent = []
  c.send = (t) => { c.sent.push(JSON.parse(t)); return true }
  c.close = () => { c.open = false; c.emit('close') }
  c.game = (command, data) => c.emit('message', JSON.stringify({ command, game: 'Slay the Spire 2', data }))
  c.lastAction = () => [...c.sent].reverse().find((m) => m.command === 'action')
  return c
}

const PLAY = { name: 'play_card', description: 'Play a card', schema: { type: 'object', properties: { card_index: { type: 'integer' }, enemy_index: { type: 'integer' } }, required: ['card_index'] } }
const END = { name: 'end_turn', description: 'Ends your current turn' }
const STATE = {
  screen: 'combat', run: { act: 1, floor: 2 },
  me: { character: 'The Ironclad', hp: 70, max_hp: 80, energy: 3, max_energy: 3 },
  enemies: [{ name: 'Jaw Worm', hp: 40, max_hp: 44, intent: 'Attack 11' }],
  hand: [{ name: 'Strike', cost: 1, type: 'attack', target: 'enemy' }, { name: 'Defend', cost: 1, type: 'skill' }],
}

function forceCombat(conn, state = STATE) {
  conn.game('actions/register', { actions: [PLAY, END] })
  conn.game('actions/force', { state: '# combat', query: 'Your turn.', action_names: ['play_card', 'end_turn'], sei_state: state })
}

describe('GameSession', () => {
  it('keeps the force after a refused move and clears it after a good one', async () => {
    const conn = fakeConn()
    const s = new GameSession(conn, { logger: quiet })
    forceCombat(conn)
    const f = s.force
    expect(f.actionNames).toEqual(['play_card', 'end_turn'])
    expect(s.seiState.screen).toBe('combat')

    const p1 = s.sendAction('play_card', { card_index: 5 })
    conn.game('action/result', { id: conn.lastAction().data.id, success: false, message: 'Invalid card_index' })
    expect(await p1).toEqual({ success: false, message: 'Invalid card_index' })
    expect(s.force).toBe(f)

    const p2 = s.sendAction('play_card', { card_index: 0, enemy_index: 0 })
    expect(JSON.parse(conn.lastAction().data.data)).toEqual({ card_index: 0, enemy_index: 0 })
    conn.game('action/result', { id: conn.lastAction().data.id, success: true, message: 'Played Strike' })
    expect((await p2).success).toBe(true)
    expect(s.force).toBe(null)
  })

  it('drops pending waits when the link closes', async () => {
    const conn = fakeConn()
    const s = new GameSession(conn, { logger: quiet })
    const p = s.sendAction('end_turn', {})
    conn.close()
    await expect(p).rejects.toThrow(/closed/)
  })
})

describe('createSts2Link', () => {
  it('places an upstream mod as a seat after a beat and a host on hello', async () => {
    vi.useFakeTimers()
    try {
      const server = new EventEmitter()
      const link = createSts2Link({ server, logger: quiet })
      const seats = []
      link.on('seat', (s) => seats.push(s))
      const a = fakeConn()
      server.emit('connection', a)
      a.game('startup')
      expect(a.sent[0]).toMatchObject({ command: 'startup' })
      expect(seats).toHaveLength(0)
      vi.advanceTimersByTime(450)
      expect(seats).toHaveLength(1)

      const h = fakeConn()
      server.emit('connection', h)
      h.game('startup')
      h.game('sei/hello', { mod: 'sei-sts2', protocol: 1, role: 'host', player: 'Tester' })
      expect(link.host.hello.player).toBe('Tester')
      expect(link.seat).toBe(seats[0])

      // A restarted companion window replaces the old seat.
      const b = fakeConn()
      server.emit('connection', b)
      b.game('startup')
      b.game('sei/hello', { mod: 'sei-sts2', protocol: 1, role: 'seat' })
      expect(seats).toHaveLength(2)
      expect(a.open).toBe(false)
    } finally { vi.useRealTimers() }
  })
})

describe('adapter', () => {
  async function setup() {
    const server = new EventEmitter()
    const link = createSts2Link({ server, logger: quiet })
    const conn = fakeConn()
    server.emit('connection', conn)
    conn.game('startup')
    conn.game('sei/hello', { mod: 'sei-sts2', protocol: 1, role: 'seat', coop: true })
    const stats = createSts2Stats()
    const adapter = createSts2Adapter({ link, config: {}, botUsername: 'Sui', stats, logger: quiet, settleMs: 30, endTurnSettleMs: 10 })
    return { link, conn, adapter, stats }
  }

  it('exposes one stable tool and guards moves before sending', async () => {
    const { conn, adapter } = await setup()
    expect(adapter.listActions()).toEqual(['act'])
    forceCombat(conn)
    expect(await adapter.executeAction('act', { action: 'use_potion' })).toMatch(/^failed: use_potion is not available right now. Available: play_card\(card_index\*, enemy_index\), end_turn\(\)/)
    expect(await adapter.executeAction('act', { action: 'play_card', args: { card: 'Bash' } })).toMatch(/^failed: .*no Bash/)
    expect(conn.sent.filter((m) => m.command === 'action')).toHaveLength(0)
  })

  it('returns a refusal at once and reports the next decision point after a good move', async () => {
    const { conn, adapter, stats } = await setup()
    forceCombat(conn)
    conn.on('message', () => {})
    const origSend = conn.send
    conn.send = (t) => {
      origSend(t)
      const m = JSON.parse(t)
      if (m.command !== 'action') return true
      const data = JSON.parse(m.data.data ?? '{}')
      setTimeout(() => {
        if (data.card_index === 0) {
          conn.game('action/result', { id: m.data.id, success: true, message: 'Played Strike' })
          forceCombat(conn, { ...STATE, hand: [STATE.hand[1]] })
        } else {
          conn.game('action/result', { id: m.data.id, success: false, message: 'Not enough energy' })
        }
      }, 1)
      return true
    }
    expect(await adapter.executeAction('act', { action: 'play_card', args: { card: 'Defend' } })).toBe('failed: Not enough energy')
    expect(await adapter.executeAction('act', { action: 'play_card', args: { card: 'Strike', target: 'Jaw Worm' } })).toBe('Played Strike')
    const snap = stats.snapshot()
    expect(snap.acts).toBe(2)
    expect(snap.acts_ok).toBe(1)
    expect(Object.values(snap.failures).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('snapshot shows the state, the move asked for and its tools; quiet when nothing is asked', async () => {
    const { conn, adapter } = await setup()
    const composer = adapter.createSnapshotComposer()
    expect(composer.next()).toMatch(/no move needed/)
    forceCombat(conn)
    const text = composer.next({ lastActionResult: 'Played Strike' })
    expect(text).toContain('Jaw Worm')
    expect(text).toContain('YOUR MOVE:')
    expect(text).toContain('play_card(card_index*, enemy_index): Play a card')
    expect(text).toContain('last_action_result: Played Strike')
    expect(composeSnapshot({ seat: null })).toMatch(/not connected/)
  })

  it('words choice screens from the context that came with the force', () => {
    const actions = new Map([['choose_reward', { name: 'choose_reward', schema: { type: 'object', properties: { index: { type: 'integer' } } } }]])
    const force = { state: null, query: 'Pick a reward.', actionNames: ['choose_reward'], at: 100_000 }
    const contexts = [
      { message: 'Old shop screen', silent: false, at: 10_000 },
      { message: 'Rewards: [0] 25 gold [1] Card: Pommel Strike', silent: false, at: 99_990 },
    ]
    // Upstream mod: no structured state, no force.state.
    const up = composeSnapshot({ seat: { open: true, seiState: null, force, actions, contexts } })
    expect(up).toContain('Pommel Strike')
    expect(up).not.toContain('Old shop')
    expect(up).not.toContain('use card_index')
    const upFight = composeSnapshot({ seat: { open: true, seiState: null, force: { ...force, actionNames: ['play_card'] }, actions: new Map([['play_card', { name: 'play_card' }]]), contexts } })
    expect(upFight).toContain('use card_index and enemy_index numbers')
    // Sei mod out of combat with no options: the context adds the choices.
    const sei = composeSnapshot({ seat: { open: true, seiState: { screen: 'rewards', options: [], hand: [] }, force, actions, contexts } })
    expect(sei).toContain('screen: rewards')
    expect(sei).toContain('Pommel Strike')
    // In a fight the structured state is enough.
    const fight = composeSnapshot({ seat: { open: true, seiState: { screen: 'combat', hand: [{ name: 'Strike' }] }, force, actions, contexts } })
    expect(fight).not.toContain('Pommel Strike')
    // A context from an earlier screen is not shown.
    expect(composeSnapshot({ seat: { open: true, seiState: null, force, actions, contexts: contexts.slice(0, 1) } })).not.toContain('Old shop')
  })

  it('speech and pause go to the game windows', async () => {
    const { conn, adapter } = await setup()
    adapter.chat('  nice  ')
    adapter.setWorldPaused(true)
    expect(conn.sent.some((m) => m.command === 'sei/say' && m.data.text === 'nice')).toBe(true)
    expect(conn.sent.some((m) => m.command === 'sei/pause' && m.data.paused === true)).toBe(true)
    expect(await adapter.executeAction('act', { action: 'end_turn' })).toMatch(/^paused/)
  })
})

describe('wires', () => {
  it('wakes on a decision point unless acting or paused, and passes game chat as the player', () => {
    const server = new EventEmitter()
    const link = createSts2Link({ server, logger: quiet })
    const conn = fakeConn()
    server.emit('connection', conn)
    conn.game('startup')
    conn.game('sei/hello', { mod: 'sei-sts2', protocol: 1, role: 'seat' })
    const got = []
    let acting = false
    let paused = false
    const timers = []
    const dispose = wireSts2Events(link, { onChat: (m) => got.push(m), onPlayerJoined: (p) => got.push({ joined: p.username }) }, {
      isActing: () => acting, isPaused: () => paused, logger: quiet,
      setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {},
    })
    forceCombat(conn, { ...STATE, allies: [{ name: 'Tester', is_player: true, hp: 1, max_hp: 70 }] })
    expect(got.some((m) => m.joined === 'Tester')).toBe(true)
    expect(got.filter((m) => m.gameEvent)).toHaveLength(1)
    acting = true
    forceCombat(conn)
    expect(got.filter((m) => m.gameEvent)).toHaveLength(1)
    acting = false
    paused = true
    forceCombat(conn)
    expect(got.filter((m) => m.gameEvent)).toHaveLength(1)
    paused = false
    conn.game('sei/event', { kind: 'boss_start', detail: 'The Guardian' })
    conn.game('sei/event', { kind: 'card_played', detail: 'x' })
    expect(got.filter((m) => m.gameEvent)).toHaveLength(2)
    conn.game('sei/chat', { from: 'Tester', text: 'take the elite?' })
    expect(got.at(-1)).toMatchObject({ username: 'Tester', text: 'take the elite?', playerSpoke: true })
    dispose()
  })
})

describe('stats', () => {
  it('stays shape only', () => {
    const st = createSts2Stats()
    st.act('play_card', true)
    st.act('shop_buy', false, 'failed: Not enough gold')
    st.act('mystery_thing', false, 'failed: the game did not answer the action in time')
    st.state({ run: { floor: 7, act: 2 } })
    st.event('combat_won')
    const snap = st.snapshot()
    expect(snap.by_family).toMatchObject({ play_card: 1, shop: 1, other: 1 })
    expect(snap.max_floor).toBe(7)
    expect(snap.combats_won).toBe(1)
    // No free text anywhere in the payload.
    const strings = JSON.stringify(snap).match(/"[^"]*"/g) ?? []
    for (const s of strings) expect(s).not.toMatch(/gold|answer|mystery/i)
    expect(actionFamily('select_map_node')).toBe('map')
    expect(failureClass('failed: the game did not answer the action in time')).toBe('timeout')
  })
})

describe('prompts', () => {
  it('words the loop end and idle tick', () => {
    expect(eventAddendum('sei:idle', {})).toBeTruthy()
    expect(eventAddendum('something_else', {})).toBeFalsy()
  })
})
