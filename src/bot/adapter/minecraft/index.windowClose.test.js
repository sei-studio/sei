// 261011: an open furnace window made the next craft resolve without crafting
// ("crafted 4 oak_planks", no log used). executeAction now closes an open
// furnace/chest window before any action that is not a window verb.
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

import { createMinecraftAdapter } from './index.js'
import { createActionStats } from '../../brain/actionStats.js'
import { openFurnaceAction, closeFurnaceSession } from './behaviors/furnace.js'

const FURNACE_BLOCK = { name: 'furnace', position: { x: 1, y: 64, z: 1 } }

function makeFurnace() {
  return {
    inputItem: () => null, fuelItem: () => null, outputItem: () => null,
    close: vi.fn(),
  }
}

function setup(furnace) {
  const bot = {
    chat: vi.fn(), username: 'sei', players: {}, version: '1.21.1',
    heldItem: { name: 'bow' },
    activateItem: vi.fn(async () => {}),
    entity: { position: { x: 1, y: 64, z: 2, distanceTo: () => 1 } },
    inventory: { items: () => [] },
    blockAt: () => FURNACE_BLOCK,
    findBlock: () => FURNACE_BLOCK,
    openFurnace: vi.fn(async () => furnace),
  }
  const adapter = createMinecraftAdapter({ bot, config: { adapter: { minecraft: {} } }, actionStats: createActionStats() })
  return { adapter, bot }
}

beforeEach(async () => { await closeFurnaceSession() })

describe('open windows close before other actions', () => {
  it('a non-window action closes the furnace first', async () => {
    const furnace = makeFurnace()
    const { adapter, bot } = setup(furnace)
    await openFurnaceAction({ block: 'furnace' }, bot, {})
    await adapter.executeAction('activateItem', {})
    expect(furnace.close).toHaveBeenCalledTimes(1)
  })

  it('a window verb keeps it open', async () => {
    const furnace = makeFurnace()
    const { adapter, bot } = setup(furnace)
    await openFurnaceAction({ block: 'furnace' }, bot, {})
    await adapter.executeAction('takeSmelted', {})
    expect(furnace.close).not.toHaveBeenCalled()
  })
})




