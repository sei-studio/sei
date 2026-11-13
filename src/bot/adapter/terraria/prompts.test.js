// Terraria prompt blocks: plain text, no em dashes, every verb described, and
// the event addenda filled from the event data.
import { describe, it, expect } from 'vitest'
import * as P from './prompts.js'
import { VERB_NAMES } from './registry.js'

const allText = () => [
  P.TERRARIA_BASELINE, P.WORLD_PRIMER, P.CAPABILITY_PARAGRAPH, P.ACTION_RULES, P.SESSION_END_CLAUSE,
  P.ACTION_STUCK_NUDGE, P.IDLE_TICK_TEXT, P.LOOP_END_TEXT, P.ATTACKED_ADDENDUM, P.HEALED_ADDENDUM,
  P.RETREAT_ADDENDUM, P.LOW_HEALTH_ADDENDUM, P.DEATH_ADDENDUM, P.WORLD_EVENT_LINE,
  ...Object.values(P.ACTION_DESCRIPTIONS),
]

describe('terraria prompts', () => {
  it('has no em dashes and no unfilled placeholders after filling', () => {
    for (const t of allText()) expect(t).not.toContain('—')
    const filled = [
      P.eventAddendum('sei:idle', { quietMs: 45_000 }),
      P.eventAddendum('sei:attacked', { attackerLabel: 'Zombie', health: 40, maxHealth: 100 }),
      P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'critical_retreat', health: 20, maxHealth: 100 }),
      P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'low_health', potions: 0, health: 25, maxHealth: 100 }),
      P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'healed', detail: 'Lesser Healing Potion', health: 80, maxHealth: 100 }),
      P.eventAddendum('sei:death', { cause: 'Eye of Cthulhu' }),
      P.worldEventLine('A Blood Moon is rising.'),
    ]
    for (const t of filled) expect(t).not.toMatch(/\{[a-zA-Z]+\}/)
  })

  it('describes every verb and nothing else', () => {
    expect(Object.keys(P.ACTION_DESCRIPTIONS).sort()).toEqual([...VERB_NAMES].sort())
    expect(P.describeAction('mine')).toBe(P.ACTION_DESCRIPTIONS.mine)
    expect(P.describeAction('fish')).toBe('')
  })

  it('fills the event addenda from the event', () => {
    expect(P.eventAddendum('sei:attacked', { attackerLabel: 'Zombie', health: 40, maxHealth: 100 })).toContain('Zombie hit you (40/100 health)')
    expect(P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'low_health', potions: 2, health: 25, maxHealth: 100 })).toContain('2 healing potions left')
    expect(P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'low_health', potions: 0, health: 25, maxHealth: 100 })).toContain('no healing potions')
    expect(P.eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'critical_retreat', health: 20, maxHealth: 100 })).toContain('backing away')
    expect(P.eventAddendum('sei:death', { cause: 'Eye of Cthulhu' })).toContain('KNOCKED OUT by Eye of Cthulhu')
    expect(P.eventAddendum('sei:idle', { quietMs: 90_000 })).toContain('about 2 min')
    expect(P.eventAddendum('sei:loop_end')).toBe(P.LOOP_END_TEXT)
    expect(P.eventAddendum('sei:unknown')).toBe('')
  })

  it('keeps the static blocks short, since they ride on every turn', () => {
    const size = [P.TERRARIA_BASELINE, P.WORLD_PRIMER, P.CAPABILITY_PARAGRAPH, P.ACTION_RULES].join('').length
    expect(size).toBeLessThan(6000)
  })
})
