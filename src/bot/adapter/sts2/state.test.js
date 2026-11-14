import { describe, it, expect } from 'vitest'
import { renderSeiState, clipUpstreamState, actionSignature, findCard, findEnemy, resolveArgs } from './state.js'

const STATE = {
  screen: 'combat',
  run: { act: 1, floor: 3 },
  me: { character: 'The Ironclad', hp: 60, max_hp: 80, block: 5, gold: 120, energy: 2, max_energy: 3, potions: [{ name: 'Block Potion' }], relics: ['Burning Blood'], deck: 12 },
  allies: [{ name: 'Tester', character: 'The Silent', hp: 30, max_hp: 70, is_player: true, ended_turn: true }],
  enemies: [{ name: 'Louse', hp: 10, max_hp: 12, intent: 'Attack 6' }, { name: 'Louse', hp: 8, max_hp: 12, intent: 'Buff' }, { name: 'Jaw Worm', hp: 0, max_hp: 40 }],
  hand: [{ name: 'Strike', cost: 1, type: 'attack', target: 'enemy', desc: 'Deal 6 damage.' }, { name: 'Bash', cost: 2, type: 'attack', target: 'enemy', playable: false }, { name: 'Strike+', cost: 1, type: 'attack', target: 'enemy' }, { name: 'Defend', cost: 1, type: 'skill' }],
  piles: { draw: 4, discard: 2, exhaust: 0 },
}
const PLAY = { name: 'play_card', schema: { type: 'object', properties: { card_index: { type: 'integer' }, enemy_index: { type: 'integer' }, ally_index: { type: 'integer' } }, required: ['card_index'] } }

describe('renderSeiState', () => {
  it('words the fight compactly with indexes', () => {
    const text = renderSeiState(STATE).join('\n')
    expect(text).toContain('screen: combat (act 1, floor 3)')
    expect(text).toContain('you: The Ironclad, 60/80 hp, block 5, gold 120, energy 2/3')
    expect(text).toContain('the player Tester (The Silent): 30/70 hp, turn ended')
    expect(text).toContain('[1] Louse: 8/12 hp, intends Buff')
    expect(text).toContain('[1] Bash (2, attack, enemy) (cannot play now)')
    expect(text.length).toBeLessThan(1200)
  })

  it('clips the upstream markdown and drops BBCode', () => {
    expect(clipUpstreamState('[gold]Hi[/gold]\n\n\n\nthere')).toBe('Hi\n\nthere')
    expect(clipUpstreamState('x'.repeat(5000), 100)).toMatch(/clipped/)
  })

  it('signs an action with its arguments', () => {
    expect(actionSignature(PLAY)).toBe('play_card(card_index*, enemy_index, ally_index)')
    expect(actionSignature({ name: 'end_turn' })).toBe('end_turn()')
  })
})

describe('name resolution', () => {
  it('finds cards by name, playable copies first, upgrades included', () => {
    expect(findCard(STATE.hand, 'strike')).toEqual({ index: 0 })
    expect(findCard(STATE.hand, 'Strike+')).toEqual({ index: 2 })
    expect(findCard(STATE.hand, 'def')).toEqual({ index: 3 })
    expect(findCard(STATE.hand, 'Cleave').error).toMatch(/no Cleave/)
  })

  it('finds enemies by name and ordinal, skipping the dead', () => {
    expect(findEnemy(STATE.enemies, 'Louse')).toEqual({ index: 0 })
    expect(findEnemy(STATE.enemies, 'louse 2')).toEqual({ index: 1 })
    expect(findEnemy(STATE.enemies, 'Jaw Worm').error).toBeTruthy()
    expect(findEnemy(STATE.enemies, 1)).toEqual({ index: 1 })
  })

  it('maps card/target names onto the action args', () => {
    expect(resolveArgs(PLAY, { card: 'Strike', target: 'Louse 2' }, STATE)).toEqual({ data: { card_index: 0, enemy_index: 1 } })
    expect(resolveArgs(PLAY, { card: 'Defend', target: 'Tester' }, STATE)).toEqual({ data: { card_index: 3, ally_index: 0 } })
    expect(resolveArgs(PLAY, { card_index: '2' }, STATE)).toEqual({ data: { card_index: 2 } })
    expect(resolveArgs(PLAY, {}, STATE).error).toMatch(/needs card_index/)
    expect(resolveArgs(PLAY, { card: 'Cleave' }, STATE).error).toMatch(/Your hand: Strike, Bash/)
    expect(resolveArgs(PLAY, { card: 'Strike' }, null).error).toMatch(/index/)
  })
})

describe('potions and intents (Sei mod contract)', () => {
  const POTION = { name: 'use_potion', schema: { type: 'object', properties: { potion_index: { type: 'integer' }, enemy_index: { type: 'integer' } }, required: ['potion_index'] } }
  const st = { ...STATE, me: { ...STATE.me, potions: [{ name: '(empty slot)', empty: true }, { name: 'Fire Potion' }] }, enemies: [{ name: 'Louse', hp: 10, max_hp: 12, intent: `Attack: ${'x'.repeat(120)}` }] }

  it('skips empty slots in the list but keeps the game indexes', () => {
    const text = renderSeiState(st).join('\n')
    expect(text).toContain('your potions: [1] Fire Potion')
    expect(text).not.toContain('empty slot')
    expect(resolveArgs(POTION, { potion: 'fire' }, st)).toEqual({ data: { potion_index: 1 } })
    expect(resolveArgs(POTION, { potion: '(empty' }, st).error).toMatch(/no potion/)
  })

  it('keeps long intents (the mod sends Title: Description)', () => {
    expect(renderSeiState(st).join('\n')).toContain(`intends Attack: ${'x'.repeat(100)}`)
  })
})
