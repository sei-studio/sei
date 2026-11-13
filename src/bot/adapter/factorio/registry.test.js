import { describe, it, expect, vi } from 'vitest'
import { createFactorioRegistry, VERB_SCHEMAS, VERB_NAMES, MOD_VERB, modArgs } from './registry.js'
import { ACTION_DESCRIPTIONS } from './prompts.js'

describe('factorio registry', () => {
  it('has a description for every tool', () => {
    for (const name of VERB_NAMES) expect(ACTION_DESCRIPTIONS[name], name).toBeTruthy()
  })

  it('normalises item names to Factorio ids', () => {
    expect(VERB_SCHEMAS.craft.parse({ item: ' Iron Gear Wheel ' })).toEqual({ item: 'iron-gear-wheel', count: 1 })
    expect(VERB_SCHEMAS.gather.parse({ resource: 'Wood' })).toEqual({ resource: 'wood', count: 20 })
  })

  it('needs a target or x and y for targeted verbs', () => {
    expect(() => VERB_SCHEMAS.inspect.parse({})).toThrow()
    expect(() => VERB_SCHEMAS.inspect.parse({ x: 1 })).toThrow()
    expect(VERB_SCHEMAS.inspect.parse({ target: '#48' })).toEqual({ target: '#48' })
    expect(VERB_SCHEMAS.pickUp.parse({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    expect(() => VERB_SCHEMAS.take.parse({ target: 'chest' })).toThrow()
  })

  it('sends handles to the mod as bare numbers', () => {
    expect(modArgs({ target: '#48', item: 'coal' })).toEqual({ target: 48, item: 'coal' })
    expect(modArgs({ target: 7 })).toEqual({ target: 7 })
  })

  it('maps tool names to mod verbs and returns the result text', async () => {
    const run = vi.fn(async () => ({ success: true, msg: 'built 3 ghosts' }))
    const reg = createFactorioRegistry({ run })
    expect(await reg.execute('buildGhosts', {}, null, {})).toBe('built 3 ghosts')
    expect(run).toHaveBeenCalledWith('build_ghosts', {}, { signal: null })
    for (const [tool, verb] of Object.entries(MOD_VERB)) expect(VERB_NAMES).toContain(tool) && expect(verb).toBeTruthy()
  })

  it('prefixes failures and reports aborts', async () => {
    const reg = createFactorioRegistry({ run: async () => ({ success: false, msg: 'no path to the iron-ore' }) })
    expect(await reg.execute('gather', { resource: 'iron-ore' }, null, {})).toBe('failed: no path to the iron-ore')
    const ac = new AbortController()
    ac.abort()
    const reg2 = createFactorioRegistry({ run: async () => { throw new Error('aborted') } })
    expect(await reg2.execute('come', {}, null, { signal: ac.signal })).toBe('aborted')
    const reg3 = createFactorioRegistry({ run: async () => { throw new Error('cmd got no answer from Factorio in 8s') } })
    expect(await reg3.execute('come', {}, null, {})).toMatch(/^failed: cmd got no answer/)
  })

  it('rejects bad args before anything reaches the game', async () => {
    const run = vi.fn()
    const reg = createFactorioRegistry({ run })
    await expect(reg.execute('defend', { stance: 'berserk' }, null, {})).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
