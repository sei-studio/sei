// src/bot/brain/anthropicClient.streamSay.test.js
//
// Voice-call early say emit (260724). When call() is given an `onSay`
// callback, the request runs with SSE streaming and onSay fires the moment
// the FIRST `say` tool_use block's input JSON completes — before the rest of
// the turn has streamed — so the caller can start TTS while the remaining
// scratchpad / world-action calls are still generating. These tests assert:
//   1. onSay fires early (before the stream is fully consumed), exactly once,
//      with the say text + tool_use id, and the resolved response is shaped
//      identically to the non-streaming path.
//   2. A second say block never re-fires onSay.
//   3. A transient failure AFTER onSay fired still rescue-retries (260725),
//      because the tool calls bundled after the say() were being dropped —
//      but the retry REPLAYS the already-spoken say block (original id + text)
//      instead of speaking the retry's new line, so the bot never repeats
//      itself while its come()/remember() calls survive.
//   4. A transient failure BEFORE any say output keeps the normal rescue
//      retry allowance.
//   5. Without onSay the plain (non-streaming) create is used.
//   6. An externally supplied `spokenSay` (the orchestrator's timeout retry,
//      where the previous call() already spoke) behaves the same way: onSay
//      never fires, and the response carries the spoken block.

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

const { createAnthropicClient } = await import('./anthropicClient.js')

function makeConfig() {
  return {
    anthropic: {
      model: 'claude-haiku-4-5',
      timeout_ms: 10_000,
      cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' },
    },
  }
}

const REQ = { systemBlocks: [{ type: 'text', text: 'sys' }], tools: [], messages: [{ role: 'user', content: 'hi' }] }

/** Standard event sequence: scratchpad text → say tool_use → follow tool_use. */
function turnEvents() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 42, cache_read_input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'private ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'scratchpad' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_say', name: 'say', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"hey ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'player"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_follow', name: 'follow', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"player":"ouen"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
    { type: 'message_stop' },
  ]
}

/** Async-iterable stream mock. onYield(ev) observes progress; failAfterIndex
 * throws once that many events have been yielded. */
function streamOf(events, { onYield, failAfterIndex } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < events.length; i += 1) {
        if (failAfterIndex !== undefined && i >= failAfterIndex) {
          const err = new Error('502 mid-stream')
          err.status = 502
          err.headers = { get: (k) => (k === 'retry-after' ? '0' : null) }
          throw err
        }
        onYield?.(events[i], i)
        yield events[i]
      }
    },
  }
}

describe('voice-call early say emit (onSay streaming)', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('fires onSay at say-block close, before the stream ends, and resolves the normal response shape', async () => {
    let yielded = 0
    createMock.mockImplementation(() => streamOf(turnEvents(), { onYield: () => { yielded += 1 } }))
    const client = createAnthropicClient(makeConfig())

    const onSay = vi.fn()
    let yieldedAtSay = null
    onSay.mockImplementation(() => { yieldedAtSay = yielded })

    const resp = await client.call({ ...REQ, onSay })

    // Fired once, with the text + id, strictly before the stream finished.
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('hey player', 'tu_say')
    expect(yieldedAtSay).toBeLessThan(turnEvents().length)

    // Streaming was requested.
    const [reqArg] = createMock.mock.calls[0]
    expect(reqArg.stream).toBe(true)

    // Response shape matches the non-streaming path.
    expect(resp.text).toBe('private scratchpad')
    expect(resp.toolUses).toEqual([
      { id: 'tu_say', name: 'say', input: { text: 'hey player' } },
      { id: 'tu_follow', name: 'follow', input: { player: 'ouen' } },
    ])
    expect(resp.stopReason).toBe('tool_use')
    expect(resp.usage).toEqual({ input_tokens: 42, cache_read_input_tokens: 10, output_tokens: 17 })
  })

  it('a second say block does not re-fire onSay', async () => {
    const events = turnEvents()
    events.splice(9, 0,
      { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'tu_say2', name: 'say', input: {} } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"text":"again"}' } },
      { type: 'content_block_stop', index: 9 },
    )
    createMock.mockImplementation(() => streamOf(events))
    const client = createAnthropicClient(makeConfig())

    const onSay = vi.fn()
    const resp = await client.call({ ...REQ, onSay })

    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('hey player', 'tu_say')
    // Both blocks still land in the response for emitSayCalls bookkeeping.
    expect(resp.toolUses.filter((u) => u.name === 'say')).toHaveLength(2)
  })

  it('transient failure AFTER onSay fired retries, replaying the spoken line', async () => {
    // Attempt 1 dies right after the say block closed (event index 9) — the
    // player has heard "hey player" but follow() never arrived. Attempt 2
    // regenerates with a DIFFERENT say line, which must not be spoken.
    const retryEvents = turnEvents()
    retryEvents[5] = { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_say_b', name: 'say', input: {} } }
    retryEvents[6] = { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"on my ' } }
    retryEvents[7] = { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'way"}' } }
    createMock
      .mockImplementationOnce(() => streamOf(turnEvents(), { failAfterIndex: 9 }))
      .mockImplementationOnce(() => streamOf(retryEvents))
    const client = createAnthropicClient(makeConfig())

    const onSay = vi.fn()
    const resp = await client.call({ ...REQ, onSay })

    expect(createMock).toHaveBeenCalledTimes(2)
    // Spoken exactly once, with the line the player actually heard.
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('hey player', 'tu_say')
    // The retry's say is collapsed into the spoken one (same id, same text) and
    // the tool call that was lost the first time around is recovered.
    expect(resp.toolUses).toEqual([
      { id: 'tu_say', name: 'say', input: { text: 'hey player' } },
      { id: 'tu_follow', name: 'follow', input: { player: 'ouen' } },
    ])
  })

  it('a retry that produces no say block still carries the spoken one', async () => {
    const retryEvents = turnEvents().filter((ev) => ev.index !== 1)
    createMock
      .mockImplementationOnce(() => streamOf(turnEvents(), { failAfterIndex: 9 }))
      .mockImplementationOnce(() => streamOf(retryEvents))
    const client = createAnthropicClient(makeConfig())

    const onSay = vi.fn()
    const resp = await client.call({ ...REQ, onSay })

    expect(onSay).toHaveBeenCalledTimes(1)
    // Appended (a thinking block must stay first); position is irrelevant to
    // emitSayCalls, presence is not.
    expect(resp.toolUses).toEqual([
      { id: 'tu_follow', name: 'follow', input: { player: 'ouen' } },
      { id: 'tu_say', name: 'say', input: { text: 'hey player' } },
    ])
  })

  it('an externally spoken say (timeout retry) suppresses onSay and is replayed', async () => {
    createMock.mockImplementationOnce(() => streamOf(turnEvents()))
    const client = createAnthropicClient(makeConfig())

    const onSay = vi.fn()
    const resp = await client.call({ ...REQ, onSay, spokenSay: { id: 'tu_prev', text: 'sure, coming!' } })

    expect(onSay).not.toHaveBeenCalled()
    expect(resp.toolUses).toEqual([
      { id: 'tu_prev', name: 'say', input: { text: 'sure, coming!' } },
      { id: 'tu_follow', name: 'follow', input: { player: 'ouen' } },
    ])
  })

  it('transient failure BEFORE any say output still rescue-retries', async () => {
    const onSay = vi.fn()
    createMock
      .mockImplementationOnce(() => streamOf(turnEvents(), { failAfterIndex: 2 })) // dies in the scratchpad
      .mockImplementationOnce(() => streamOf(turnEvents()))
    const client = createAnthropicClient(makeConfig())

    const resp = await client.call({ ...REQ, onSay })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(resp.toolUses[0]).toEqual({ id: 'tu_say', name: 'say', input: { text: 'hey player' } })
  })

  it('without onSay the plain non-streaming create is used', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'fine.' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    })
    const client = createAnthropicClient(makeConfig())

    const resp = await client.call({ ...REQ })

    const [reqArg] = createMock.mock.calls[0]
    expect(reqArg.stream).toBeUndefined()
    expect(resp.text).toBe('fine.')
  })
})
