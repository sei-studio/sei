import { describe, it, expect } from 'vitest'
import {
  eventAddendum, worldPrimer, DST_BASELINE, DST_BASELINE_CAPS, dstBaseline, ACTION_DESCRIPTIONS, ACTION_DESCRIPTIONS_CAPS, describeAction, ALERT_HINTS,
  CAPABILITY_PARAGRAPH, CAPABILITY_PARAGRAPH_CAPS, capabilityParagraph, ACTION_RULES, ACTION_RULES_CAPS, actionRules,
} from './prompts.js'
import { createDefaultRegistry } from './registry.js'
import { createObservationState, createHandleRegistry } from './protocol.js'
import { EventEmitter } from 'node:events'

describe('DST prompts', () => {
  it('keeps the say() contract and describes every registered verb', () => {
    expect(DST_BASELINE).toMatch(/Others cannot see your text output by default/)
    expect(DST_BASELINE).toMatch(/say\(\)/)
    expect(DST_BASELINE).toMatch(/Don't Starve Together/)
    // With a 0.3.0 helper the registry is the full set (give included).
    const link = { events: new EventEmitter(), state: createObservationState(), handles: createHandleRegistry(), body: {}, playerName: () => null, send: async () => '', hasCaps: true }
    const reg = createDefaultRegistry({ link })
    for (const name of reg.list()) expect(describeAction(name, true), name).toBeTruthy()
    for (const name of Object.keys(ACTION_DESCRIPTIONS)) expect(reg.list(), name).toContain(name)
  })

  it('names give in the tool list only for a 0.3.0 helper', () => {
    expect(dstBaseline(false)).toBe(DST_BASELINE)
    expect(dstBaseline(true)).toBe(DST_BASELINE_CAPS)
    expect(DST_BASELINE).not.toMatch(/\bgive\b/)
    expect(DST_BASELINE_CAPS).toMatch(/drop, give\)/)
    expect(DST_BASELINE_CAPS).not.toContain('{tools}')
  })

  it('describes the habits and the planning split only for a 0.3.0 helper', () => {
    expect(capabilityParagraph(false)).toBe(CAPABILITY_PARAGRAPH)
    expect(capabilityParagraph(true)).toBe(CAPABILITY_PARAGRAPH_CAPS)
    expect(CAPABILITY_PARAGRAPH_CAPS).toMatch(/Late in dusk it makes a torch/)
    expect(CAPABILITY_PARAGRAPH_CAPS).toMatch(/What the habits cannot do is plan/)
    expect(CAPABILITY_PARAGRAPH_CAPS).toMatch(/your_habits/)
    expect(CAPABILITY_PARAGRAPH_CAPS).toMatch(/heads_up/)
    expect(actionRules(false)).toBe(ACTION_RULES)
    expect(actionRules(true)).toBe(ACTION_RULES_CAPS)
    expect(ACTION_RULES_CAPS).toMatch(/give\(item\)/)
  })

  it('states the real recipes, and that chopping needs an axe on either helper', () => {
    const all = [worldPrimer(''), ACTION_RULES, ACTION_RULES_CAPS, CAPABILITY_PARAGRAPH_CAPS, ...Object.values(ACTION_DESCRIPTIONS_CAPS)].join('\n')
    expect(all).not.toMatch(/3 logs/)
    expect(all).toMatch(/3 grass \+ 2 logs/)
    // An older helper does not equip tools for the model.
    expect(describeAction('chop')).toMatch(/Equip an axe first; chopping bare-handed does nothing/)
    expect(describeAction('chop', false)).toBe(ACTION_DESCRIPTIONS.chop)
    // 0.3.0 equips the axe itself, still needs one, and keeps the torch in the dark.
    expect(describeAction('chop', true)).toMatch(/needs an axe in your inventory, which your body equips for you; without one the chop fails/)
    expect(describeAction('chop', true)).toMatch(/keeps the torch in hand/)
    expect(describeAction('give', true)).toMatch(/by exact name/)
    expect(describeAction('goTo', true)).toBe(ACTION_DESCRIPTIONS.goTo)
  })

  it('words alert hints as information, not orders', () => {
    for (const [k, v] of Object.entries(ALERT_HINTS)) {
      expect(v, k).not.toMatch(/\b(now|Tell the player|Say one short line|Talk it over)\b/)
      expect(v, k).not.toMatch(/^(Get|Cool|Pick|Food comes first)/)
    }
  })

  it('keeps the model-facing prose free of em dashes', () => {
    const all = [DST_BASELINE_CAPS, CAPABILITY_PARAGRAPH_CAPS, ACTION_RULES_CAPS, ...Object.values(ACTION_DESCRIPTIONS),
      eventAddendum('sei:idle', { reason: 'alert', alert: 'dusk_no_light', text: 'x' }, { hasCaps: true }),
      eventAddendum('sei:attacked', { attackerKind: 'defend', attackerLabel: 'spider' }, { hasCaps: true })].join('\n')
    expect(all).not.toContain('\u2014')
  })

  it('a hit by the darkness names Charlie, says running does not help, and counts the torch', () => {
    const caps = { hasCaps: true }
    const hit = { attackerKind: 'mob', attackerLabel: 'the darkness', darkness: true, healthPct: 0.33 }
    const partial = eventAddendum('sei:attacked', { ...hit, torchNeed: { grass: 0, twigs: 1, haveGrass: 2, haveTwigs: 1 } }, caps)
    expect(partial).toMatch(/^Interrupted: the darkness hit you \(33% health left\)\. That is Charlie/)
    expect(partial).toMatch(/running from it does not help/)
    expect(partial).toMatch(/you carry 2 grass and 1 twigs, so get 1 twig now/)
    expect(partial).toMatch(/Your body makes and lights the torch the moment you have them/)
    expect(partial).not.toMatch(/flee\(\)/)
    expect(partial).not.toContain('\u2014')
    expect(eventAddendum('sei:attacked', { ...hit, torchNeed: { grass: 2, twigs: 2, haveGrass: 0, haveTwigs: 0 } }, caps)).toMatch(/so get 2 grass and 2 twigs now/)
    expect(eventAddendum('sei:attacked', { ...hit, torchNeed: { grass: 0, twigs: 0, haveGrass: 3, haveTwigs: 2 } }, caps)).toMatch(/your body is making it now/)
    expect(eventAddendum('sei:attacked', { ...hit, torchNeed: { grass: 1, twigs: 0, haveGrass: 1, haveTwigs: 2 } })).toMatch(/Then craft\(torch\) and equip it/)
    // A monster still gets the monster text.
    expect(eventAddendum('sei:attacked', { attackerKind: 'mob', attackerLabel: 'hound', healthPct: 0.5 }, caps)).toMatch(/call flee\(\)/)
  })

  it('0.3.0 event prose: defend, alerts as wakes and as idle nudges, a hopeless dark, habit-aware idle', () => {
    const caps = { hasCaps: true }
    expect(eventAddendum('sei:attacked', { attackerKind: 'defend', attackerLabel: 'spider', player: 'Steve' }, caps)).toMatch(/spider went for Steve, and your body is fighting it/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'alert', alert: 'starving', alertText: 'you are starving (hunger 9%) and carry nothing you can eat' }, caps))
      .toMatch(/^Heads up: you are starving .*Berries and carrots are the quickest food/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' }, caps)).toMatch(/nothing to make light with/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' })).toMatch(/AUTOMATICALLY walking toward/)
    const nudge = eventAddendum('sei:idle', { quietMs: 5000, reason: 'alert', alert: 'player_hungry_2001', text: 'Steve is hungry (20%)' }, caps)
    expect(nudge).toMatch(/Your body handles light, fuel, eating and healing/)
    expect(nudge).toMatch(/Heads up: Steve is hungry \(20%\)\. give\(\) can hand them food you carry/)
    expect(eventAddendum('sei:idle', { quietMs: 5000, reason: 'alert', alert: 'season_autumn_19', text: 'winter starts in 2 days' }, caps)).toMatch(/Winter calls for a warm hat/)
    expect(eventAddendum('sei:idle', { quietMs: 5000, reason: 'phase_change', phase: 'dusk', day: 2 }, caps)).toMatch(/makes a torch late in dusk/)
    expect(eventAddendum('sei:idle', { quietMs: 5000 })).not.toMatch(/Your body handles/)
  })

  it('appends the chosen survivor to the primer', () => {
    expect(worldPrimer('')).toMatch(/darkness kills/i)
    expect(worldPrimer('You are playing as Wigfrid.')).toMatch(/\n\nYou are playing as Wigfrid\.$/)
    expect(CAPABILITY_PARAGRAPH).toMatch(/Reflexes run in your body/)
    expect(CAPABILITY_PARAGRAPH_CAPS).toMatch(/survival habits that run without you/)
    expect(ACTION_RULES).toMatch(/gather\(item, count\)/)
  })

  it('is the only source of event prose: idle, loop end, hits, reflexes, dark, death, unknown', () => {
    expect(eventAddendum('sei:idle', { quietMs: 45_000 })).toMatch(/quiet for about 45s/)
    expect(eventAddendum('sei:idle', { quietMs: 120_000, reason: 'phase_change', phase: 'dusk', day: 4 })).toMatch(/changed to dusk \(day 4\).*fire ready/)
    expect(eventAddendum('sei:loop_end', {})).toMatch(/LOOP END/)
    expect(eventAddendum('sei:attacked', { attackerLabel: 'spider', attackerKind: 'mob', healthPct: 0.7 })).toMatch(/spider hit you \(70% health left\)/)
    expect(eventAddendum('sei:attacked', { attackerLabel: 'Steve', attackerKind: 'player' })).toMatch(/never attack players/)
    expect(eventAddendum('sei:attacked', { attackerLabel: 'hound', attackerKind: 'reflex', survivalKind: 'critical_retreat' })).toMatch(/AUTOMATICALLY backing away/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' })).toMatch(/it is night/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'ate', item: 'berries' })).toMatch(/ate berries/)
    expect(eventAddendum('sei:death', { pos: { x: 3.4, z: -9.6 }, lastAttack: { label: 'spider' } })).toMatch(/last thing that hit you was spider.*~3,-10/)
    expect(eventAddendum('sei:enterdark', { phase: 'dusk' })).toMatch(/darkness \(dusk\)/)
    expect(eventAddendum('sei:something_else', {})).toBe('')
  })
})

describe('DST death turn after a respawn (261104)', () => {
  const base = { pos: { x: 3.4, z: -9.6 }, lastAttack: { label: 'Spider' } }
  it('respawned: names the cause, the player and the drop spot, asks for say() + remember()', () => {
    const t = eventAddendum('sei:death', { ...base, detail: { outcome: 'respawned', cause: 'Charlie in the darkness', respawns: 1, respawnsLeft: 2, player: 'Steve' } })
    expect(t).toMatch(/killed by Charlie in the darkness; the last thing that hit you was Spider/)
    expect(t).toMatch(/fresh body next to Steve/)
    expect(t).toMatch(/around 3,-10/)
    expect(t).toMatch(/say\(\)/)
    expect(t).toMatch(/remember\(\)/)
    expect(t).not.toMatch(/once more|last comeback/)
    expect(t).not.toMatch(/\u2014/)
    expect(t).not.toMatch(/\{\w+\}/)
  })

  it('respawned: warns when one comeback or none is left', () => {
    const one = eventAddendum('sei:death', { ...base, detail: { outcome: 'respawned', cause: 'starvation', respawns: 2, respawnsLeft: 1, player: 'Steve' } })
    expect(one).toMatch(/once more this session/)
    const none = eventAddendum('sei:death', { ...base, detail: { outcome: 'respawned', cause: 'starvation', respawns: 3, respawnsLeft: 0, player: 'Steve' } })
    expect(none).toMatch(/last comeback this session/)
  })

  it('final: says why she is not coming back, cap or bad spot', () => {
    const cap = eventAddendum('sei:death', { ...base, detail: { outcome: 'final', reason: 'cap', cause: 'freezing', respawns: 3, respawnsLeft: 0, player: 'Steve' } })
    expect(cap).toMatch(/not coming back this session: you already came back 3 times, which is the limit/)
    expect(cap).toMatch(/goodbye to Steve/)
    const bad = eventAddendum('sei:death', { ...base, detail: { outcome: 'final', reason: 'bad_spot', cause: null, respawns: 2, player: null } })
    expect(bad).toMatch(/twice in a row, so this spot is too dangerous/)
    expect(bad).toMatch(/the last thing that hit you was Spider/)
    expect(bad).toMatch(/goodbye to the player/)
    for (const t of [cap, bad]) {
      expect(t).not.toMatch(/\u2014/)
      expect(t).not.toMatch(/\{\w+\}/)
    }
  })
})
