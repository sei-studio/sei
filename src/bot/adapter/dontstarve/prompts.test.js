import { describe, it, expect } from 'vitest'
import { eventAddendum, worldPrimer, DST_BASELINE, ACTION_DESCRIPTIONS, CAPABILITY_PARAGRAPH, ACTION_RULES } from './prompts.js'
import { createDefaultRegistry } from './registry.js'
import { createObservationState, createHandleRegistry } from './protocol.js'
import { EventEmitter } from 'node:events'

describe('DST prompts', () => {
  it('keeps the say() contract and describes every registered verb', () => {
    expect(DST_BASELINE).toMatch(/Others cannot see your text output by default/)
    expect(DST_BASELINE).toMatch(/say\(\)/)
    expect(DST_BASELINE).toMatch(/Don't Starve Together/)
    const link = { events: new EventEmitter(), state: createObservationState(), handles: createHandleRegistry(), body: {}, playerName: () => null, send: async () => '' }
    const reg = createDefaultRegistry({ link })
    for (const name of reg.list()) expect(ACTION_DESCRIPTIONS[name], name).toBeTruthy()
    for (const name of Object.keys(ACTION_DESCRIPTIONS)) expect(reg.list(), name).toContain(name)
  })

  it('appends the chosen survivor to the primer', () => {
    expect(worldPrimer('')).toMatch(/darkness kills/i)
    expect(worldPrimer('You are playing as Wigfrid.')).toMatch(/\n\nYou are playing as Wigfrid\.$/)
    expect(CAPABILITY_PARAGRAPH).toMatch(/Reflexes run in your body/)
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
