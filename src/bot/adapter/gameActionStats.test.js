import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { withActionStats, failureClass } from './gameActionStats.js'
import { createActionStats } from '../brain/actionStats.js'
import { createDontStarveAdapter } from './dontstarve/index.js'
import { createObservationState, createHandleRegistry } from './dontstarve/protocol.js'
import { createFakeMod } from '../../../scripts/fake-dst-mod.mjs'

describe('game action stats (261113)', () => {
  it('classifies the mods\' failure texts into the closed set', () => {
    expect(failureClass('no butterfly matching "butterfly" nearby. Use a #N handle')).toBe('target_not_found')
    expect(failureClass('nothing ready to harvest nearby')).toBe('target_not_found')
    expect(failureClass('you need 4 twigs and have 1')).toBe('missing_materials')
    expect(failureClass('no "meat" in your inventory')).toBe('missing_materials')
    expect(failureClass('replaced by gather')).toBe('aborted_by_preempt')
    expect(failureClass('load needs a newer Sei helper mod in the game')).toBe('refused')
    expect(failureClass('something new and odd')).toBe('refused')
  })

  it('records a success, a failure with its class, and a thrown schema error', async () => {
    const stats = createActionStats()
    await withActionStats('dig', true, async () => 'dig done: sapling', { failed: () => null, stats })
    await withActionStats('cookpot', true, async () => 'you need 4 twigs and have 1', { failed: (r) => r, stats })
    await expect(withActionStats('plant', true, async () => { const e = new Error('bad'); e.issues = []; throw e }, { failed: () => null, stats })).rejects.toThrow()
    await withActionStats('madeUp', false, async () => 'x', { failed: () => null, stats })
    const snap = stats.snapshot()
    expect(snap.actions.dig).toMatchObject({ n: 1, ok: 1, fail: 0 })
    expect(snap.actions.cookpot).toMatchObject({ n: 1, ok: 0, fail: 1, reasons: { missing_materials: 1 } })
    expect(snap.actions.plant.reasons).toEqual({ bad_args: 1 })
    expect(snap.actions.other).toMatchObject({ n: 1 })
    expect(snap.actions.madeUp).toBeUndefined()
  })

  it('DST: the helper\'s ok flag decides, and a registry refusal counts as a failure', async () => {
    const state = createObservationState()
    state.apply(createFakeMod({ botPort: 1, token: 'x' }).frame(true))
    let lastResult = null
    const link = {
      events: new EventEmitter(), state, handles: createHandleRegistry(), botName: 'Sui', body: { fight: true },
      playerName: () => 'Steve', playerUserid: () => 'KU_steve', say: vi.fn(), setPaused: vi.fn(), paused: false,
      hasCaps: true, hasChores: true, guid: 9001, modVersion: '0.4.0',
      get lastResult() { return lastResult },
      send: vi.fn(async (cmd) => {
        const ok = cmd.kind !== 'stash'
        lastResult = { text: ok ? 'chop done: evergreen' : 'nothing to stash: no loot nearby', ok }
        return lastResult.text
      }),
    }
    const stats = createActionStats()
    const adapter = createDontStarveAdapter({ link, config: { adapter: { dontstarve: { prefab: 'wilson' } } }, actionStats: stats })
    await adapter.executeAction('chop', {})
    await adapter.executeAction('stash', {})
    await adapter.executeAction('eat', { item: 'gold' })
    const a = stats.snapshot().actions
    expect(a.chop).toMatchObject({ n: 1, ok: 1 })
    expect(a.stash).toMatchObject({ n: 1, fail: 1, reasons: { target_not_found: 1 } })
    expect(a.eat).toMatchObject({ n: 1, fail: 1, reasons: { missing_materials: 1 } })
  })
})
