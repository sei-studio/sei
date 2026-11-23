// 261123 (quality pass 62): goTo swims out of deep water before it walks.
// gather_craft-02 (2026-11-23 scorecard): from the bed of a river every goTo
// to the bank came back stuck / cant_reach / timeout (the pathfinder has no
// move up through water), and pillar up failed there too.
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
vi.mock('./behaviors/pathfind.js', async (orig) => ({ ...(await orig()), goTo: (...a) => goToMock(...a) }))
const swimMock = vi.fn()
vi.mock('./behaviors/swimOut.js', async (orig) => ({ ...(await orig()), swimToShore: (...a) => swimMock(...a) }))

const { createDefaultRegistry } = await import('./registry.js')
const { buildAction } = await import('./behaviors/build.js')

// A river 6 deep (y 56..61) over x 0..9, a sand bank at x >= 10.
function riverBot(pos = new Vec3(4.5, 56, 0.5)) {
  const name = (x, y) => (y < 56 ? 'stone' : x >= 0 && x <= 9 ? (y <= 61 ? 'water' : 'air') : (y <= 61 ? 'sand' : 'air'))
  return {
    version: '1.21.1',
    entity: { position: pos, onGround: false, isInWater: true },
    entities: {},
    players: {},
    inventory: { items: () => [{ name: 'cobblestone', count: 8 }] },
    blockAt(p) {
      const n = name(p.x, p.y)
      return { name: n, position: p, boundingBox: n === 'water' || n === 'air' ? 'empty' : 'block' }
    },
  }
}

beforeEach(() => {
  goToMock.mockReset()
  swimMock.mockReset()
})

describe('goTo out of deep water (261123)', () => {
  it('swims to the shore first, then walks', async () => {
    const reg = createDefaultRegistry()
    const bot = riverBot()
    swimMock.mockImplementation(async (b) => { b.entity.position = new Vec3(10.5, 62, 0.5); b.entity.isInWater = false; return { status: 'ashore', landing: { x: 10, y: 62, z: 0 } } })
    goToMock.mockResolvedValue('reached')
    const r = await reg.execute('goTo', { x: 20, y: 62, z: 0, range: 1 }, bot, {})
    expect(swimMock).toHaveBeenCalledTimes(1)
    expect(swimMock.mock.calls[0][1]).toMatchObject({ x: 20, y: 62, z: 0 })
    expect(goToMock).toHaveBeenCalled()
    expect(r).toBe('reached')
  })

  it('a failed walk after the swim says where she climbed out', async () => {
    const reg = createDefaultRegistry()
    const bot = riverBot()
    swimMock.mockImplementation(async (b) => { b.entity.position = new Vec3(10.5, 62, 0.5); b.entity.isInWater = false; return { status: 'ashore', landing: { x: 10, y: 62, z: 0 } } })
    goToMock.mockResolvedValue('cant_reach (closest=9.0m to target 20,62,9)')
    const r = await reg.execute('goTo', { x: 20, y: 62, z: 9, range: 1 }, bot, {})
    expect(r).toBe('cant_reach (closest=9.0m to target 20,62,9) (you swam out of the deep water onto the shore at 10,62,0 first)')
  })

  it('no shore in reach: the walk still runs and its failure says so', async () => {
    const reg = createDefaultRegistry()
    const bot = riverBot()
    swimMock.mockResolvedValue({ status: 'no_shore' })
    goToMock.mockResolvedValue('timeout')
    const r = await reg.execute('goTo', { x: 20, y: 62, z: 0, range: 1 }, bot, {})
    expect(goToMock).toHaveBeenCalled()
    expect(r).toMatch(/^timeout.*\(you are in deep water and there is no shore you can climb out on within 16 blocks\)$/)
  })

  it('an abort during the swim ends the goTo', async () => {
    const reg = createDefaultRegistry()
    swimMock.mockResolvedValue({ status: 'aborted' })
    const r = await reg.execute('goTo', { x: 20, y: 62, z: 0 }, riverBot(), {})
    expect(r).toBe('aborted')
    expect(goToMock).not.toHaveBeenCalled()
  })

  it('a goTo to a spot in the same water does not swim to the shore; nor one from dry ground', async () => {
    const reg = createDefaultRegistry()
    goToMock.mockResolvedValue('reached')
    await reg.execute('goTo', { x: 2, y: 57, z: 3 }, riverBot(), {})
    const dry = riverBot(new Vec3(12.5, 62, 0.5))
    dry.entity.isInWater = false
    dry.entity.onGround = true
    await reg.execute('goTo', { x: 20, y: 62, z: 0 }, dry, {})
    expect(swimMock).not.toHaveBeenCalled()
  })

  it('explore up in water points at goTo', async () => {
    const reg = createDefaultRegistry()
    const r = await reg.execute('explore', { orientation: 'up' }, riverBot(), {})
    expect(r).toMatch(/goTo a spot on land: the walk swims you to the shore first$/)
  })
})

describe('pillar up in deep water (261123)', () => {
  it('says it cannot work and what does, before the block count', async () => {
    const bot = riverBot()
    const r = await buildAction({ direction: 'below', count: 12, block: 'cobblestone' }, bot, {})
    expect(r).toBe('you are in deep water, where a jump does not lift you clear of the cell under you, so pillaring up cannot work here. goTo a spot on land first: the walk swims you to the nearest shore')
  })
})
