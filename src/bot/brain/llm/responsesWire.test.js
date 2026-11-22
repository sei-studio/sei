// 261017 (issue #46): the Responses wire contract for the ChatGPT-plan
// provider. Everything here runs against canned SSE text: no network.
import { describe, it, expect, vi } from 'vitest'
import {
  TOOL_NAMESPACE,
  UNSUPPORTED_BODY_FIELDS,
  TERMINAL_CHATGPT_CODES,
  anthropicToResponsesInput,
  anthropicToolsToResponsesTools,
  bareToolName,
  buildResponsesBody,
  classifyResponsesError,
  createResponsesAccumulator,
  createSseParser,
  finalizeResponses,
  normalizeResponsesUsage,
  streamResponses,
} from './responsesWire.js'

/** One SSE frame per event, like the API sends them. */
function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** A fetch double answering one streamed body, split into small chunks. */
function streamFetch(text, { status = 200, chunk = 17, headers = {} } = {}) {
  const enc = new TextEncoder()
  const calls = []
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    if (status !== 200) {
      return {
        ok: false,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        text: async () => text,
      }
    }
    let i = 0
    return {
      ok: true,
      status,
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
  })
  return { fetchImpl, calls }
}

const textEvents = (text, usage = { input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 100 } }) => [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  ...text.split(' ').map((w, i, a) => ({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: i < a.length - 1 ? `${w} ` : w })),
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text }] } },
  { type: 'response.completed', response: { id: 'resp_1', usage } },
]

const callEvents = (idx, callId, name, args) => [
  { type: 'response.output_item.added', output_index: idx, item: { type: 'function_call', id: `fc_${idx}`, call_id: callId, name, namespace: TOOL_NAMESPACE, arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: idx, item_id: `fc_${idx}`, delta: args.slice(0, 5) },
  { type: 'response.function_call_arguments.delta', output_index: idx, item_id: `fc_${idx}`, delta: args.slice(5) },
  { type: 'response.function_call_arguments.done', output_index: idx, item_id: `fc_${idx}`, arguments: args },
  { type: 'response.output_item.done', output_index: idx, item: { type: 'function_call', id: `fc_${idx}`, call_id: callId, name, namespace: TOOL_NAMESPACE, arguments: args } },
]

describe('buildResponsesBody', () => {
  const tools = [
    { name: 'say', description: 'Speak.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, cache_control: { type: 'ephemeral' } },
    { name: 'dig', description: 'Dig.', input_schema: { type: 'object', properties: {} } },
  ]

  it('sends store:false, stream:true, instructions, and none of the unsupported fields', () => {
    const body = buildResponsesBody({
      model: 'gpt-6-luna',
      system: [{ type: 'text', text: 'You are Sui.' }, { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      reasoningEffort: 'low',
    })
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('You are Sui.\n\nBe brief.')
    expect(body.reasoning).toEqual({ effort: 'low' })
    for (const f of UNSUPPORTED_BODY_FIELDS) expect(body).not.toHaveProperty(f)
    // No system-role input item: system text rides `instructions` only.
    expect(body.input.some((i) => i.role === 'system')).toBe(false)
  })

  it('groups tools in one namespace with strict:false and drops cache_control', () => {
    const [ns] = anthropicToolsToResponsesTools(tools)
    expect(ns.type).toBe('namespace')
    expect(ns.name).toBe(TOOL_NAMESPACE)
    expect(ns.tools.map((t) => t.name)).toEqual(['say', 'dig'])
    for (const t of ns.tools) {
      expect(t.type).toBe('function')
      expect(t.strict).toBe(false)
      expect(t).not.toHaveProperty('cache_control')
    }
    expect(ns.tools[0].parameters.required).toEqual(['text'])
  })

  it('omits reasoning when the model listed no levels, and tools when there are none', () => {
    const body = buildResponsesBody({ model: 'm', messages: [], reasoningEffort: null })
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('instructions')
  })

  it('maps a forced tool to tool_choice required plus a prompt note', () => {
    const body = buildResponsesBody({ model: 'm', system: 'S', messages: [], tools, toolChoice: { name: 'say' } })
    expect(body.tool_choice).toBe('required')
    expect(body.instructions).toMatch(/calling the say tool exactly once/)
  })
})

describe('anthropicToResponsesInput', () => {
  it('round-trips a tool call: function_call then its output, no item ids', () => {
    const input = anthropicToResponsesInput([
      { role: 'user', content: 'dig the stone' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'x', signature: 's' },
        { type: 'text', text: 'on it' },
        { type: 'tool_use', id: 'call_A', name: 'dig', input: { block: 'stone' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_A', content: 'dug stone' },
        { type: 'text', text: 'nice' },
      ] },
    ])
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'dig the stone' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
      { type: 'function_call', call_id: 'call_A', name: 'dig', namespace: TOOL_NAMESPACE, arguments: '{"block":"stone"}' },
      { type: 'function_call_output', call_id: 'call_A', output: 'dug stone' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'nice' }] },
    ])
    expect(input.some((i) => 'id' in i)).toBe(false)
  })

  it('maps base64 and url images to input_image, in messages and tool results', () => {
    const input = anthropicToResponsesInput([
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'look', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [
        { type: 'text', text: 'you see:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      ] }] },
    ])
    expect(input[0].content).toEqual([
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'auto' },
      { type: 'input_image', image_url: 'https://x.test/a.png', detail: 'auto' },
    ])
    expect(input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'c1',
      output: [
        { type: 'input_text', text: 'you see:' },
        { type: 'input_image', image_url: 'data:image/png;base64,UE5H', detail: 'auto' },
      ],
    })
  })
})

describe('SSE parsing', () => {
  it('reassembles events split across arbitrary chunk boundaries', () => {
    const text = sse(textEvents('hello there friend'))
    const p = createSseParser()
    const out = []
    for (let i = 0; i < text.length; i += 3) out.push(...p.push(text.slice(i, i + 3)))
    out.push(...p.flush())
    expect(out.map((e) => e.type)).toContain('response.completed')
    expect(out.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('')).toBe('hello there friend')
  })

  it('skips comments, [DONE] and junk, handles CRLF and a missing trailing blank line', () => {
    const p = createSseParser()
    const out = [
      ...p.push(': keep-alive\r\n\r\ndata: [DONE]\n\ndata: not json\n\n'),
      ...p.push('event: response.completed\r\ndata: {"response":{}}'),
      ...p.flush(),
    ]
    expect(out).toEqual([{ type: 'response.completed', response: {} }])
  })
})

describe('accumulate + finalize', () => {
  const run = (events) => {
    const acc = createResponsesAccumulator()
    const calls = []
    for (const ev of events) {
      const r = acc.fold(ev)
      if (r.completedCall) calls.push(r.completedCall)
    }
    return { acc, calls }
  }

  it('folds text plus a say() call into the Anthropic shape', () => {
    const { acc, calls } = run([
      ...textEvents('thinking out loud').slice(0, -1),
      ...callEvents(1, 'call_say', 'say', '{"text":"hey you"}'),
      { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 7 } } },
    ])
    expect(calls).toEqual([{ id: 'call_say', name: 'say', input: { text: 'hey you' } }])
    const r = finalizeResponses(acc)
    expect(r.text).toBe('thinking out loud')
    expect(r.toolUses).toEqual([{ id: 'call_say', name: 'say', input: { text: 'hey you' } }])
    expect(r.content).toEqual([
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', id: 'call_say', name: 'say', input: { text: 'hey you' } },
    ])
    expect(r.stopReason).toBe('tool_use')
    expect(r.usage).toEqual({ input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('prefers response.completed output when present', () => {
    const { acc } = run([
      ...callEvents(0, 'c9', 'dig', '{"block":"dirt"}'),
      { type: 'response.completed', response: { output: [
        { type: 'function_call', call_id: 'c9', name: 'dig', namespace: 'sei', arguments: '{"block":"stone"}' },
      ] } },
    ])
    expect(finalizeResponses(acc).toolUses).toEqual([{ id: 'c9', name: 'dig', input: { block: 'stone' } }])
  })

  it('a stream cut before response.completed is not a success', () => {
    const { acc } = run(textEvents('half a').slice(0, -1))
    expect(() => finalizeResponses(acc)).toThrow(/CHATGPT_STREAM_INTERRUPTED/)
  })

  it('a usage limit arriving mid-stream as response.failed is terminal, with no status', () => {
    const { acc } = run([
      ...textEvents('partial').slice(0, -1),
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
    ])
    let err
    try { finalizeResponses(acc) } catch (e) { err = e }
    expect(err.code).toBe('CHATGPT_USAGE_LIMIT')
    expect(err.terminal).toBe(true)
    expect(err.status).toBeUndefined()
    expect(TERMINAL_CHATGPT_CODES).toContain(err.code)
  })

  it('response.incomplete keeps what arrived as max_tokens', () => {
    const { acc } = run([
      ...textEvents('cut short').slice(0, -1),
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ])
    const r = finalizeResponses(acc)
    expect(r.text).toBe('cut short')
    expect(r.stopReason).toBe('max_tokens')
  })

  it('normalizes usage with cached tokens split out', () => {
    expect(normalizeResponsesUsage({ input_tokens: 120, output_tokens: 9, input_tokens_details: { cached_tokens: 100 } })).toEqual({
      input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 0,
    })
  })

  it('accepts namespaced spellings of a tool name', () => {
    expect(bareToolName('say', 'sei')).toBe('say')
    expect(bareToolName('sei.say')).toBe('say')
    expect(bareToolName('sei__say')).toBe('say')
  })
})

describe('classifyResponsesError', () => {
  const cases = [
    [429, 'subscription_sharing_usage_limit_exceeded', 'CHATGPT_USAGE_LIMIT', true],
    [403, 'subscription_sharing_user_not_eligible', 'CHATGPT_NOT_ELIGIBLE', true],
    [403, 'chatpass_v2_scope_not_authorized', 'CHATGPT_FORBIDDEN', true],
    [400, 'subscription_sharing_unsupported_capability', 'CHATGPT_UNSUPPORTED', true],
    [503, 'subscription_sharing_usage_unavailable', 'CHATGPT_UNAVAILABLE', false],
    [401, null, 'CHATGPT_AUTH', false],
    [429, null, 'CHATGPT_RATE_LIMITED', false],
    [500, null, 'CHATGPT_HTTP_ERROR', false],
  ]
  for (const [status, apiCode, code, terminal] of cases) {
    it(`${status} ${apiCode ?? '(no code)'} -> ${code}`, () => {
      const e = classifyResponsesError({ status, body: apiCode ? { error: { code: apiCode, message: 'm' } } : null })
      expect(e.code).toBe(code)
      expect(e.terminal).toBe(terminal)
      expect(e.message.startsWith(`${code}:`)).toBe(true)
      // Terminal codes and 401 never carry `status` (the orchestrator's
      // generic 429 redrive and 401 JWT recovery key on it).
      if (terminal || code === 'CHATGPT_AUTH') expect(e.status).toBeUndefined()
      else expect(e.status).toBe(status)
    })
  }

  it('keeps a pre-stream detail body as diagnostic text', () => {
    const e = classifyResponsesError({ status: 403, body: { detail: 'region blocked' }, requestId: 'req_1' })
    expect(e.code).toBe('CHATGPT_FORBIDDEN')
    expect(e.message).toMatch(/region blocked/)
    expect(e.message).toMatch(/req_1/)
  })
})

describe('streamResponses', () => {
  it('posts the body with the bearer token and folds the stream', async () => {
    const { fetchImpl, calls } = streamFetch(sse([...textEvents('hi there').slice(0, -1), ...callEvents(1, 'cs', 'say', '{"text":"yo"}'), { type: 'response.completed', response: {} }]))
    const onCall = vi.fn()
    const onChunk = vi.fn()
    const deltas = []
    const r = await streamResponses({
      fetchImpl, url: 'https://api.test/v1/responses', token: 'tok_1',
      body: { model: 'm', input: [], store: false, stream: true },
      onCall, onChunk, onTextDelta: (d) => { deltas.push(d) },
    })
    expect(calls[0].url).toBe('https://api.test/v1/responses')
    expect(calls[0].init.headers.authorization).toBe('Bearer tok_1')
    expect(calls[0].init.headers.accept).toBe('text/event-stream')
    expect(onCall).toHaveBeenCalledWith({ id: 'cs', name: 'say', input: { text: 'yo' } })
    expect(onChunk.mock.calls.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe('hi there')
    expect(r.text).toBe('hi there')
  })

  it('turns a non-OK answer into a classified error', async () => {
    const { fetchImpl } = streamFetch(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }), { status: 429, headers: { 'x-request-id': 'req_9' } })
    await expect(streamResponses({ fetchImpl, url: 'u', token: 't', body: {} })).rejects.toMatchObject({ code: 'CHATGPT_USAGE_LIMIT', requestId: 'req_9' })
  })
})




