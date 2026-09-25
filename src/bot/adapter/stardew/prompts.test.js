import { describe, it, expect } from 'vitest'
import { eventAddendum, ACTION_DESCRIPTIONS, STARDEW_BASELINE, WORLD_PRIMER, CAPABILITY_PARAGRAPH, CAPABILITY_PARAGRAPH_CHORES, ACTION_RULES, ACTION_RULES_CHORES, ACTION_RULES_LEGACY, SESSION_END_CLAUSE, actionRules, capabilityParagraph, describeAction } from './prompts.js'
import { modVersionAtLeast, modHoldsFollow, modHasChores } from './modVersion.js'
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
    expect(actionRules('0.1.3')).toBe(ACTION_RULES_CHORES)
    expect(actionRules('0.2.0')).toBe(ACTION_RULES_CHORES)
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

  it('describes farm-wide chores and the hand-off only to a 0.1.3 mod', () => {
    expect(modHasChores('0.1.3')).toBe(true)
    expect(modHasChores('0.1.2')).toBe(false)
    expect(modHasChores(null)).toBe(false)
    expect(ACTION_RULES_CHORES).toMatch(/water\(\{scope:"farm"\}\)/)
    expect(ACTION_RULES_CHORES).toMatch(/refills the can at the nearest water/)
    expect(ACTION_RULES_CHORES).toMatch(/Hand-off rule/)
    expect(ACTION_RULES_CHORES).toMatch(/Player activity rule/)
    expect(ACTION_RULES_CHORES).toMatch(/follow is a standing order/)
    // The 0.1.2 and older rules never mention verbs or fields that mod lacks.
    for (const rules of [ACTION_RULES, ACTION_RULES_LEGACY]) {
      expect(rules).not.toMatch(/ship\(\)|give\(|scope:"farm"|Player activity rule/)
      // The till patch is composed app-side, so every mod gets it.
      expect(rules).toMatch(/till\(\{x, y, width, height\}\)/)
      expect(rules).toMatch(/refills when you water\(\) a water tile/)
    }
    for (const text of [ACTION_RULES_CHORES, ACTION_RULES, ACTION_RULES_LEGACY, CAPABILITY_PARAGRAPH, CAPABILITY_PARAGRAPH_CHORES]) {
      expect(text).not.toMatch(/\{jobs_rule\}|\{handoff\}|\{following_rule\}/)
    }
    for (const text of [ACTION_RULES_CHORES, CAPABILITY_PARAGRAPH_CHORES]) {
      // New model-facing text follows the plain-prose rule.
      expect(text.replace(ACTION_RULES, '')).not.toMatch(/\u2014/)
    }
    expect(capabilityParagraph('0.1.3')).toBe(CAPABILITY_PARAGRAPH_CHORES)
    expect(capabilityParagraph('0.1.2')).toBe(CAPABILITY_PARAGRAPH)
    expect(CAPABILITY_PARAGRAPH_CHORES).toMatch(/shipping bin/)
    expect(CAPABILITY_PARAGRAPH).not.toMatch(/shipping bin, hand items/)
  })

  it('gates the water / harvest descriptions and describes the new verbs', () => {
    expect(describeAction('water', '0.1.3')).toMatch(/scope/)
    expect(describeAction('water', '0.1.2')).not.toMatch(/scope/)
    expect(describeAction('harvest', '0.1.3')).toMatch(/scope/)
    expect(describeAction('harvest', null)).not.toMatch(/scope/)
    expect(describeAction('till', null)).toMatch(/width/)
    expect(describeAction('ship', '0.1.3')).toMatch(/shipping bin/)
    expect(describeAction('give', '0.1.3')).toMatch(/player/)
    for (const name of ['till', 'water', 'harvest', 'ship', 'give']) {
      expect(describeAction(name, '0.1.3')).not.toMatch(/\u2014/)
    }
  })

  it('adds the player-activity nudge to an idle tick only when the wires name one', () => {
    const plain = eventAddendum('sei:idle', { quietMs: 10_000 })
    expect(plain).not.toMatch(/took out their/)
    const nudge = eventAddendum('sei:idle', { reason: 'player_activity', activity: 'watering', item: 'Watering Can' })
    expect(nudge).toMatch(/IDLE TICK/)
    expect(nudge).toMatch(/The player just took out their Watering Can, so they are probably watering\./)
    expect(nudge).toMatch(/other end of the field/)
    expect(nudge).not.toMatch(/\{item\}|\{activity\}|\{suggestion\}/)
    const other = eventAddendum('sei:idle', { reason: 'player_activity', activity: 'juggling', item: 'Ball' })
    expect(other).toMatch(/the same job beside them/)
    expect(eventAddendum('sei:idle', { reason: 'player_activity' })).not.toMatch(/took out their/)
  })
})
