// src/bot/brain/anthropicClient.visionFallback.test.js
//
// 404 vision-path fallback. The post-explicit-`visualize` turn is routed to the
// proxy's /vision/v1/messages cap gate (VIS-07/D-09) — but a deployed proxy that
// predates the route 404s it, which used to kill the continuation turn ("bot
// renders but never responds"). The client now strips the per-call `path`
// override on a 404 and re-hits the SDK default /v1/messages once instead.
// These tests mock the SDK at the module seam and assert:
//   1. 404 WITH a path → one retry WITHOUT the path; result returned normally.
//   2. 404 WITHOUT a path (genuine missing route) → still terminal — no loop.
//   3. The fallback is a REROUTE, not a retry: a transient failure on the
//      fallback request still gets the full rescue-retry allowance (260610:
//      a 502 right after the 404 detour was treated as terminal and killed a
//      rendered frame).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => createMock(...args) }
    }
  },
}))

// Silence the structured log channel — these tests assert transport behavior.
vi.mock('./log.js', () => ({
  logHaikuQuery: () => {},
  logHaikuResponse: () => {},
  logHaikuError: () => {},
}))

const { createAnthropicClient, VISION_MESSAGES_PATH } = await import('./anthropicClient.js')

function notFound() {
  const err = new Error('404 {"error":"not_found"}')
  err.status = 404
  return err
}

const OK_RESPONSE = {
  content: [{ type: 'text', text: 'i see basalt. thrilling.' }],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: 'end_turn',
}

function makeConfig() {
  return {
    anthropic: {
      model: 'claude-haiku-4-5',
      timeout_ms: 5_000,
      cloudMode: { baseURL: 'https://api.sei.gg', authToken: 'jwt' },
    },
  }
}

const REQ = { systemBlocks: [{ type: 'text', text: 'sys' }], tools: [], messages: [{ role: 'user', content: 'hi' }] }

describe('vision-path 404 fallback', () => {
  beforeEach(() => {
    createMock.mockReset()
  })

  it('404 on the /vision path → retries once on the default path and returns the response', async () => {
    createMock.mockImplementation((req, opts) => {
      if (opts?.path === VISION_MESSAGES_PATH) return Promise.reject(notFound())
      return Promise.resolve(OK_RESPONSE)
    })
    const client = createAnthropicClient(makeConfig())

    const result = await client.call({ ...REQ, path: VISION_MESSAGES_PATH })

    expect(result.text).toBe('i see basalt. thrilling.')
    expect(createMock).toHaveBeenCalledTimes(2)
    // First attempt carried the override; the fallback attempt must not.
    expect(createMock.mock.calls[0][1].path).toBe(VISION_MESSAGES_PATH)
    expect(createMock.mock.calls[1][1].path).toBeUndefined()
  })

  it('404 WITHOUT a path override stays terminal (no fallback loop)', async () => {
    createMock.mockImplementation(() => Promise.reject(notFound()))
    const client = createAnthropicClient(makeConfig())

    await expect(client.call({ ...REQ })).rejects.toMatchObject({ status: 404 })
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('the 260610 chain — 404 detour, then 502 on the fallback — still rescue-retries and succeeds', async () => {
    // retry-after: 0 keeps the rescue sleep at its 100ms floor (fast test).
    const badGateway = () => {
      const err = new Error('502 origin_bad_gateway')
      err.status = 502
      err.headers = { get: (k) => (k === 'retry-after' ? '0' : null) }
      return err
    }
    let calls = 0
    createMock.mockImplementation((req, opts) => {
      calls++
      if (opts?.path === VISION_MESSAGES_PATH) return Promise.reject(notFound()) // 1: route missing
      if (calls === 2) return Promise.reject(badGateway()) // 2: fallback hits a transient 502
      return Promise.resolve(OK_RESPONSE) // 3: rescue retry lands
    })
    const client = createAnthropicClient(makeConfig())

    const result = await client.call({ ...REQ, path: VISION_MESSAGES_PATH })

    expect(result.text).toBe('i see basalt. thrilling.')
    expect(createMock).toHaveBeenCalledTimes(3)
    // Both post-404 requests dropped the vision path override.
    expect(createMock.mock.calls[1][1].path).toBeUndefined()
    expect(createMock.mock.calls[2][1].path).toBeUndefined()
  })
})
