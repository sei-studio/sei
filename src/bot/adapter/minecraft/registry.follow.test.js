// Proves the explicit-relocate actions end follow mode (260710). The 1s follow
// tick re-installs GoalFollow as long as a target is set, so any relocate that
// does NOT clear it walks out and gets yanked straight back to the owner (the
// live cow-hunt run: explore hopped 13 blocks, follow dragged the bot home).
// Contract under test: goTo and explore clear the follow target; explore's
// up/down guidance early-returns (which don't move the bot) leave it intact.
//
// registry.js statically imports the visualize behavior → povRenderer → native
// gl/canvas (Electron-ABI, unloadable under system-Node vitest), so we mock
// that module the same way registry.vision.test.js does. explore is mocked too
// so the handler runs without a live bot/pathfinder.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./behaviors/visualize.js', () => ({
  visualizeAction: vi.fn(async () => ({ text: 'x', image: { mediaType: 'image/jpeg', dataBase64: 'AAAA' } })),
  __resetVisualizeDedupeCache: vi.fn(),
  CANT_SEE_COPY: "I can't see clearly right now",
  orientationToYawOffset: vi.fn(() => null),
  yawToUnit: vi.fn(() => [0, -1]),
  faceYaw: vi.fn(async () => {}),
  captureFrame: vi.fn(async () => ({ ok: true, mediaType: 'image/jpeg', dataBase64: 'AAAA' })),
}))

vi.mock('./behaviors/explore.js', () => ({
  exploreAction: vi.fn(async () => 'explored 13 blocks right'),
}))

const { createDefaultRegistry } = await import('./registry.js')
const { setFollowTarget, getFollowTargetLabel } = await import('./behaviors/follow.js')

// Minimal bot: enough for the explore handler's isInWater probe and goTo's
// known-player coord check. goTo's inner goTo() pathfind call needs a
// pathfinder; give it one that resolves immediately.
function fakeBot() {
  return {
    entity: { isInWater: false, position: { x: 0, y: 64, z: 0 } },
    players: {},
    entities: {},
    pathfinder: {
      setMovements: () => {},
      setGoal: () => {},
      goto: async () => {},
      stop: () => {},
    },
  }
}

describe('follow is ended by explicit relocates', () => {
  beforeEach(() => {
    setFollowTarget({ kind: 'player', username: 'Ceshi' })
    expect(getFollowTargetLabel()).toBe('Ceshi')
  })

  it('explore clears the follow target', async () => {
    const registry = createDefaultRegistry()
    await registry.execute('explore', { orientation: 'right' }, fakeBot(), {})
    expect(getFollowTargetLabel()).toBe(null)
  })

  it("explore's up/down guidance early-returns do NOT clear the follow target", async () => {
    const registry = createDefaultRegistry()
    const up = await registry.execute('explore', { orientation: 'up' }, fakeBot(), {})
    expect(up).toMatch(/can't fly up/)
    expect(getFollowTargetLabel()).toBe('Ceshi')
    const down = await registry.execute('explore', { orientation: 'down' }, fakeBot(), {})
    expect(down).toMatch(/dig to tunnel down/)
    expect(getFollowTargetLabel()).toBe('Ceshi')
  })

  it('goTo clears the follow target (existing contract, regression guard)', async () => {
    const registry = createDefaultRegistry()
    // The pathfind result itself is irrelevant here; only the follow side
    // effect is under test, and it happens before the pathfind.
    await registry.execute('goTo', { x: 1, y: 64, z: 1 }, fakeBot(), {}).catch(() => {})
    expect(getFollowTargetLabel()).toBe(null)
  })
})

// 260730: follow is a MODE, and any acting action ends it. Before this only
// goTo/explore/unfollow did, so a dig or a gather left the 1s tick re-installing
// GoalFollow toward a target that could be stale or unreachable — live, the
// player died and the bot kept trailing a position it could not path to, and
// dug itself into a hole. The clear happens in a wrapper at registration, so a
// NEW action inherits it; only queries and self-managed relocates are exempt.
describe('every acting action ends follow mode', () => {
  beforeEach(() => {
    setFollowTarget({ kind: 'player', username: 'Ceshi' })
  })

  for (const [name, args] of [
    ['dig', { block: 'stone' }],
    ['gather', { name: 'oak_log' }],
    ['build', { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 }, block: 'dirt' }],
    ['equip', { item: 'stone_pickaxe', destination: 'hand' }],
    ['sleep', { block: 'bed' }],
    ['activateItem', {}],
  ]) {
    it(`${name} clears the follow target`, async () => {
      const registry = createDefaultRegistry()
      // Handlers need a live world; the clear runs BEFORE dispatch, so a
      // rejection here is expected and irrelevant to the contract.
      await registry.execute(name, args, fakeBot(), {}).catch(() => {})
      expect(getFollowTargetLabel()).toBe(null)
    })
  }

  it('pure queries leave it intact: looking something up is not relocating', async () => {
    const registry = createDefaultRegistry()
    // An unknown term short-circuits find before it touches the world.
    await registry.execute('find', { name: 'zzzznotathing' }, fakeBot(), {}).catch(() => {})
    expect(getFollowTargetLabel()).toBe('Ceshi')
  })

  it('follow itself still sets the target', async () => {
    const registry = createDefaultRegistry()
    setFollowTarget(null)
    const bot = fakeBot()
    bot.players = { Shawn: { entity: { position: { x: 1, y: 64, z: 1 } }, username: 'Shawn' } }
    await registry.execute('follow', { player: 'Shawn' }, bot, {}).catch(() => {})
    expect(getFollowTargetLabel()).toBe('Shawn')
  })
})
