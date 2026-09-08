// Game-adapters M0 (260908): the three Minecraft batch rules that moved out of
// the orchestrator (dig cap, follow+attackEntity collapse, cant_reach dedup).
import { describe, it, expect } from 'vitest'
import { prefilterToolBatch, postProcessToolBatch } from './toolBatch.js'

describe('prefilterToolBatch', () => {
  it('lets the first dig through and aborts the rest', () => {
    const out = prefilterToolBatch([
      { id: 'a', name: 'dig', input: {} },
      { id: 'b', name: 'dig', input: {} },
      { id: 'c', name: 'gather', input: {} },
      { id: 'd', name: 'dig', input: {} },
    ])
    expect(out.map((p) => p.id)).toEqual(['b', 'd'])
    expect(out[0].content).toMatch(/only one dig per turn/)
    expect(out[0].is_error).toBe(false)
  })

  it('collapses a follow that targets the same entity as an attackEntity in the batch', () => {
    const out = prefilterToolBatch([
      { id: 'f1', name: 'follow', input: { entity: '#3' } },
      { id: 'at', name: 'attackEntity', input: { target: '#3' } },
      { id: 'f2', name: 'follow', input: { entity: 'Steve' } },
    ])
    expect(out.map((p) => p.id)).toEqual(['f1'])
    expect(out[0].content).toMatch(/already pursuing/)
  })

  it('prefills nothing for an ordinary batch', () => {
    expect(prefilterToolBatch([{ id: 'x', name: 'goTo', input: {} }])).toEqual([])
  })
})

describe('postProcessToolBatch', () => {
  const nudge = ({ x, y, z, range }) => `NUDGE ${x},${y},${z} r${range}`
  const goTo = (id) => ({ id, name: 'goTo', input: { x: 1, y: 2, z: 3 } })
  const cantReach = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'cant_reach (5 blocks)' })

  it('nudges on the SECOND cant_reach for the same destination, once per loop', () => {
    const loopState = {}
    expect(postProcessToolBatch([goTo('1')], [cantReach('1')], loopState, nudge)).toEqual({ nudge: null })
    expect(postProcessToolBatch([goTo('2')], [cantReach('2')], loopState, nudge)).toEqual({ nudge: 'NUDGE 1,2,3 r1' })
    expect(postProcessToolBatch([goTo('3')], [cantReach('3')], loopState, nudge)).toEqual({ nudge: null })
  })

  it('ignores successes, other tools, and non-numeric destinations', () => {
    const loopState = {}
    const uses = [goTo('a'), { id: 'b', name: 'dig', input: {} }, { id: 'c', name: 'goTo', input: { x: 'far' } }]
    const results = [{ content: 'arrived' }, { content: 'cant_reach' }, { content: 'cant_reach' }]
    expect(postProcessToolBatch(uses, results, loopState, nudge)).toEqual({ nudge: null })
    expect(postProcessToolBatch(uses, results, loopState, nudge)).toEqual({ nudge: null })
  })
})
