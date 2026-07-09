// droppedItemName (260708) — dropped items must decode to their contents.
// The hand-rolled metadata scan never fired on 1.21.x (raw slot has no
// `.name`), so every drop rendered as an anonymous `item` and the bot could
// not find a cooked-beef gift (Lyra post-mortem). Primary path is now
// prismarine-entity's version-aware getDroppedItem(); the scan stays as a
// legacy fallback.

import { describe, it, expect } from 'vitest'
import { droppedItemName } from './entities.js'

describe('droppedItemName', () => {
  it('decodes via entity.getDroppedItem() with name and count', () => {
    const e = {
      name: 'item',
      getDroppedItem: () => ({ name: 'cooked_beef', count: 3 }),
    }
    expect(droppedItemName(e)).toEqual({ name: 'cooked_beef', count: 3 })
  })

  it('defaults a missing/invalid count to 1', () => {
    const e = { name: 'item', getDroppedItem: () => ({ name: 'stick' }) }
    expect(droppedItemName(e)).toEqual({ name: 'stick', count: 1 })
  })

  it('survives a throwing getDroppedItem (metadata not arrived) and falls back to the scan', () => {
    const e = {
      name: 'item',
      getDroppedItem: () => { throw new Error('no metadata yet') },
      metadata: [null, { name: 'oak_log', count: 2 }],
    }
    expect(droppedItemName(e)).toEqual({ name: 'oak_log', count: 2 })
  })

  it('legacy scan still works when getDroppedItem is absent', () => {
    const e = { name: 'item_stack', metadata: { 8: { name: 'bread', count: 1 } } }
    expect(droppedItemName(e)).toEqual({ name: 'bread', count: 1 })
  })

  it('returns null when nothing is decodable yet', () => {
    // The 1.21.x raw-slot shape that used to defeat the scan: no `.name`.
    const e = {
      name: 'item',
      getDroppedItem: () => null,
      metadata: [{ itemId: 982, itemCount: 3 }],
    }
    expect(droppedItemName(e)).toBeNull()
  })

  it('returns null for non-item entities', () => {
    expect(droppedItemName({ name: 'zombie', getDroppedItem: () => ({ name: 'rotten_flesh' }) })).toBeNull()
    expect(droppedItemName(null)).toBeNull()
  })
})
