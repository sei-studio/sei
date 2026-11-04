// 261104: quality pass 41. "thanks for the help" got "you're the one who got
// the wood and the table" (and "gave me the pickaxe", "found the coal") in 3
// of 15 work_session runs, after she gathered, crafted and placed all of it
// herself. The transcript's closing line now lists her own work.

import { describe, it, expect } from 'vitest'
import { createHandOverLedger } from './sessionEvents.js'
import { createConvoMemory } from './convoMemory.js'
import { resolveAdapterCaps } from './adapterDefaults.js'
import { createMinecraftAdapter } from '../adapter/minecraft/index.js'
import { ownWorkDetail } from '../adapter/minecraft/observers/ownWork.js'

describe('ownWorkDetail (Minecraft)', () => {
  it('reads the success lines of her own work', () => {
    expect(ownWorkDetail('gather', 'gathered 8/8 oak_log')).toEqual({ verb: 'gathered', item: 'oak_log', n: 8 })
    expect(ownWorkDetail('gather', 'gathered 8/8 cobblestone (mined from stone)')).toEqual({ verb: 'gathered', item: 'cobblestone', n: 8 })
    expect(ownWorkDetail('gather', 'aborted after 6/8 oak_log')).toEqual({ verb: 'gathered', item: 'oak_log', n: 6 })
    expect(ownWorkDetail('craft', 'crafted 1 crafting_table, made 4 oak_planks for it first; it is in your inventory'))
      .toEqual({ verb: 'crafted', item: 'crafting_table', n: 1 })
    expect(ownWorkDetail('craft', 'crafted 2 stick, not 4: the server undid the rest (you have 2 stick)'))
      .toEqual({ verb: 'crafted', item: 'stick', n: 2 })
    expect(ownWorkDetail('takeSmelted', 'took 3 iron_ingot (2 raw_iron still cooking)')).toEqual({ verb: 'smelted', item: 'iron_ingot', n: 3 })
    expect(ownWorkDetail('placeBlock', 'placed crafting_table on grass_block @185,70,-3')).toEqual({ verb: 'placed', item: 'crafting_table', n: 1 })
    expect(ownWorkDetail('dig', 'dug stone')).toEqual({ verb: 'dug', item: 'stone', n: 1 })
    expect(ownWorkDetail('dig', 'dug coal_ore (pickup walk did not reach)')).toEqual({ verb: 'dug', item: 'coal_ore', n: 1 })
    expect(ownWorkDetail('attackEntity', 'killed zombie (4 hits)')).toEqual({ verb: 'killed', item: 'zombie', n: 1 })
  })

  it('adds nothing for failures, zero counts and other actions', () => {
    expect(ownWorkDetail('gather', 'gathered 0/8 oak_log: every oak_log nearby is one you could not reach')).toBeNull()
    expect(ownWorkDetail('gather', 'no oak_log in loaded chunks')).toBeNull()
    expect(ownWorkDetail('dig', 'dug 5/9')).toBeNull()
    expect(ownWorkDetail('attackEntity', 'aborted after 2/5 hits on zombie')).toBeNull()
    expect(ownWorkDetail('attackEntity', 'lost sight of zombie: it moved out of range')).toBeNull()
    expect(ownWorkDetail('give', 'gave 6 oak_log to Alex, tossed at their feet')).toBeNull()
    expect(ownWorkDetail('craft', 'cannot craft stone_pickaxe: missing 3 cobblestone')).toBeNull()
    expect(ownWorkDetail('craft', undefined)).toBeNull()
  })

  it('is wired as an adapter member, and absent by default', () => {
    const a = createMinecraftAdapter({ bot: {}, config: {} })
    expect(resolveAdapterCaps(a).ownWorkDetail('gather', 'gathered 3/3 coal (mined from coal_ore)'))
      .toEqual({ verb: 'gathered', item: 'coal', n: 3 })
    expect(resolveAdapterCaps({}).ownWorkDetail).toBeNull()
  })
})

describe('the who-did-what line', () => {
  it('lists her own work by kind, in the order she first did it', () => {
    const l = createHandOverLedger()
    l.did({ verb: 'gathered', item: 'oak_log', n: 8 })
    l.did({ verb: 'crafted', item: 'crafting_table', n: 1 })
    l.did({ verb: 'placed', item: 'crafting_table', n: 1 })
    l.did({ verb: 'crafted', item: 'wooden_pickaxe', n: 1 })
    l.did({ verb: 'gathered', item: 'oak_log', n: 1 })
    l.did(null)
    l.did({ verb: 'crafted', item: 'stick', n: 0 })
    expect(l.describe()).toBe(
      'Who did what this session. You did these yourself: gathered 9 oak_log; crafted 1 crafting_table and 1 wooden_pickaxe; placed 1 crafting_table. ' +
      'You have not given anything to anyone. Everything you did not give away is still yours unless you used it up, placed it or dropped it. ' +
      'The inventory in your snapshot is yours; you cannot see what the player carries.')
  })

  it('names no work when there was none', () => {
    expect(createHandOverLedger().describe()).not.toContain('You did these yourself')
  })

  it('closes the transcript with her work and her gives', () => {
    const m = createConvoMemory({ trackHandOvers: true })
    m.recentChat.pushPlayer('Alex', 'thanks for the help')
    m.recentChat.noteDone({ verb: 'gathered', item: 'oak_log', n: 8 })
    m.recentChat.noteGiven({ item: 'oak_log', n: 6, to: 'Alex' })
    expect(m.recentChat.formatConversationBlock().trim().split('\n').pop())
      .toMatch(/^Who did what this session\. You did these yourself: gathered 8 oak_log\. You gave player \(Alex\) 6 oak_log\./)
  })
})

describe('the who-did-what line in a long session', () => {
  it('shows the newest kinds of each work and says there was more', () => {
    const l = createHandOverLedger()
    for (const item of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) l.did({ verb: 'crafted', item, n: 1 })
    l.did({ verb: 'crafted', item: 'a', n: 2 })
    expect(l.describe()).toContain('You did these yourself: crafted 1 c, 1 d, 1 e, 1 f, 1 g, 3 a and more.')
  })
})
