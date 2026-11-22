// 261017 (pass 12): goTo out of a hole. In the 261016 errands eval climbOut
// pillared two blocks to a dead-end pocket in the shaft wall, the walk timed
// out 13 blocks underground, escapeUp never ran (it only ran when climbOut
// had NOT climbed), and the result told her she was out of the hole:
// "timeout â€” unreachable â€” try build to Y=71 (first pillared out of the
// 2-deep hole you were in)". She told the player "almost there".
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
const climbOutMock = vi.fn()
const escapeUpMock = vi.fn()
vi.mock('./behaviors/climbOut.js', async (orig) => ({
  ...(await orig()),
  climbOut: (...a) => climbOutMock(...a),
  escapeUp: (...a) => escapeUpMock(...a),
}))

const { createDefaultRegistry } = await import('./registry.js')

// Stone at y<=70 with a 1x1 shaft at (0,0) down to y=57 and a dead-end
// pocket at (1,59..60,0). The bot stands at `feet` inside the shaft.
function holeBot(feet = 59) {
  const air = new Set(['1,59,0', '1,60,0'])
  for (let y = 70; y >= 57; y--) air.add(`0,${y},0`)
  return {
    version: '1.21.1',
    entity: { position: new Vec3(0.5, feet, 0.5), onGround: true },
    entities: {},
    players: {},
    blockAt(p) {
      const solid = !air.has(`${p.x},${p.y},${p.z}`) && p.y <= 70
      return { name: solid ? 'stone' : 'air', position: p, boundingBox: solid ? 'block' : 'empty' }
    },
  }
}

beforeEach(() => {
  goToMock.mockReset()
  climbOutMock.mockReset()
  escapeUpMock.mockReset()
})

describe('goTo from a hole', () => {
  it('runs escapeUp after climbOut climbed but the walk still failed, then walks again', async () => {
    const bot = holeBot()
    climbOutMock.mockResolvedValue({ status: 'climbed', depth: 2, how: 'pillar', exit: false })
    goToMock
      .mockResolvedValueOnce('timeout â€” unreachable â€” try build to Y=71')
      .mockImplementationOnce(async (b) => { b.entity.position = new Vec3(4.5, 71, 0.5); return 'reached' })
    escapeUpMock.mockImplementation(async (b) => { b.entity.position = new Vec3(0.5, 71, 0.5); return { status: 'climbed', depth: 12, how: 'pillar' } })
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { x: 4, y: 71, z: 0 }, bot, {})
    expect(escapeUpMock).toHaveBeenCalledTimes(1)
    expect(goToMock).toHaveBeenCalledTimes(2)
    expect(String(r)).toMatch(/^reached \(the first walk failed, so you pillared 12 blocks up out of the hole and walked again\)/)
  })

  it('says plainly she is still in the hole, how far down, and drops the "try build" hint', async () => {
    const bot = holeBot()
    climbOutMock.mockResolvedValue({ status: 'climbed', depth: 2, how: 'pillar', exit: false })
    goToMock.mockResolvedValue('timeout â€” unreachable â€” try build to Y=71')
    // escapeUp gets nowhere new (say the pillar ran out of time partway).
    escapeUpMock.mockResolvedValue({ status: 'not_in_pit' })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { x: 4, y: 71, z: 0 }, bot, {}))
    expect(r).toMatch(/^timeout: you are still down in the hole at 0,59,0, 12 blocks below where you are going/)
    expect(r).toMatch(/dead-end pocket, not the way out/)
    expect(r).not.toMatch(/try build to Y=/)
    expect(r).not.toMatch(/out of the 2-deep hole/)
    expect(r).toMatch(/pillar up with build \(direction below\).*or dig a staircase/)
    expect(r).not.toMatch(/ $|  /)
  })

  it('with no climb to report, the line still reads cleanly and gives the next step', async () => {
    const bot = holeBot(57)
    climbOutMock.mockResolvedValue({ status: 'not_in_pit' })
    goToMock.mockResolvedValue('timeout â€” unreachable â€” try build to Y=71')
    escapeUpMock.mockResolvedValue({ status: 'not_in_pit' })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { x: 4, y: 71, z: 0 }, bot, {}))
    expect(r).toMatch(/^timeout: you are still down in the hole at 0,57,0, 14 blocks below where you are going, so you are not on your way yet\. Walking again/)
    expect(r).not.toMatch(/ $|  /)
  })

  it('a failed escape keeps its own "stuck in a hole" line first', async () => {
    const bot = holeBot()
    climbOutMock.mockResolvedValue({ status: 'climbed', depth: 2, how: 'pillar', exit: false })
    goToMock.mockResolvedValue('timeout â€” unreachable â€” try build to Y=71')
    escapeUpMock.mockResolvedValue({ status: 'failed', line: 'stuck in a hole at 0,59,0: 12 blocks below where you are going and could not climb up (now y=59, 0 scaffold blocks; pillar: ran out of blocks). Get dirt or cobblestone to pillar up with, or dig a staircase up the wall' })
    const reg = createDefaultRegistry()
    const r = String(await reg.execute('goTo', { x: 4, y: 71, z: 0 }, bot, {}))
    expect(r).toMatch(/^stuck in a hole at 0,59,0: 12 blocks below/)
    expect(r).toMatch(/dead-end pocket/)
  })

  it('on open ground under a cliff a failed walk keeps its normal result', async () => {
    const bot = {
      version: '1.21.1',
      entity: { position: new Vec3(0.5, 71, 0.5), onGround: true },
      entities: {},
      players: {},
      blockAt: (p) => ({ name: p.y <= 70 ? 'stone' : 'air', position: p, boundingBox: p.y <= 70 ? 'block' : 'empty' }),
    }
    climbOutMock.mockResolvedValue({ status: 'not_in_pit' })
    goToMock.mockResolvedValue('cant_reach â€” unreachable â€” try build to Y=80')
    escapeUpMock.mockResolvedValue({ status: 'not_in_pit' })
    const reg = createDefaultRegistry()
    const r = await reg.execute('goTo', { x: 4, y: 80, z: 0 }, bot, {})
    expect(r).toBe('cant_reach â€” unreachable â€” try build to Y=80')
  })
})




