// 261011: every world action that goes through adapter.executeAction is
// recorded in the session's action-outcome stats (brain/actionStats.js).
import { describe, it, expect, vi } from 'vitest'

// Keep the native POV stack off the import graph (see index.test.js).
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

function setup(botExtra = {}) {
  const bot = { chat: vi.fn(), username: 'sei', players: {}, activateItem: vi.fn(async () => {}), ...botExtra }
  const actionStats = createActionStats()
  const adapter = createMinecraftAdapter({ bot, config: { adapter: { minecraft: {} } }, actionStats })
  return { adapter, bot, actionStats }
}

describe('adapter.executeAction records action outcomes', () => {
  it('a success and a classified failure', async () => {
    const { adapter, actionStats } = setup()
    await adapter.executeAction('activateItem', {})
    const snap1 = actionStats.snapshot()
    expect(snap1.actions.activateItem).toMatchObject({ n: 1, ok: 0, fail: 1, reasons: { missing_materials: 1 } })
    const held = setup({ heldItem: { name: 'bow' } })
    await held.adapter.executeAction('activateItem', {})
    expect(held.actionStats.snapshot().actions.activateItem).toMatchObject({ n: 1, ok: 1, fail: 0 })
  })

  it('a pre-aborted signal counts as a preempt abort', async () => {
    const { adapter, actionStats } = setup({ heldItem: { name: 'bow' } })
    const ac = new AbortController(); ac.abort()
    await adapter.executeAction('activateItem', {}, { signal: ac.signal })
    expect(actionStats.snapshot().actions.activateItem.reasons).toEqual({ aborted_by_preempt: 1 })
  })

  it('a thrown error is recorded and still rethrown', async () => {
    const { adapter, actionStats, bot } = setup()
    await expect(adapter.executeAction('noSuchAction', {})).rejects.toThrow(/Unknown action/)
    expect(actionStats.snapshot().actions.noSuchAction).toMatchObject({ n: 1, fail: 1, reasons: { bad_args: 1 } })
    expect(bot._seiActionActive).toBe(0)
  })

  it('starting an action answers a waiting player line', async () => {
    const { adapter, actionStats } = setup({ heldItem: { name: 'bow' } })
    actionStats.notePlayerChat()
    await adapter.executeAction('activateItem', {})
    expect(actionStats.snapshot().counters).toMatchObject({ player_msgs: 1, replied: 1, unanswered: 0 })
  })
})
