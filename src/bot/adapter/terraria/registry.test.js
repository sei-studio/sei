// The Terraria verb set: schemas accept what the mod takes and refuse the
// rest, and each verb reaches the mod as one cmd frame with the target
// normalized to "#N".
import { describe, it, expect, vi } from 'vitest'
import { VERB_SCHEMAS, VERB_NAMES, createTerrariaRegistry, MAX_MINE_TILES } from './registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

const ok = (name, args) => VERB_SCHEMAS[name].safeParse(args).success

describe('terraria registry', () => {
  it('has the fourteen verbs, each with a description', () => {
    expect(VERB_NAMES).toEqual(['follow', 'unfollow', 'come', 'goTo', 'stance', 'attack', 'give', 'take', 'mine', 'place', 'chop', 'use', 'equip', 'craft'])
    for (const name of VERB_NAMES) expect(ACTION_DESCRIPTIONS[name], name).toBeTruthy()
  })

  it('accepts the shapes the mod takes and refuses the rest', () => {
    expect(ok('goTo', { x: 10, y: 20 })).toBe(true)
    expect(ok('goTo', { target: '#3' })).toBe(true)
    expect(ok('goTo', { player: 'Ouen' })).toBe(true)
    expect(ok('goTo', { x: 10 })).toBe(false)
    expect(ok('stance', { mode: 'passive' })).toBe(true)
    expect(ok('stance', { mode: 'berserk' })).toBe(false)
    expect(ok('attack', {})).toBe(true)
    expect(ok('attack', { target: 'slime' })).toBe(false)
    expect(ok('mine', { block: 'Dirt Block', count: 10 })).toBe(true)
    expect(ok('mine', { x: 1, y: 2, width: 5, height: 8 })).toBe(true)
    expect(ok('mine', { x: 1, y: 2, width: 12, height: 12 })).toBe(false)
    expect(MAX_MINE_TILES).toBe(40)
    expect(ok('mine', {})).toBe(false)
    expect(ok('place', { item: 'Wood Platform', x: 1, y: 2, width: 10 })).toBe(true)
    expect(ok('place', { item: 'Wood', x: 1, y: 2, width: 6, height: 6 })).toBe(false)
    expect(ok('craft', { item: 'Wooden Arrow', count: 250 })).toBe(true)
    expect(ok('craft', { item: 'Wooden Arrow', count: 251 })).toBe(false)
    expect(ok('give', { item: 'Wood', count: 0 })).toBe(false)
  })

  it('sends one frame per call with the target as #N and passes the signal and progress', async () => {
    const send = vi.fn(async () => 'done')
    const reg = createTerrariaRegistry({ send })
    const signal = new AbortController().signal
    const onProgress = () => {}
    expect(await reg.execute('attack', { target: '3' }, null, { signal, onProgress })).toBe('done')
    expect(send).toHaveBeenCalledWith('attack', { target: '#3' }, { signal, onProgress })
    await reg.execute('goTo', { target: '#5' }, null, {})
    expect(send.mock.calls[1][1]).toEqual({ target: '#5' })
  })

  it('refuses bad args before anything reaches the mod', async () => {
    const send = vi.fn(async () => 'done')
    const reg = createTerrariaRegistry({ send })
    await expect(reg.execute('stance', { mode: 'berserk' }, null, {})).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
