// src/bot/brain/anthropicClient.threadCache.test.js
//
// Moving thread cache breakpoint (260730). The loop conversation was never
// message-cached — every iteration re-billed the whole accumulated thread at
// full input price. stampThreadCacheControl puts the 4th breakpoint on the
// last non-thinking block of the last ASSISTANT turn (the last user turn is
// byte-volatile: D-43 strips its snapshot block on the next call). On a
// seed-only call (no assistant turn) the marker stays on the tools array as
// before, so the 4-breakpoint budget is never exceeded. These tests pin:
//   1. Stamp lands on the last non-thinking block of the last assistant turn.
//   2. Input arrays/objects are never mutated.
//   3. No assistant turn → same array reference back (caller's fallback cue).
//   4. call(): continuation → marker in messages, tools UNstamped.
//   5. call(): seed-only → tools stamped, messages untouched (old behavior).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => createMock(...args) }
    }
  },
}))

vi.mock('./log.js', () => ({
  logHaikuQuery: () => {},
  logHaikuResponse: () => {},
  logHaikuError: () => {},
}))

const { createAnthropicClient, stampThreadCacheControl } = await import('./anthropicClient.js')

const OK_RESPONSE = {
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: 'end_turn',
}

function makeConfig() {
  return {
    anthropic: {
      model: 'claude-haiku-4-5',
      timeout_ms: 10_000,
      cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' },
    },
  }
}

describe('stampThreadCacheControl', () => {
  it('stamps the last block of the last assistant turn', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'thinking aloud' },
        { type: 'tool_use', id: 't1', name: 'follow', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const out = stampThreadCacheControl(messages)

    expect(out).not.toBe(messages)
    expect(out[1].content[1].cache_control).toEqual({ type: 'ephemeral' })
    // Only the one block is stamped; the volatile last user turn is untouched.
    expect(out[1].content[0].cache_control).toBeUndefined()
    expect(out[2]).toBe(messages[2])
  })

  it('skips thinking blocks when picking the stamp target', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'say', input: { text: 'hi' } },
        { type: 'thinking', thinking: 'private', signature: 'sig' },
      ] },
    ]
    const out = stampThreadCacheControl(messages)
    expect(out[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(out[1].content[1].cache_control).toBeUndefined()
  })

  it('never mutates the input', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'follow', input: {} }] },
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))
    stampThreadCacheControl(messages)
    expect(messages).toEqual(snapshot)
  })

  it('returns the original array when there is no assistant turn (seed call)', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'seed' }] }]
    expect(stampThreadCacheControl(messages)).toBe(messages)
  })

  it('returns the original array when the only assistant turn has no stampable block', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    ]
    expect(stampThreadCacheControl(messages)).toBe(messages)
  })
})

describe('call() breakpoint wiring', () => {
  beforeEach(() => {
    createMock.mockReset()
    createMock.mockResolvedValue(OK_RESPONSE)
  })

  const TOOLS = [
    { name: 'follow', description: 'follow', input_schema: { type: 'object' } },
    { name: 'say', description: 'say', input_schema: { type: 'object' } },
  ]

  it('continuation call: marker moves to the thread, tools stay unstamped', async () => {
    const client = createAnthropicClient(makeConfig())
    await client.call({
      systemBlocks: [{ type: 'text', text: 'sys' }],
      tools: TOOLS,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'seed' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'follow', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    })

    const req = createMock.mock.calls[0][0]
    expect(req.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
    for (const t of req.tools) expect(t.cache_control).toBeUndefined()
  })

  it('seed-only call: tools carry the marker as before, messages untouched', async () => {
    const client = createAnthropicClient(makeConfig())
    await client.call({
      systemBlocks: [{ type: 'text', text: 'sys' }],
      tools: TOOLS,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'seed' }] }],
    })

    const req = createMock.mock.calls[0][0]
    expect(req.tools[req.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    expect(req.tools[0].cache_control).toBeUndefined()
    expect(req.messages[0].content[0].cache_control).toBeUndefined()
  })
})
