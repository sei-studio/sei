// Activity-label mapping for the Minecraft dashboard (260721): registered
// tool name + args → lowercase natural-language line. Pins the exact copy
// style ("mining stone...", trailing dots, no em dashes) and the humanized
// fallback for unknown tools.

import { describe, it, expect } from 'vitest'
import { activityLabel } from './activityLabel.js'

describe('activityLabel', () => {
  it('is "idling" when no tool is dispatching', () => {
    expect(activityLabel(null)).toBe('idling')
    expect(activityLabel(undefined)).toBe('idling')
    expect(activityLabel('')).toBe('idling')
  })

  it('is "thinking" while a player message is being processed (260725)', () => {
    expect(activityLabel('thinking')).toBe('thinking')
  })

  it('maps dig with a block arg to "mining <block>..."', () => {
    expect(activityLabel('dig', { block: 'stone' })).toBe('mining stone...')
    expect(activityLabel('dig', { target: 'minecraft:iron_ore' })).toBe('mining iron ore...')
    expect(activityLabel('dig', { x: 1, y: 2, z: 3 })).toBe('mining...')
  })

  it('maps follow to "following you..."', () => {
    expect(activityLabel('follow')).toBe('following you...')
  })

  it('maps goTo coordinates to "walking to x, z..."', () => {
    expect(activityLabel('goTo', { x: 12.7, y: 64, z: -3.2 })).toBe('walking to 13, -3...')
    expect(activityLabel('goTo', {})).toBe('walking somewhere...')
  })

  it('maps gather / find / craft with their subject (gather pluralizes)', () => {
    expect(activityLabel('gather', { name: 'oak_log' })).toBe('gathering oak logs...')
    expect(activityLabel('gather', { name: 'glass' })).toBe('gathering glass...')
    expect(activityLabel('find', { name: 'diamond_ore' })).toBe('looking for diamond ore...')
    expect(activityLabel('craft', { item: 'crafting_table' })).toBe('crafting crafting table...')
  })

  it('groups the furnace and container tool families', () => {
    for (const n of ['openFurnace', 'smeltInput', 'addFuel', 'takeSmelted']) {
      expect(activityLabel(n)).toBe('smelting...')
    }
    for (const n of ['openContainer', 'depositItem', 'withdrawItem']) {
      expect(activityLabel(n)).toBe('checking a chest...')
    }
  })

  it('humanizes unknown tool names instead of breaking', () => {
    expect(activityLabel('someNewTool')).toBe('some new tool...')
    expect(activityLabel('snake_case_tool')).toBe('snake case tool...')
  })

  it('never emits an em dash (user copy rule)', () => {
    const samples = [
      activityLabel('dig', { block: 'stone' }),
      activityLabel('goTo', { x: 1, z: 2 }),
      activityLabel('weirdUnknownAction'),
      activityLabel(null),
    ]
    for (const s of samples) expect(s.includes('—')).toBe(false)
  })
})
