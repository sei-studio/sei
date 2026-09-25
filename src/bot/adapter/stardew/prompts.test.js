import { describe, it, expect } from 'vitest'
import { eventAddendum, ACTION_DESCRIPTIONS, STARDEW_BASELINE, WORLD_PRIMER, CAPABILITY_PARAGRAPH, ACTION_RULES, ACTION_RULES_LEGACY, SESSION_END_CLAUSE, actionRules } from './prompts.js'
import { modVersionAtLeast, modHoldsFollow } from './modVersion.js'
import { VERB_NAMES } from './registry.js'

describe('stardew prompts', () => {
  it('carries the say() scratchpad contract and names every verb family', () => {
    expect(STARDEW_BASELINE).toMatch(/Others cannot see your text output by default/)
    expect(STARDEW_BASELINE).toMatch(/say\(\)/)
    expect(STARDEW_BASELINE).toMatch(/Stardew Valley/)
    for (const v of ['goTo', 'water', 'plant', 'harvest', 'chop', 'mine', 'gather', 'attack', 'fish', 'sleep']) {
      expect(STARDEW_BASELINE).toContain(v)
    }
  })

  it('primer says the farm is the player\'s and the companion asks before planting over their plans', () => {
    expect(WORLD_PRIMER).toMatch(/it is THEIRS/)
    expect(WORLD_PRIMER).toMatch(/Ask before planting/)
    expect(WORLD_PRIMER).toMatch(/2:00 AM/)
    expect(CAPABILITY_PARAGRAPH).toMatch(/OWN gold/)
    expect(CAPABILITY_PARAGRAPH).toMatch(/cannot see the game as an image/)
    expect(ACTION_RULES).toMatch(/#N handle/)
    expect(SESSION_END_CLAUSE).toMatch(/quit_game/)
  })

  it('describes follow as a standing order that a trip only puts on hold', () => {
    // 260924 playtest: the old rule said a goTo to another map ENDS following,
    // matching the mod; both now hold it until the player moves on.
    expect(ACTION_RULES).toMatch(/follow is a standing order/)
    expect(ACTION_RULES).toMatch(/puts it on hold/)
    expect(ACTION_RULES).toMatch(/lasts through the night/)
    expect(ACTION_RULES).not.toMatch(/ends following for you/)
    // The model walked into the player with goTo(their x,y) three times.
    expect(ACTION_RULES).toMatch(/never goTo with their coordinates/)
    expect(ACTION_RULES).not.toMatch(/\u2014/)
  })

  it('keeps the old following rule for a mod that still ends follow on a trip', () => {
    // The bundled DLL is rebuilt on a Mac after this ships: until then the
    // mod clears follow on a warp, so the model must still re-call follow.
    expect(ACTION_RULES_LEGACY).toMatch(/ends following for you/)
    expect(ACTION_RULES_LEGACY).not.toMatch(/standing order|puts it on hold/)
    expect(ACTION_RULES_LEGACY).not.toMatch(/\{following_rule\}/)
    expect(ACTION_RULES).not.toMatch(/\{following_rule\}/)
    // The stuck advice is true for every mod.
    expect(ACTION_RULES_LEGACY).toMatch(/never goTo with their coordinates/)
    expect(actionRules('0.1.1')).toBe(ACTION_RULES_LEGACY)
    expect(actionRules('0.1.0')).toBe(ACTION_RULES_LEGACY)
    expect(actionRules(null)).toBe(ACTION_RULES_LEGACY)
    expect(actionRules(undefined)).toBe(ACTION_RULES_LEGACY)
    expect(actionRules('0.1.2')).toBe(ACTION_RULES)
    expect(actionRules('0.2.0')).toBe(ACTION_RULES)
  })

  it('compares mod versions numerically', () => {
    expect(modVersionAtLeast('0.1.10', '0.1.2')).toBe(true)
    expect(modVersionAtLeast('0.1.2', '0.1.2')).toBe(true)
    expect(modVersionAtLeast('0.1.2-beta.1', '0.1.2')).toBe(true)
    expect(modVersionAtLeast('1.0', '0.1.2')).toBe(true)
    expect(modVersionAtLeast('0.1.1', '0.1.2')).toBe(false)
    expect(modVersionAtLeast('0.0.9', '0.1.2')).toBe(false)
    expect(modVersionAtLeast('', '0.1.2')).toBe(false)
    expect(modVersionAtLeast('garbage', '0.1.2')).toBe(false)
    expect(modHoldsFollow(null)).toBe(false)
  })

  it('has a description for every registry verb and no verb without one', () => {
    expect(Object.keys(ACTION_DESCRIPTIONS).sort()).toEqual([...VERB_NAMES].sort())
  })

  it('frames every event the wires raise, and nothing else', () => {
    expect(eventAddendum('sei:idle', { quietMs: 45_000 })).toMatch(/IDLE TICK\. The farm has been quiet for about 45s/)
    expect(eventAddendum('sei:idle', { quietMs: 180_000 })).toMatch(/about 3 min/)
    expect(eventAddendum('sei:idle', {})).toMatch(/water what is dry/)
    expect(eventAddendum('sei:loop_end', {})).toMatch(/LOOP END/)
    const hit = eventAddendum('sei:attacked', { attackerKind: 'mob', attackerLabel: 'Green Slime', health: 80, maxHealth: 100, retaliated: true })
    expect(hit).toMatch(/Green Slime hit you \(80\/100 health\)/)
    expect(hit).toMatch(/already swung back/)
    const retreat = eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'critical_retreat', attackerLabel: 'Bat', health: 20, maxHealth: 100 })
    expect(retreat).toMatch(/health is LOW \(20\/100\)/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'ate', detail: 'ate Leek' })).toMatch(/ate Leek/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'bedtime' })).toMatch(/2 AM/)
    expect(eventAddendum('sei:death', { cause: 'Bat', where: 'UndergroundMine12' })).toMatch(/KNOCKED OUT by Bat in UndergroundMine12/)
    expect(eventAddendum('sei:death', { lastAttack: { label: 'Green Slime' } })).toMatch(/by Green Slime/)
    expect(eventAddendum('sei:something_else', {})).toBe('')
  })
})
