import { describe, it, expect } from 'vitest'
import { repeatedBit, stillRepeats, whereIsShe, playerAsk } from './playerBrain.mjs'

const T = (s) => 1_000_000 + s * 1000
const own = [[100, 'ok thx sui. stay close pls'], [112, 'ok sui. stay close pls, im scared'], [150, 'eating bread now']]
  .map(([t, text]) => ({ at: T(t), text }))

describe('repeatedBit', () => {
  const o = (extra) => ({ now: T(160), lastHerLineAt: T(155), dist: 2, names: ['Sui', 'Alex'], ...extra })
  it('flags a bit said twice already, answered, with her close by', () => {
    expect(repeatedBit('ok sui thx. stay close pls, still eating', own, o())).toEqual({ bit: 'stay close', times: 2 })
  })
  it('lets it through when she is far off, has not answered, or the earlier asks are old', () => {
    expect(repeatedBit('stay close pls', own, o({ dist: 9 }))).toBeNull()
    expect(repeatedBit('stay close pls', own, o({ dist: null }))).toBeNull()
    expect(repeatedBit('stay close pls', own, o({ lastHerLineAt: T(110) }))).toBeNull()
    expect(repeatedBit('stay close pls', own, o({ now: T(300) }))).toBeNull()
    expect(repeatedBit('stay close pls', own.slice(0, 1), o())).toBeNull()
  })
  it('checks a redo for the same bit', () => {
    expect(stillRepeats('ok but stay close', { bit: 'stay close' })).toBe(true)
    expect(stillRepeats('glad ur here', { bit: 'stay close' })).toBe(false)
  })
})

describe('player turn text', () => {
  it('says she is right next to you within 3 blocks, and lists the own lines', () => {
    expect(whereIsShe('Sui', 2.4)).toBe('Sui is right next to you (2 blocks).')
    expect(whereIsShe('Sui', 9)).toBe('Sui is 9 blocks from you.')
    const ask = playerAsk({ history: [], ownLines: own, botName: 'Sui', player: 'Alex', dist: 2, hp: 12, inv: 'bread x8', elapsedMin: '3.0', trigger: 'companion_spoke', now: T(160) })
    expect(ask).toContain('Your own last lines:\n- 60s ago: ok thx sui. stay close pls')
    expect(ask.endsWith('Call player_turn.')).toBe(true)
  })
})
