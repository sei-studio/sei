// 260730 — the owner-under-attack wire.
//
// combat.js emits sei:owner_attacked; this pins the three things the rest of
// the brain keys off it: the translated shape, the priority tier, and the
// prompt framing. See combat.defend.test.js for the behavior that produces it.

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireBotEvents } from './fsmWires.js'
import { eventAddendum } from './prompts.js'
import { attackedPriority, Priority } from '../../brain/fsm.js'

describe('sei:owner_attacked wiring', () => {
  it('translates onto the onAttacked route tagged defend', () => {
    const bot = new EventEmitter()
    const onAttacked = vi.fn()
    const dispose = wireBotEvents(bot, { onAttacked })
    bot.emit('sei:owner_attacked', {
      attacker: { id: 7, name: 'zombie' },
      attackerLabel: 'zombie',
      attackerKind: 'defend',
      ownerLabel: 'Shawn',
      distance: 4,
      engaged: true,
    })
    expect(onAttacked).toHaveBeenCalledTimes(1)
    expect(onAttacked.mock.calls[0][0]).toMatchObject({
      attackerKind: 'defend',
      attackerLabel: 'zombie',
      ownerLabel: 'Shawn',
      distance: 4,
      engaged: true,
    })
    dispose()
  })

  it('dispose() removes the listener', () => {
    const bot = new EventEmitter()
    const onAttacked = vi.fn()
    wireBotEvents(bot, { onAttacked })()
    bot.emit('sei:owner_attacked', { attackerLabel: 'zombie' })
    expect(onAttacked).not.toHaveBeenCalled()
  })

  // The bot is not the one in danger, and the swing that moves the aggro has
  // already happened without asking the model. Routing this at P0 would let a
  // zombie nibbling the player abort the reply they are waiting on.
  it('is conversation-tier, not safety-tier', () => {
    expect(attackedPriority({ attackerKind: 'defend' })).toBe(Priority.P1_CHAT)
    expect(attackedPriority({ attackerKind: 'hostile_mob' })).toBe(Priority.P0_SAFETY)
  })
})

describe('defend prompt framing', () => {
  const data = (engaged) => ({
    attackerLabel: 'zombie',
    attackerKind: 'defend',
    ownerLabel: 'Shawn',
    distance: 4,
    engaged,
  })

  it('the engaged variant says the swinging is already happening', () => {
    const t = eventAddendum('sei:attacked', data(true))
    expect(t).toContain('Shawn')
    expect(t).toContain('zombie')
    expect(t).toContain('4 blocks')
    expect(t).toMatch(/ALREADY swinging/)
    expect(t).toMatch(/turn on YOU/)
    // It must not tell the model to re-issue the swing the body is running.
    expect(t).toMatch(/do not need to call attackEntity/i)
  })

  it('the held variant asks for a decision instead', () => {
    const t = eventAddendum('sei:attacked', data(false))
    expect(t).toMatch(/NOT engaging it automatically/)
    expect(t).toMatch(/attackEntity/)
    expect(t).toMatch(/Do not just narrate/)
  })

  it('a missing distance just drops the clause', () => {
    const t = eventAddendum('sei:attacked', { ...data(true), distance: null })
    expect(t).not.toContain('blocks from you')
    expect(t).toContain('zombie')
  })
})
