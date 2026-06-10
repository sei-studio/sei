// src/bot/brain/loop.test.js
//
// 15-06 Task 4: VERIFY (do not edit) that buildAnthropicPayload passes a
// provider-neutral image block through unchanged. The 15-06 image-attach
// (orchestrator handleVisualizeResult) appends an { type:'image', source:{...} }
// block on a fresh user turn; loop.buildAnthropicPayload must not strip or
// mutate it (the snapshot-strip rule only targets text/snapshot blocks; unknown
// block types are deep-cloned through — loop.js:135-136). If this test ever
// fails, loop.js needs a minimal passthrough fix (and the SUMMARY must note it);
// the expectation is it passes with NO loop.js edit.

import { describe, it, expect } from 'vitest'
import { createLoop } from './loop.js'

const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }

describe('loop.buildAnthropicPayload — image block passthrough (VIS-02, no-edit verification)', () => {
  it('preserves an image block on a user turn unchanged', () => {
    const loop = createLoop({ iterationCap: 30 })
    // Seed an assistant turn first so the image user turn is a normal turn.
    loop.appendUserTurn([{ type: 'text', name: 'event', text: 'look around' }])
    loop.appendAssistant([{ type: 'text', text: 'looking' }])
    // The 15-06 image attach shape: image block + a named event text block.
    loop.appendUserTurn([
      IMG,
      { type: 'text', name: 'event', text: 'rendered view attached' },
    ])

    const payload = loop.buildAnthropicPayload()
    const userTurns = payload.filter(m => m.role === 'user')
    const imageTurn = userTurns.find(m => m.content.some(b => b.type === 'image'))
    expect(imageTurn).toBeDefined()

    const imageBlock = imageTurn.content.find(b => b.type === 'image')
    // The block survives byte-for-byte (type + full source object).
    expect(imageBlock).toEqual(IMG)
    expect(imageBlock.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'AAAA' })

    // The accompanying event text keeps its text but the `name` field is
    // stripped (Anthropic SDK has no `name` on text blocks — existing rule).
    const textBlock = imageTurn.content.find(b => b.type === 'text')
    expect(textBlock).toEqual({ type: 'text', text: 'rendered view attached' })
    expect(textBlock.name).toBeUndefined()
  })

  it('does not strip the image block when it is NOT on the last user turn', () => {
    // The snapshot-strip rule drops text/snapshot blocks from non-last user
    // turns; an image block must NOT be affected by that rule.
    const loop = createLoop({ iterationCap: 30 })
    loop.appendUserTurn([
      IMG,
      { type: 'text', name: 'snapshot', text: 'OLD SNAPSHOT' },
    ])
    loop.appendAssistant([{ type: 'text', text: 'ok' }])
    loop.appendUserTurn([{ type: 'text', name: 'snapshot', text: 'NEW SNAPSHOT' }])

    const payload = loop.buildAnthropicPayload()
    const firstUser = payload.find(m => m.role === 'user')
    // The stale snapshot text IS stripped from the non-last turn...
    expect(firstUser.content.some(b => b.type === 'text' && b.text === 'OLD SNAPSHOT')).toBe(false)
    // ...but the image block on that same earlier turn survives intact.
    const imageBlock = firstUser.content.find(b => b.type === 'image')
    expect(imageBlock).toEqual(IMG)
  })

  it('deep-clones the image turn (payload mutation does not corrupt canonical messages)', () => {
    const loop = createLoop({ iterationCap: 30 })
    loop.appendUserTurn([IMG])
    const payload = loop.buildAnthropicPayload()
    const block = payload[0].content.find(b => b.type === 'image')
    // Mutating the payload block's top level must not write back to canonical.
    block.type = 'mutated'
    const payload2 = loop.buildAnthropicPayload()
    expect(payload2[0].content[0].type).toBe('image')
  })
})
