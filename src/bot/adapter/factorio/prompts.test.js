import { describe, it, expect } from 'vitest'
import * as P from './prompts.js'
import { VERB_NAMES } from './registry.js'

const strings = Object.entries(P).filter(([, v]) => typeof v === 'string')
const descriptions = Object.entries(P.ACTION_DESCRIPTIONS)

describe('factorio prompts', () => {
  it('uses no em dashes in any model-facing or player-facing text', () => {
    for (const [name, text] of [...strings, ...descriptions]) expect(text, name).not.toContain('—')
  })

  it('describes every tool and nothing else', () => {
    expect(Object.keys(P.ACTION_DESCRIPTIONS).sort()).toEqual([...VERB_NAMES].sort())
    for (const name of VERB_NAMES) expect(P.describeAction(name).length).toBeGreaterThan(20)
  })

  it('fills every placeholder in the event addenda', () => {
    const cases = [
      ['sei:idle', { quietMs: 45_000 }],
      ['sei:idle', {}],
      ['sei:loop_end', {}],
      ['sei:attacked', { attackerKind: 'mob', attackerLabel: 'small biter', health: 70, fighting: true }],
      ['sei:attacked', { attackerKind: 'reflex', survivalKind: 'fight', detail: '3 small biters attacking', nearOwner: true }],
      ['sei:attacked', { attackerKind: 'reflex', survivalKind: 'critical_retreat', attackerLabel: 'medium biter', health: 30 }],
      ['sei:attacked', { attackerKind: 'reflex', survivalKind: 'safe', health: 65 }],
      ['sei:attacked', { attackerKind: 'reflex', survivalKind: 'no_ammo', attackerLabel: 'small biter' }],
      ['sei:death', { detail: { cause: 'small spitter', at: [3.2, 4.7], respawnS: 10 } }],
      ['sei:death', {}],
    ]
    for (const [ev, data] of cases) {
      const text = P.eventAddendum(ev, data)
      expect(text.length, ev).toBeGreaterThan(20)
      expect(text, `${ev} ${JSON.stringify(data)}`).not.toMatch(/\{[a-z]+\}/)
    }
    expect(P.eventAddendum('sei:death', { detail: { cause: 'small spitter', at: [3.2, 4.7] } })).toContain('(killed by small spitter)')
    expect(P.eventAddendum('sei:idle', { quietMs: 120_000 })).toContain('about 2 min')
    expect(P.eventAddendum('sei:unknown', {})).toBe('')
  })

  it('keeps the always-on blocks small (they ride every turn)', () => {
    const fixed = P.worldPrimer() + P.capabilityParagraph() + P.actionRules() + P.FACTORIO_BASELINE
    // About 8k characters today; Stardew's equivalent is about 12.8k.
    expect(fixed.length).toBeLessThan(9000)
  })
})
