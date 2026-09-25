import { describe, it, expect, vi } from 'vitest'
import { createStardewRegistry, VERB_NAMES, VERB_SCHEMAS, patchTiles, tillPatch, MAX_TILL_TILES } from './registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

describe('stardew registry', () => {
  it('registers the 22 verbs (20 world verbs + follow/unfollow) with a description each', () => {
    const reg = createStardewRegistry({ send: vi.fn(async () => 'ok') })
    expect(reg.list().sort()).toEqual([...VERB_NAMES].sort())
    expect(VERB_NAMES).toHaveLength(22)
    for (const name of VERB_NAMES) {
      expect(ACTION_DESCRIPTIONS[name], `description for ${name}`).toBeTruthy()
      expect(reg.description(name)).toBe(ACTION_DESCRIPTIONS[name])
    }
  })

  it('validates args and forwards one cmd per call, returning the detail string', async () => {
    const send = vi.fn(async (name, args) => `did ${name} ${JSON.stringify(args)}`)
    const reg = createStardewRegistry({ send })
    const out = await reg.execute('water', {}, null, { signal: null })
    expect(send).toHaveBeenCalledWith('water', {}, { signal: null })
    expect(out).toMatch(/^did water/)
    await expect(reg.execute('till', { x: 1 }, null, {})).rejects.toThrow()
    await expect(reg.execute('gather', { kind: 'gold' }, null, {})).rejects.toThrow()
    await expect(reg.execute('nope', {}, null, {})).rejects.toThrow(/Unknown action/)
  })

  it('normalises a bare handle number to #N', async () => {
    const send = vi.fn(async () => 'ok')
    const reg = createStardewRegistry({ send })
    await reg.execute('attack', { target: '3' }, null, {})
    expect(send.mock.calls[0][1]).toEqual({ target: '#3', times: 5 })
    await reg.execute('chop', { target: '#4' }, null, {})
    expect(send.mock.calls[1][1]).toEqual({ target: '#4' })
  })

  it('refuses a goTo / chop / mine / interact with neither a tile nor a target', () => {
    for (const name of ['goTo', 'chop', 'mine', 'interact']) {
      expect(VERB_SCHEMAS[name].safeParse({}).success, name).toBe(false)
    }
    expect(VERB_SCHEMAS.goTo.safeParse({ location: 'Town' }).success).toBe(true)
    expect(VERB_SCHEMAS.plant.safeParse({ seed: 'parsnip seeds', count: 4 }).success).toBe(true)
    expect(VERB_SCHEMAS.buy.parse({ item: 'parsnip seeds' })).toEqual({ item: 'parsnip seeds', qty: 1 })
  })

  it('orders a patch as serpentine rows', () => {
    expect(patchTiles(10, 20, 3, 2)).toEqual([
      { x: 10, y: 20 }, { x: 11, y: 20 }, { x: 12, y: 20 },
      { x: 12, y: 21 }, { x: 11, y: 21 }, { x: 10, y: 21 },
    ])
    expect(patchTiles(5, 5)).toEqual([{ x: 5, y: 5 }])
  })

  it('till with a width and height hoes the patch as single tills and sums it up', async () => {
    const send = vi.fn(async (name, args) => {
      if (args.x === 11 && args.y === 20) return 'failed: (11,20) has a stone on it'
      if (args.x === 12 && args.y === 20) return 'failed: (12,20) has a stone on it'
      if (args.x === 10 && args.y === 21) return '(10,21) is already tilled'
      return `tilled (${args.x},${args.y})`
    })
    const onProgress = vi.fn()
    const reg = createStardewRegistry({ send })
    const out = await reg.execute('till', { x: 10, y: 20, width: 3, height: 2 }, null, { signal: null, onProgress })
    expect(send).toHaveBeenCalledTimes(6)
    for (const call of send.mock.calls) {
      expect(call[0]).toBe('till')
      expect(Object.keys(call[1]).sort()).toEqual(['x', 'y'])
    }
    expect(out).toMatch(/^tilled 3 tiles of the 3x2 patch from \(10,20\) to \(12,21\)/)
    expect(out).toMatch(/1 was already soil/)
    expect(out).toMatch(/skipped 2 \(\(11,20\) \(12,20\): has a stone on it\)/)
    expect(onProgress).toHaveBeenLastCalledWith({ dug: 4, total: 6 })
  })

  it('a one-tile till still sends one plain frame', async () => {
    const send = vi.fn(async () => 'tilled (3,4)')
    const reg = createStardewRegistry({ send })
    await reg.execute('till', { x: 3, y: 4, width: 1, height: 1 }, null, {})
    expect(send).toHaveBeenCalledWith('till', { x: 3, y: 4 }, { signal: undefined })
  })

  it('stops a patch on a shared failure and reports how far it got', async () => {
    let n = 0
    const send = vi.fn(async () => (++n <= 2 ? 'tilled' : 'failed: too exhausted to swing'))
    const out = await tillPatch({ x: 0, y: 0, width: 4, height: 2 }, send)
    expect(send).toHaveBeenCalledTimes(3)
    expect(out).toMatch(/^tilled 2 tiles/)
    expect(out).toMatch(/stopped: too exhausted to swing/)
    const none = await tillPatch({ x: 0, y: 0, width: 2, height: 1 }, vi.fn(async () => 'failed: no hoe in the inventory'))
    expect(none).toMatch(/^failed: tilled nothing in the 2x1 patch/)
    const blocked = vi.fn(async () => 'failed: stuck walking at (1,1)')
    const out2 = await tillPatch({ x: 0, y: 0, width: 8, height: 1 }, blocked)
    expect(blocked).toHaveBeenCalledTimes(4)
    expect(out2).toMatch(/^failed: tilled nothing/)
    expect(out2).toMatch(/4 tiles in a row could not be reached/)
  })

  it('stops a patch on abort', async () => {
    const ac = new AbortController()
    const send = vi.fn(async () => { ac.abort(); return 'tilled' })
    expect(await tillPatch({ x: 0, y: 0, width: 3, height: 1 }, send, { signal: ac.signal })).toBe('aborted after tilled 1 tile of the 3x1 patch from (0,0) to (2,0)')
    expect(await tillPatch({ x: 0, y: 0, width: 3, height: 1 }, vi.fn(async () => 'aborted'))).toBe('aborted')
  })

  it('caps a patch at MAX_TILL_TILES', () => {
    expect(VERB_SCHEMAS.till.safeParse({ x: 0, y: 0, width: 8, height: 5 }).success).toBe(true)
    expect(8 * 5).toBe(MAX_TILL_TILES)
    expect(VERB_SCHEMAS.till.safeParse({ x: 0, y: 0, width: 8, height: 6 }).success).toBe(false)
    expect(VERB_SCHEMAS.till.safeParse({ x: 0, y: 0, width: 9 }).success).toBe(false)
  })

  it('ship / give and scope are gated on the connected mod version', async () => {
    const send = vi.fn(async (name) => `did ${name}`)
    let version = '0.1.2'
    const reg = createStardewRegistry({ send, getModVersion: () => version })
    expect(await reg.execute('ship', {}, null, {})).toMatch(/^failed: ship needs a newer Sei helper mod/)
    expect(await reg.execute('give', { item: 'Wood' }, null, {})).toMatch(/^failed: give needs a newer Sei helper mod/)
    expect(send).not.toHaveBeenCalled()
    await reg.execute('water', { scope: 'farm' }, null, {})
    expect(send).toHaveBeenLastCalledWith('water', {}, { signal: undefined })
    version = '0.1.3'
    await reg.execute('water', { scope: 'farm' }, null, {})
    expect(send).toHaveBeenLastCalledWith('water', { scope: 'farm' }, { signal: undefined })
    expect(await reg.execute('ship', { item: 'Parsnip', count: 5 }, null, {})).toBe('did ship')
    expect(send).toHaveBeenLastCalledWith('ship', { item: 'Parsnip', count: 5 }, { signal: undefined })
    expect(await reg.execute('give', { item: 'Wood', count: 50 }, null, {})).toBe('did give')
    await expect(reg.execute('give', {}, null, {})).rejects.toThrow()
    await expect(reg.execute('water', { scope: 'world' }, null, {})).rejects.toThrow()
  })

  it('stops a patch on the mod\'s safety interrupts instead of sending the next tile', async () => {
    for (const reason of ['bedtime', 'retreating: health is low', 'knocked out', 'interrupted: the player warped', 'superseded by a new command', 'paused by the player']) {
      let n = 0
      const send = vi.fn(async () => (++n === 1 ? 'tilled (0,0)' : `failed: ${reason}`))
      const out = await tillPatch({ x: 0, y: 0, width: 5, height: 1 }, send)
      expect(send, reason).toHaveBeenCalledTimes(2)
      expect(out, reason).toBe(`tilled 1 tile of the 5x1 patch from (0,0) to (4,0); stopped: ${reason}`)
    }
    const first = vi.fn(async () => 'failed: bedtime')
    expect(await tillPatch({ x: 0, y: 0, width: 3, height: 1 }, first)).toBe('failed: tilled nothing in the 3x1 patch from (0,0) to (2,0); stopped: bedtime')
    expect(first).toHaveBeenCalledTimes(1)
    // A cancel from the mod reads as an abort.
    const cancelled = vi.fn(async () => 'failed: aborted')
    expect(await tillPatch({ x: 0, y: 0, width: 3, height: 1 }, cancelled)).toBe('aborted')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})
