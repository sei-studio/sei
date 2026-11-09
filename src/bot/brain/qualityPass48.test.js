// src/bot/brain/qualityPass48.test.js
//
// 261109 (pass 48): free-play wrong_or_hallucinated lines. say() is heard
// before the actions called with it run, and the drowning heads-up names the
// air she has left instead of offering "you nearly drowned".

import { describe, it, expect } from 'vitest'
import {
  PERSONALITY_TOOL_DESCRIPTIONS,
  SURVIVAL_ADDENDUM,
  SURVIVAL_ADDENDUM_DROWNING,
  eventAddendum,
} from './promptLibrary.js'

describe('say() timing', () => {
  it('says the line is heard before the actions called with it run', () => {
    expect(PERSONALITY_TOOL_DESCRIPTIONS.say).toContain('It is heard before any action you call with it runs')
    expect(PERSONALITY_TOOL_DESCRIPTIONS.say).toContain('use the count on your inventory line this turn')
    expect(PERSONALITY_TOOL_DESCRIPTIONS.say).not.toMatch(/—/)
  })
})

describe('drowning heads-up', () => {
  it('names the air left and offers coming up for air when air is not nearly gone', () => {
    const t = SURVIVAL_ADDENDUM('deep water', { survivalKind: 'drowning', air: 10 })
    expect(t).toContain('10 of 20 air left')
    expect(t).toContain('not a near-drowning')
    expect(t).not.toContain('nearly drowned')
    expect(t).not.toMatch(/—/)
  })

  it('keeps the old line when air is nearly gone or unknown', () => {
    expect(SURVIVAL_ADDENDUM('deep water', { survivalKind: 'drowning', air: 2 })).toBe(SURVIVAL_ADDENDUM_DROWNING)
    expect(SURVIVAL_ADDENDUM('deep water', { survivalKind: 'drowning' })).toBe(SURVIVAL_ADDENDUM_DROWNING)
  })

  it('reaches the turn through the reflex route', () => {
    const t = eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'drowning', attackerLabel: 'deep water', air: 17 })
    expect(t).toContain('17 of 20 air left')
  })
})
