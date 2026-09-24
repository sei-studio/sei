import { describe, it, expect, vi } from 'vitest'
import { createStardewRegistry, VERB_NAMES, VERB_SCHEMAS } from './registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

describe('stardew registry', () => {
  it('registers the 20 verbs (18 world verbs + follow/unfollow) with a description each', () => {
    const reg = createStardewRegistry({ send: vi.fn(async () => 'ok') })
    expect(reg.list().sort()).toEqual([...VERB_NAMES].sort())
    expect(VERB_NAMES).toHaveLength(20)
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
})
