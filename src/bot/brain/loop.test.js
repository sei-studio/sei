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

describe('createLoop — iterationCap guard (0 = unlimited)', () => {
  it('accepts 0 (unlimited cap) without throwing', () => {
    expect(() => createLoop({ iterationCap: 0 })).not.toThrow()
  })
  it('accepts a positive backstop', () => {
    expect(() => createLoop({ iterationCap: 300 })).not.toThrow()
  })
  it('rejects negative / non-integer / missing caps', () => {
    expect(() => createLoop({ iterationCap: -1 })).toThrow()
    expect(() => createLoop({ iterationCap: 1.5 })).toThrow()
    expect(() => createLoop({})).toThrow()
  })
})

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

describe('loop.demoteOlderImages — image retention cap', () => {
  it('replaces every image block in history with a text placeholder, leaving other blocks intact', () => {
    const loop = createLoop({ iterationCap: 30 })
    loop.appendUserTurn([
      IMG,
      { type: 'text', name: 'event', text: 'rendered view attached' },
    ])
    loop.appendAssistant([{ type: 'text', text: 'nice view' }])

    loop.demoteOlderImages()

    const payload = loop.buildAnthropicPayload()
    const flat = JSON.stringify(payload)
    expect(flat).not.toContain('"type":"image"')
    expect(flat).not.toContain('AAAA')
    expect(flat).toContain('a picture was shown here on an earlier turn')
    // The sibling event text and the assistant turn survive untouched.
    expect(flat).toContain('rendered view attached')
    expect(flat).toContain('nice view')
  })

  it('is a no-op on a history with no images', () => {
    const loop = createLoop({ iterationCap: 30 })
    loop.appendUserTurn([{ type: 'text', name: 'event', text: 'hello' }])
    const before = JSON.stringify(loop.buildAnthropicPayload())
    loop.demoteOlderImages()
    expect(JSON.stringify(loop.buildAnthropicPayload())).toBe(before)
  })

  it('bounds byteSize: demote-then-append keeps exactly one frame of base64 in canonical history', () => {
    const loop = createLoop({ iterationCap: 30 })
    const bigFrame = (data) => [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      { type: 'text', name: 'event', text: 'rendered view attached' },
    ]
    // Simulate the orchestrator's attach discipline across three frames.
    loop.appendUserTurn(bigFrame('X'.repeat(8_000)))
    const oneFrameSize = loop.byteSize()
    for (const data of ['Y'.repeat(8_000), 'Z'.repeat(8_000)]) {
      loop.demoteOlderImages()
      loop.appendUserTurn(bigFrame(data))
    }
    // Three attaches, but only ONE frame of base64 remains live — canonical
    // growth is the two small placeholders, not 16KB of dead base64.
    expect(loop.byteSize()).toBeLessThan(oneFrameSize + 1_000)
  })
})

describe('loop.appendToolResults — say() reminder on every continuation turn (260619)', () => {
  // Regression: the say() reminder used to ride only on the seed turn, so a long
  // action chain (gather/dig/craft) ran many continuation turns with NO say()
  // contract — the model kept acting and leaked any speech to its private text.
  // appendToolResults now restates the reminder as the LAST block when the loop
  // was created with one.
  const toolUseAssistant = (loop) => {
    loop.appendUserTurn([{ type: 'text', name: 'event', text: 'go' }], { seed: true })
    loop.appendAssistant([
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'tu1', name: 'gather', input: { name: 'oak_log' } },
    ])
  }

  it('appends the reminder last on a continuation turn when configured', () => {
    const loop = createLoop({ iterationCap: 30, speakReminder: 'SAY-REMINDER-TEXT' })
    toolUseAssistant(loop)
    loop.appendToolResults(
      [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }],
      { snapshot: 'SNAP', eventText: 'EVT' },
    )
    const payload = loop.buildAnthropicPayload()
    const lastUser = [...payload].reverse().find(m => m.role === 'user')
    // Highest-recency position: the reminder is the final block, after the snapshot.
    expect(lastUser.content[lastUser.content.length - 1]).toEqual({ type: 'text', text: 'SAY-REMINDER-TEXT' })
  })

  it('omits the reminder when the loop was created without one (back-compat)', () => {
    const loop = createLoop({ iterationCap: 30 })
    toolUseAssistant(loop)
    loop.appendToolResults([{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }], { snapshot: 'SNAP' })
    const payload = loop.buildAnthropicPayload()
    const lastUser = [...payload].reverse().find(m => m.role === 'user')
    // Last block is the snapshot; no reminder was added.
    expect(lastUser.content[lastUser.content.length - 1]).toEqual({ type: 'text', text: 'SNAP' })
  })
})
