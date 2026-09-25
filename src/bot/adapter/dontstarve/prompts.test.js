import { describe, it, expect } from 'vitest'
import {
  eventAddendum, worldPrimer, DST_BASELINE, DST_BASELINE_CAPS, dstBaseline, ACTION_DESCRIPTIONS,
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
    for (const name of reg.list()) expect(ACTION_DESCRIPTIONS[name], name).toBeTruthy()
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

  it('states the real recipes and no bare-handed chop claim', () => {
    const all = [worldPrimer(''), ACTION_RULES, ACTION_RULES_CAPS, CAPABILITY_PARAGRAPH_CAPS, ...Object.values(ACTION_DESCRIPTIONS)].join('\n')
    expect(all).not.toMatch(/3 logs/)
    expect(all).toMatch(/3 grass \+ 2 logs/)
    expect(ACTION_DESCRIPTIONS.chop).not.toMatch(/bare-handed/)
  })

  it('keeps the model-facing prose free of em dashes', () => {
    const all = [DST_BASELINE_CAPS, CAPABILITY_PARAGRAPH_CAPS, ACTION_RULES_CAPS, ...Object.values(ACTION_DESCRIPTIONS),
      eventAddendum('sei:idle', { reason: 'alert', alert: 'dusk_no_light', text: 'x' }, { hasCaps: true }),
      eventAddendum('sei:attacked', { attackerKind: 'defend', attackerLabel: 'spider' }, { hasCaps: true })].join('\n')
    expect(all).not.toContain('\u2014')
  })

  it('0.3.0 event prose: defend, alerts as wakes and as idle nudges, a hopeless dark, habit-aware idle', () => {
    const caps = { hasCaps: true }
    expect(eventAddendum('sei:attacked', { attackerKind: 'defend', attackerLabel: 'spider', player: 'Steve' }, caps)).toMatch(/spider went for Steve, and your body is fighting it/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'alert', alert: 'starving', alertText: 'you are starving (hunger 9%) and carry nothing you can eat' }, caps))
      .toMatch(/^Heads up: you are starving .*Food comes first/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' }, caps)).toMatch(/nothing to make light with/)
    expect(eventAddendum('sei:attacked', { attackerKind: 'reflex', survivalKind: 'dark', phase: 'night' })).toMatch(/AUTOMATICALLY walking toward/)
    const nudge = eventAddendum('sei:idle', { quietMs: 5000, reason: 'alert', alert: 'player_hungry_2001', text: 'Steve is hungry (20%)' }, caps)
    expect(nudge).toMatch(/Your body handles light, fuel, eating and healing/)
    expect(nudge).toMatch(/Heads up: Steve is hungry \(20%\)\. If you carry food they can eat, give\(\) them some/)
    expect(eventAddendum('sei:idle', { quietMs: 5000, reason: 'alert', alert: 'season_autumn_19', text: 'winter starts in 2 days' }, caps)).toMatch(/winter wants a warm hat/)
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
