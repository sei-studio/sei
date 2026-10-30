// 261025 (pass 27 review): the walk onto a dug block's drop carries the
// action's abort signal, so a stop ends it instead of leaving the pathfinder
// walking for up to 3s (the stop-lag pattern of 260617).
import { describe, it, expect, vi } from 'vitest'
import { Vec3 } from 'vec3'

const goToMock = vi.fn(async () => 'reached')
vi.mock('./pathfind.js', async (orig) => ({ ...(await orig()), goTo: (...a) => goToMock(...a) }))
vi.mock('./toolSelect.js', async (orig) => ({
  ...(await orig()),
  equipBestTool: vi.fn(async () => ({ ms: 500, harvest: true })),
}))

const { digAction } = await import('./dig.js')

describe('dig pickup walk and the abort signal (261025)', () => {
  it('passes the signal to the walk onto the drop', async () => {
    const bot = {
      entity: { position: new Vec3(0.5, 65, 0.5) },
      blockAt: (p) => ({ name: p.y <= 64 ? 'stone' : 'air', position: new Vec3(p.x, p.y, p.z) }),
      targetDigBlock: null,
      stopDigging: vi.fn(),
      dig: vi.fn(async () => {}),
    }
    const ac = new AbortController()
    const r = await digAction({ x: 1, y: 64, z: 0 }, bot, { signal: ac.signal })
    expect(r).toMatch(/^dug stone/)
    expect(goToMock).toHaveBeenCalledTimes(1)
    expect(goToMock.mock.calls[0][6]).toBe(ac.signal)
  })
})
