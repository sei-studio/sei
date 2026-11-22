// 261017 (issue #46): the ChatGPT-plan bot provider and its token bridge.
// Canned SSE only; main's side of the bridge is a recorded transport.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChatgptProvider, collapseSay, CHATGPT_DEFAULT_MODEL } from './chatgptProvider.js'
import {
  _resetChatgptTokenBridgeForTests,
  deliverChatgptToken,
  requestChatgptToken,
  setChatgptTokenTransport,
} from './chatgptTokenBridge.js'
import { TERMINAL_CHATGPT_CODES, TOOL_NAMESPACE } from './responsesWire.js'

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function okStream(text, chunk = 23) {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= text.length) return { done: true, value: undefined }
          const part = text.slice(i, i + chunk)
          i += chunk
          return { done: false, value: enc.encode(part) }
        },
      }),
    },
  }
}

function errResp(status, body) {
  return { ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

const callEvents = (idx, callId, name, args) => [
  { type: 'response.output_item.added', output_index: idx, item: { type: 'function_call', id: `fc_${idx}`, call_id: callId, name, namespace: TOOL_NAMESPACE, arguments: '' } },
  { type: 'response.function_call_arguments.done', output_index: idx, item_id: `fc_${idx}`, arguments: args },
  { type: 'response.output_item.done', output_index: idx, item: { type: 'function_call', id: `fc_${idx}`, call_id: callId, name, namespace: TOOL_NAMESPACE, arguments: args } },
]

const completed = { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 10, output_tokens: 3 } } }

const sayAndDig = sse([
  { type: 'response.created', response: { id: 'r' } },
  ...callEvents(0, 'call_say', 'say', JSON.stringify({ text: 'on it' })),
  ...callEvents(1, 'call_dig', 'dig', JSON.stringify({ x: 1 })),
  completed,
])

const config = (over = {}) => ({
  anthropic: { timeout_ms: 5_000 },
  llm: { provider: 'chatgpt', providers: { chatgpt: { api_key: 'tok-1', token_expires_at: Date.now() + 3_600_000, model: 'gpt-6-luna', ...over } } },
})

const callArgs = (extra = {}) => ({
  systemBlocks: [{ type: 'text', text: 'You are Sui.' }],
  tools: [{ name: 'say', description: 's', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }],
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

const authHeader = (fetchImpl, n) => fetchImpl.mock.calls[n][1].headers.Authorization ?? fetchImpl.mock.calls[n][1].headers.authorization

beforeEach(() => _resetChatgptTokenBridgeForTests())
afterEach(() => _resetChatgptTokenBridgeForTests())

describe('chatgptTokenBridge', () => {
  it('rejects at once with no transport (signed out)', async () => {
    await expect(requestChatgptToken()).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT', terminal: true })
  })

  it('shares one request among concurrent callers and resolves them all', async () => {
    const sent = []
    setChatgptTokenTransport((m) => sent.push(m))
    const a = requestChatgptToken()
    const b = requestChatgptToken()
    expect(sent).toEqual([{ type: 'request-chatgpt-token', force: false }])
    deliverChatgptToken({ token: 'fresh', expiresAt: 123 })
    await expect(a).resolves.toEqual({ token: 'fresh', expiresAt: 123 })
    await expect(b).resolves.toEqual({ token: 'fresh', expiresAt: 123 })
  })

  it('a forced request is always sent, even with one already pending', async () => {
    const sent = []
    setChatgptTokenTransport((m) => sent.push(m))
    const a = requestChatgptToken()
    const b = requestChatgptToken({ force: true })
    expect(sent.map((m) => m.force)).toEqual([false, true])
    deliverChatgptToken({ token: 't', expiresAt: 1 })
    await Promise.all([a, b])
  })

  it('a transient failure rejects waiters as retryable and leaves listeners alone', async () => {
    setChatgptTokenTransport(() => {})
    const heard = vi.fn()
    const p = createChatgptProvider(config(), { fetchImpl: vi.fn() })
    const unsub = (await import('./chatgptTokenBridge.js')).onChatgptToken(heard)
    const w = requestChatgptToken()
    deliverChatgptToken({ token: null, code: 'CHATGPT_TOKEN_UNAVAILABLE', error: 'net' })
    await expect(w).rejects.toMatchObject({ code: 'CHATGPT_TOKEN_UNAVAILABLE' })
    expect(heard).not.toHaveBeenCalled()
    unsub()
    p.dispose()
  })

  it('a terminal null tells listeners and rejects waiters with the terminal code', async () => {
    setChatgptTokenTransport(() => {})
    const w1 = requestChatgptToken()
    deliverChatgptToken({ token: null, code: 'CHATGPT_PLAN_DISABLED' })
    await expect(w1).rejects.toMatchObject({ code: 'CHATGPT_PLAN_DISABLED', terminal: true })
    const w2 = requestChatgptToken()
    deliverChatgptToken({ token: null })
    await expect(w2).rejects.toMatchObject({ code: 'CHATGPT_SIGNED_OUT', terminal: true })
  })

  it('times out when main never answers', async () => {
    vi.useFakeTimers()
    try {
      setChatgptTokenTransport(() => {})
      const p = requestChatgptToken({ timeoutMs: 50 })
      const check = expect(p).rejects.toMatchObject({ code: 'CHATGPT_TOKEN_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(60)
      await check
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createChatgptProvider', () => {
  it('posts a Responses body with the access token and returns tool calls', async () => {
    const fetchImpl = vi.fn(async () => okStream(sayAndDig))
    const p = createChatgptProvider(config(), { fetchImpl, url: 'https://x/v1/responses' })
    const r = await p.call(callArgs())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://x/v1/responses')
    expect(authHeader(fetchImpl, 0)).toBe('Bearer tok-1')
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body).toMatchObject({ model: 'gpt-6-luna', stream: true, store: false })
    expect(r.toolUses.map((t) => [t.id, t.name, t.input])).toEqual([
      ['call_say', 'say', { text: 'on it' }],
      ['call_dig', 'dig', { x: 1 }],
    ])
    expect(p.kind).toBe('chatgpt')
    expect(p.model).toBe('gpt-6-luna')
    p.dispose()
  })

  it('defaults the model and turns vision off when main says the model is text-only', () => {
    const p = createChatgptProvider(config({ model: '', vision: false }), { fetchImpl: vi.fn() })
    expect(p.model).toBe(CHATGPT_DEFAULT_MODEL)
    expect(p.capabilities.vision).toBe(false)
    p.dispose()
  })

  it('fires onSay once, as soon as the first say() item completes', async () => {
    const fetchImpl = vi.fn(async () => okStream(sayAndDig, 7))
    const p = createChatgptProvider(config(), { fetchImpl })
    const onSay = vi.fn()
    await p.call(callArgs({ onSay }))
    expect(onSay).toHaveBeenCalledTimes(1)
    expect(onSay).toHaveBeenCalledWith('on it', 'call_say')
    p.dispose()
  })

  it('spokenSay suppresses a second emit and collapses the retry onto the line heard', async () => {
    const fetchImpl = vi.fn(async () => okStream(sayAndDig))
    const p = createChatgptProvider(config(), { fetchImpl })
    const onSay = vi.fn()
    const r = await p.call(callArgs({ onSay, spokenSay: { id: 'early_1', text: 'already said' } }))
    expect(onSay).not.toHaveBeenCalled()
    const says = r.toolUses.filter((t) => t.name === 'say')
    expect(says).toEqual([{ id: 'early_1', name: 'say', input: { text: 'already said' } }])
    expect(r.toolUses.some((t) => t.name === 'dig')).toBe(true)
    p.dispose()
  })

  it('a 401 asks main for a forced refresh and retries exactly once', async () => {
    const sent = []
    setChatgptTokenTransport((m) => {
      sent.push(m)
      queueMicrotask(() => deliverChatgptToken({ token: 'tok-2', expiresAt: Date.now() + 3_600_000 }))
    })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errResp(401, { error: { code: 'invalid_token', message: 'expired' } }))
      .mockResolvedValueOnce(okStream(sayAndDig))
    const p = createChatgptProvider(config(), { fetchImpl })
    await p.call(callArgs())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([{ type: 'request-chatgpt-token', force: true }])
    expect(authHeader(fetchImpl, 1)).toBe('Bearer tok-2')
    p.dispose()
  })

  it('a second 401 after the forced refresh is terminal CHATGPT_AUTH_REJECTED (no loop)', async () => {
    setChatgptTokenTransport(() => queueMicrotask(() => deliverChatgptToken({ token: 'tok-2', expiresAt: Date.now() + 3_600_000 })))
    const fetchImpl = vi.fn(async () => errResp(401, { error: { message: 'no' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    const err = await p.call(callArgs()).catch((e) => e)
    expect(err).toMatchObject({ code: 'CHATGPT_AUTH_REJECTED', terminal: true, httpStatus: 401 })
    // No `status`: the orchestrator's 401 JWT recovery must not redrive it.
    expect(err.status).toBeUndefined()
    expect(TERMINAL_CHATGPT_CODES).toContain(err.code)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    p.dispose()
  })

  it('a forced refresh that hands back the SAME token: no retry, not terminal (earliest_refresh_at)', async () => {
    setChatgptTokenTransport(() => queueMicrotask(() => deliverChatgptToken({ token: 'tok-1', expiresAt: Date.now() + 3_600_000 })))
    const fetchImpl = vi.fn(async () => errResp(401, { error: { code: 'invalid_token' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    const err = await p.call(callArgs()).catch((e) => e)
    expect(err.code).toBe('CHATGPT_AUTH')
    expect(err.terminal).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    p.dispose()
  })

  it('subscription_sharing_invalid_user after a real refresh stops as FORBIDDEN, not a sign-in prompt', async () => {
    setChatgptTokenTransport(() => queueMicrotask(() => deliverChatgptToken({ token: 'tok-2', expiresAt: Date.now() + 3_600_000 })))
    const fetchImpl = vi.fn(async () => errResp(401, { error: { code: 'subscription_sharing_invalid_user', message: 'no' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    const err = await p.call(callArgs()).catch((e) => e)
    expect(err).toMatchObject({ code: 'CHATGPT_FORBIDDEN', terminal: true, apiCode: 'subscription_sharing_invalid_user' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    p.dispose()
  })

  it('a 400 on the very first request is terminal CHATGPT_REQUEST_REJECTED', async () => {
    const fetchImpl = vi.fn(async () => errResp(400, { error: { message: 'Unknown parameter: tools[0].namespace', param: 'tools[0].namespace' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    const err = await p.call(callArgs()).catch((e) => e)
    expect(err).toMatchObject({ code: 'CHATGPT_REQUEST_REJECTED', terminal: true, httpStatus: 400, param: 'tools[0].namespace' })
    expect(err.status).toBeUndefined()
    expect(TERMINAL_CHATGPT_CODES).toContain(err.code)
    p.dispose()
  })

  it('a 400 on the first tool round trip is terminal even after plain turns worked', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okStream(sayAndDig))
      .mockResolvedValueOnce(errResp(400, { error: { message: 'bad function_call_output' } }))
      .mockResolvedValueOnce(errResp(400, { error: { message: 'one-off' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    await p.call(callArgs())
    const roundTrip = callArgs({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_dig', name: 'dig', input: { x: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_dig', content: 'dug' }] },
      ],
    })
    await expect(p.call(roundTrip)).rejects.toMatchObject({ code: 'CHATGPT_REQUEST_REJECTED' })
    // A plain turn after successes: an ordinary, non-terminal error.
    const plain = await p.call(callArgs()).catch((e) => e)
    expect(plain.code).toBe('CHATGPT_HTTP_ERROR')
    expect(plain.terminal).toBe(false)
    p.dispose()
  })

  it('a usage limit is terminal: no retry, no status for the generic 429 redrive', async () => {
    const fetchImpl = vi.fn(async () => errResp(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }))
    const p = createChatgptProvider(config(), { fetchImpl })
    const err = await p.call(callArgs()).catch((e) => e)
    expect(err.code).toBe('CHATGPT_USAGE_LIMIT')
    expect(err.terminal).toBe(true)
    expect(err.status).toBeUndefined()
    expect(err.httpStatus).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    p.dispose()
  })

  it('refreshes ahead of expiry, and keeps an unexpired token when main is unreachable', async () => {
    let now = 1_000_000
    const sent = []
    setChatgptTokenTransport((m) => {
      sent.push(m)
      queueMicrotask(() => deliverChatgptToken({ token: null, code: 'CHATGPT_TOKEN_UNAVAILABLE' }))
    })
    const fetchImpl = vi.fn(async () => okStream(sayAndDig))
    // 60 s left: inside the 2 min margin, still valid.
    const p = createChatgptProvider(config({ token_expires_at: now + 60_000 }), { fetchImpl, now: () => now })
    await p.call(callArgs())
    expect(sent).toHaveLength(1)
    expect(authHeader(fetchImpl, 0)).toBe('Bearer tok-1')
    // Expired and main still failing: the transient error surfaces.
    now += 120_000
    await expect(p.call(callArgs())).rejects.toMatchObject({ code: 'CHATGPT_TOKEN_UNAVAILABLE' })
    p.dispose()
  })

  it('takes pushed tokens, and asks for one when it has none', async () => {
    const fetchImpl = vi.fn(async () => okStream(sayAndDig))
    const p = createChatgptProvider(config({ api_key: '' }), { fetchImpl })
    setChatgptTokenTransport(() => queueMicrotask(() => deliverChatgptToken({ token: 'pushed-1', expiresAt: Date.now() + 3_600_000 })))
    await p.call(callArgs())
    expect(authHeader(fetchImpl, 0)).toBe('Bearer pushed-1')
    deliverChatgptToken({ token: 'pushed-2', expiresAt: Date.now() + 3_600_000 })
    await p.call(callArgs())
    expect(authHeader(fetchImpl, 1)).toBe('Bearer pushed-2')
    p.dispose()
  })

  it('setAuthToken (the cloud JWT path) never replaces the ChatGPT token', async () => {
    const fetchImpl = vi.fn(async () => okStream(sayAndDig))
    const p = createChatgptProvider(config(), { fetchImpl })
    p.setAuthToken('supabase-jwt')
    await p.call(callArgs())
    expect(authHeader(fetchImpl, 0)).toBe('Bearer tok-1')
    p.dispose()
  })

  it('a stalled stream becomes an AbortError with isTimeout', async () => {
    const fetchImpl = vi.fn(async (_u, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise((_res, rej) => {
            init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
        }),
      },
    }))
    const p = createChatgptProvider(config(), { fetchImpl })
    await expect(p.call(callArgs({ timeoutMs: 30 }))).rejects.toMatchObject({ name: 'AbortError', isTimeout: true })
    p.dispose()
  })

  it('writes the same [haiku?]/[haiku!]/[haikuâœ—] turn log as anthropicClient', async () => {
    const logged = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s) => { logged.push(String(s)) })
    try {
      const ok = createChatgptProvider(config(), { fetchImpl: vi.fn(async () => okStream(sayAndDig)) })
      await ok.call(callArgs())
      ok.dispose()
      const limited = createChatgptProvider(config(), {
        fetchImpl: vi.fn(async () => errResp(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })),
      })
      await limited.call(callArgs()).catch(() => {})
      limited.dispose()
    } finally {
      spy.mockRestore()
    }
    const block = (tag) => logged.find((s) => s.includes(`${tag} begin`)) ?? ''
    expect(block('[haiku?]')).not.toBe('')
    const done = block('[haiku!]')
    expect(done).toContain('say({"text":"on it"})')
    expect(done).toContain('dig({"x":1})')
    const usage = JSON.parse(done.match(/usage: (.*)/)[1])
    expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 3 })
    expect(block('[haikuâœ—]')).toContain('CHATGPT_USAGE_LIMIT')
  })
})

describe('collapseSay', () => {
  it('adds the spoken say when the retry has none', () => {
    const r = collapseSay({ content: [{ type: 'text', text: 'x' }], toolUses: [] }, { id: 's1', text: 'hey' })
    expect(r.toolUses).toEqual([{ id: 's1', name: 'say', input: { text: 'hey' } }])
  })
})




