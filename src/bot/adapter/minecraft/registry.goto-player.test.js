// 261019 (quality pass 19): goTo toward the player. The model copied player
// coords from an older snapshot ("walked to a spot about 28 blocks from
// Alex"); goTo({player}) walks to where they are now, and again if they
// moved on. Also: the walk opts in to resuming after an interruption, and a
// reflex that cut the climb out of a hole short no longer ends the goTo.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Vec3 } from 'vec3'

vi.mock('./behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({ text: 'x', image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' } })),
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
  orientationToYawOffset: vi.fn(() => null),
  yawToUnit: vi.fn(() => [0, -1]),
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => ({ ok: true, mediaType: 'image/jpeg', dataBase64: 'AAAA' })),
}))

const goToMock = vi.fn()
const waitMock = vi.fn(async () => 'clear')
vi.mock('./behaviors/pathfind.js', async (orig) => ({
  ...(await orig()),
  goTo: (...a) => goToMock(...a),
  waitForBodyFree: (...a) => waitMock(...a),
}))
const climbOutMock = vi.fn()
const escapeUpMock = vi.fn()
vi.mock('./behaviors/climbOut.js', async (orig) => ({
  ...(await orig()),
  climbOut: (...a) => climbOutMock(...a),
  escapeUp: (...a) => escapeUpMock(...a),
}))

const { createDefaultRegistry } = await import('./registry.js')

function flatBot() {
  const alex = { username: 'Alex', type: 'player', position: new Vec3(20.5, 64, 0.5) }
  return {
    version: '1.21.1',
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    entities: { 9: alex },
    players: { Alex: { username: 'Alex', entity: alex } },
    _alex: alex,
    blockAt(p) {
      const solid = p.y < 64
      return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' }
    },
  }
}

beforeEach(() => {
  goToMock.mockReset()
  climbOutMock.mockReset()
  escapeUpMock.mockReset()
  waitMock.mockClear()
  climbOutMock.mockResolvedValue({ status: 'not_in_pit' })
})

describe('goTo({player})', () => {
  it('walks to where the player is now, with range 2 and resume on', async () => {
    const bot = flatBot()
    goToMock.mockImplementation(async (b, x, y, z) => { b.entity.position = new Vec3(x - 1, y, z + 0.5); return 'reached' })
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { player: 'alex' }, bot, {})
    expect(goToMock).toHaveBeenCalledTimes(1)
    const [, x, y, z, range, , , opts] = goToMock.mock.calls[0]
    expect([x, y, z, range]).toEqual([20, 64, 0, 2])
    expect(opts).toMatchObject({ resume: true })
    expect(String(r)).toMatch(/^reached Alex \(\d\.\dm away\)$/)
  })

  it('walks again when the player moved on during the walk', async () => {
    const bot = flatBot()
    goToMock.mockImplementation(async (b, x, y, z) => {
      b.entity.position = new Vec3(x + 0.5, y, z + 0.5)
      if (goToMock.mock.calls.length === 1) bot._alex.position = new Vec3(40.5, 64, 0.5)
      return 'reached'
    })
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { player: 'Alex' }, bot, {})
    expect(goToMock).toHaveBeenCalledTimes(2)
    expect(goToMock.mock.calls[1].slice(1, 4)).toEqual([40, 64, 0])
    expect(String(r)).toMatch(/^reached Alex/)
  })

  it('a failed walk says where the player is now', async () => {
    const bot = flatBot()
    goToMock.mockResolvedValue('cant_reach (closest=12.0m to target 20,64,0)')
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { player: 'Alex' }, bot, {}))
    expect(r).toMatch(/^cant_reach .*\. Alex is at 20,64,0, 20\.0m from you$/)
  })

  it('an unknown player, and a player out of sight', async () => {
    const bot = flatBot()
    const reg = createDefaultRegistry()
    expect(String(await reg.execute('goTo', { player: 'Steve' }, bot, {}))).toBe('no such player: Steve')
    bot.players.Alex.entity = null
    expect(String(await reg.execute('goTo', { player: 'Alex' }, bot, {}))).toMatch(/^can't see Alex from here/)
    expect(goToMock).not.toHaveBeenCalled()
  })

  it('needs a player or all of x,y,z', async () => {
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { x: 1 }, flatBot(), {}).catch((e) => String(e))
    expect(String(typeof r === 'string' ? r : JSON.stringify(r))).toMatch(/player, or x,y,z/)
  })
})

describe('goTo(x,y,z) after a reflex cut the climb short', () => {
  it('waits for the body and climbs again instead of returning aborted', async () => {
    const bot = flatBot()
    climbOutMock
      .mockResolvedValueOnce({ status: 'aborted', why: 'yielded' })
      .mockResolvedValueOnce({ status: 'not_in_pit' })
    goToMock.mockResolvedValue('reached')
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { x: 5, y: 64, z: 0 }, bot, {})
    expect(waitMock).toHaveBeenCalledTimes(1)
    expect(climbOutMock).toHaveBeenCalledTimes(2)
    expect(String(r)).toBe('reached')
  })

  it('still reports the abort when the body never frees up', async () => {
    const bot = flatBot()
    climbOutMock.mockResolvedValue({ status: 'aborted', why: 'yielded' })
    waitMock.mockResolvedValueOnce('timeout')
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { x: 5, y: 64, z: 0 }, bot, {})
    expect(String(r)).toBe('aborted (a reflex took over while climbing out of a hole)')
    expect(goToMock).not.toHaveBeenCalled()
  })
})

// 261107 (quality pass 45): one 12s leg is ~25-35m of walking, so a goTo back
// to a player farther than that came back "timeout" part way there and the
// model read it as a failed walk. A timed-out leg that was still closing in
// walks on; one that went nowhere still ends the goTo.
describe('goTo walks on while a timed-out leg was closing in (261107)', () => {
  function farBot() {
    const bot = flatBot()
    bot._alex.position = new Vec3(64.5, 64, 0.5)
    return bot
  }

  it('reaches a player 64m off over several legs', async () => {
    const bot = farBot()
    goToMock.mockImplementation(async (b, x, y, z) => {
      const p = b.entity.position
      const nx = Math.min(x - 1, p.x + 25)
      b.entity.position = new Vec3(nx, y, z + 0.5)
      return nx >= x - 1 ? 'reached' : 'timeout'
    })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { player: 'Alex' }, bot, {}))
    expect(goToMock).toHaveBeenCalledTimes(3)
    expect(r).toMatch(/^reached Alex/)
  })

  it('a leg that did not close in still ends the goTo with the distance', async () => {
    const bot = farBot()
    goToMock.mockImplementation(async (b) => { b.entity.position = b.entity.position.offset(1, 0, 0); return 'timeout' })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { player: 'Alex' }, bot, {}))
    expect(goToMock).toHaveBeenCalledTimes(1)
    expect(r).toMatch(/^timeout\. Alex is at 64,64,0, 63\.0m from you$/)
  })

  it('walks on at most PROGRESS_LEGS more legs', async () => {
    const bot = farBot()
    bot._alex.position = new Vec3(500.5, 64, 0.5)
    bot.players.Alex.entity = bot._alex
    goToMock.mockImplementation(async (b) => { b.entity.position = b.entity.position.offset(20, 0, 0); return 'timeout' })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { player: 'Alex' }, bot, {}))
    expect(goToMock).toHaveBeenCalledTimes(4)
    expect(r).toMatch(/^timeout\. Alex is at 500,64,0/)
  })

  it('goTo(x,y,z) walks on the same way', async () => {
    const bot = flatBot()
    goToMock.mockImplementation(async (b, x, y, z) => {
      const p = b.entity.position
      const nx = Math.min(x, p.x + 25)
      b.entity.position = new Vec3(nx, y, z + 0.5)
      return nx >= x ? 'reached' : 'timeout'
    })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { x: 60, y: 64, z: 0, range: 2 }, bot, {}))
    expect(goToMock).toHaveBeenCalledTimes(3)
    expect(r).toBe('reached')
  })

  it('an aborted walk does not walk on', async () => {
    const bot = farBot()
    const ac = new AbortController()
    goToMock.mockImplementation(async (b) => { b.entity.position = b.entity.position.offset(20, 0, 0); ac.abort(); return 'timeout' })
    const reg = createDefaultRegistry()
    await reg.execute('goTo', { x: 60, y: 64, z: 0, range: 2 }, bot, { signal: ac.signal })
    expect(goToMock).toHaveBeenCalledTimes(1)
  })
})
