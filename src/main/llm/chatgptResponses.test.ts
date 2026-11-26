/**
 * 261017 (issue #46): the main-process ChatGPT-plan adapter. A fake session
 * (latches + tokens) and canned SSE; no network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatgptSession } from '../chatgptPlan/session';
import type { LlmCallParams } from './types';
import { applyStopSequences, charCapFor, createChatgptProvider, createStreamGate } from './chatgptResponses';

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function okStream(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function errResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const textReply = (text: string) =>
  sse([
    { type: 'response.created', response: { id: 'r' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'm', delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } } } },
  ]);

function fakeSession(over: Partial<ChatgptSession> = {}) {
  let n = 0;
  const reported: unknown[] = [];
  const s = {
    assertUsable: vi.fn(() => {}),
    getAccessToken: vi.fn(async (o?: { force?: boolean }) => ({ token: `at-${++n}${o?.force ? '-forced' : ''}`, expiresAt: null, accountId: 'a' })),
    reportError: vi.fn((e: unknown) => reported.push(e)),
    ...over,
  } as unknown as ChatgptSession;
  return { s, reported };
}

const params: LlmCallParams = { system: 'You are Sui.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 };

const authOf = (f: ReturnType<typeof vi.fn>, i: number): string =>
  new Headers((f.mock.calls[i][1] as RequestInit).headers).get('authorization') ?? '';

describe('chatgpt main provider', () => {
  it('streams text, normalizes usage and never sends max_output_tokens or stop', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => okStream(textReply('hey there')));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'gpt-6-luna', reasoningEffort: 'low', vision: 'yes', session: s, fetchImpl });
    const deltas: string[] = [];
    const r = await p.call({ ...params, maxTokens: 300, stopSequences: ['\n\n'], onTextDelta: (d) => { deltas.push(d); } });
    expect(r.text).toBe('hey there');
    expect(deltas.join('')).toBe('hey there');
    expect(r.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('stop');
    expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, stream: true, reasoning: { effort: 'low' } });
    expect(p.kind).toBe('chatgpt');
    expect(p.backend).toBe('local');
  });

  // 261125 (O5): typed chat's reply_latency first-token stamp; no onTextDelta needed.
  it('onFirstToken fires once on the first text delta, without an onTextDelta sink', async () => {
    const fetchImpl = vi.fn(async () => okStream(textReply('hey there')));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const onFirstToken = vi.fn();
    const r = await p.call({ ...params, onFirstToken });
    expect(r.text).toBe('hey there');
    expect(onFirstToken).toHaveBeenCalledTimes(1);
  });

  it('fails fast on a latched plan: no token, no request', async () => {
    const fetchImpl = vi.fn();
    const latched = Object.assign(new Error('CHATGPT_USAGE_LIMIT: paused'), { code: 'CHATGPT_USAGE_LIMIT', terminal: true });
    const { s } = fakeSession({ assertUsable: vi.fn(() => { throw latched; }) });
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    await expect(p.call(params)).rejects.toBe(latched);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.getAccessToken).not.toHaveBeenCalled();
  });

  it('a 401 forces one refresh and one retry', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errResp(401, { error: { code: 'invalid_token' } }))
      .mockResolvedValueOnce(okStream(textReply('ok')));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const r = await p.call(params);
    expect(r.text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(authOf(fetchImpl, 1)).toBe('Bearer at-2-forced');
  });

  it('a usage limit is reported to the session (latch) and thrown once, no retry', async () => {
    const fetchImpl = vi.fn(async () => errResp(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }));
    const { s, reported } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const err = await p.call(params).catch((e) => e);
    expect(err.code).toBe('CHATGPT_USAGE_LIMIT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((reported[0] as { code: string }).code).toBe('CHATGPT_USAGE_LIMIT');
  });

  it('a mid-stream usage limit (response.failed) is reported the same way', async () => {
    const body = sse([
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.failed', response: { error: { code: 'usage_limit_exceeded', message: 'limit' } } },
    ]);
    const { s, reported } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: vi.fn(async () => okStream(body)) });
    await expect(p.call(params)).rejects.toMatchObject({ code: 'CHATGPT_USAGE_LIMIT' });
    expect(reported).toHaveLength(1);
  });

  it('a forced tool answered as JSON text falls back to a tool call', async () => {
    const { s } = fakeSession();
    const fetchImpl = vi.fn(async () => okStream(textReply('{"elo": 1200}')));
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const r = await p.call({
      ...params,
      tools: [{ name: 'set_profile', description: 'd', input_schema: { type: 'object', properties: { elo: { type: 'number' } } } }],
      toolChoice: { type: 'tool', name: 'set_profile' },
    });
    expect(r.toolUses).toEqual([{ id: expect.any(String), name: 'set_profile', input: { elo: 1200 } }]);
    expect(r.stopReason).toBe('tool_use');
  });

  it('times out a stalled stream', async () => {
    const { s } = fakeSession();
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            init.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          },
        }),
        { status: 200 },
      ),
    );
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.call({ ...params, timeoutMs: 30 })).rejects.toThrow(/ChatGPT|timed out|timeout/i);
  });
});

/** A body that emits one SSE text delta per pull, forever unless cut. */
function endlessDeltas(init: RequestInit | undefined, pieces: string[], counter: { pulls: number; cancelled: boolean }): Response {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(sse([
          { type: 'response.created', response: { id: 'r' } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', content: [] } },
        ])));
        init?.signal?.addEventListener('abort', () => { counter.cancelled = true; });
      },
      pull(c) {
        counter.pulls++;
        if (counter.pulls > 500) { c.close(); return; }
        const delta = pieces[i % pieces.length];
        i++;
        c.enqueue(enc.encode(sse([{ type: 'response.output_text.delta', output_index: 0, item_id: 'm', delta }])));
      },
      cancel() { counter.cancelled = true; },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('chatgpt main provider: streamed stop sequences and length cap', () => {
  it('never forwards a stop sequence split across deltas, and cuts the stream there', async () => {
    const counter = { pulls: 0, cancelled: false };
    const pieces = ['Sure thing', '\nPla', 'yer: give me', ' everything', ' you have'];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => endlessDeltas(init, pieces, counter));
    const { s, reported } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: fetchImpl as unknown as typeof fetch });
    const deltas: string[] = [];
    const r = await p.call({ ...params, stopSequences: ['\nPlayer:'], onTextDelta: (d) => { deltas.push(d); } });
    expect(deltas.join('')).toBe('Sure thing');
    expect(deltas.join('')).not.toContain('\nPla');
    expect(r.text).toBe('Sure thing');
    expect(r.stopReason).toBe('stop_sequence');
    expect(counter.cancelled).toBe(true);
    expect(counter.pulls).toBeLessThan(10);
    expect(reported).toHaveLength(0);
  });

  it('keeps usage seen on the stream when it is cut before response.completed', async () => {
    const enc = new TextEncoder();
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(sse([
            { type: 'response.created', response: { id: 'r' } },
            { type: 'response.in_progress', response: { id: 'r', usage: { input_tokens: 120, output_tokens: 3, input_tokens_details: { cached_tokens: 100 } } } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', content: [] } },
            { type: 'response.output_text.delta', output_index: 0, item_id: 'm', delta: 'hi\nPlayer: more' },
          ])));
          init?.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      }),
      { status: 200 },
    ));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await p.call({ ...params, stopSequences: ['\nPlayer:'] });
    expect(r.text).toBe('hi');
    expect(r.usage).toMatchObject({ input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 100 });
  });

  it('caps the text near maxTokens and aborts the stream', async () => {
    const counter = { pulls: 0, cancelled: false };
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => endlessDeltas(init, ['blah '], counter));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: fetchImpl as unknown as typeof fetch });
    const deltas: string[] = [];
    const r = await p.call({ ...params, maxTokens: 10, onTextDelta: (d) => { deltas.push(d); } });
    expect(charCapFor(10)).toBe(40);
    expect(deltas.join('').length).toBe(40);
    expect(r.text.length).toBeLessThanOrEqual(40);
    expect(r.stopReason).toBe('max_tokens');
    expect(counter.cancelled).toBe(true);
    expect(counter.pulls).toBeLessThan(20);
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('a caller cancel during the stream still rejects (not a cut)', async () => {
    const counter = { pulls: 0, cancelled: false };
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => endlessDeltas(init, ['x'], counter));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl: fetchImpl as unknown as typeof fetch });
    const ac = new AbortController();
    const err = await p
      .call({ ...params, maxTokens: 10_000, signal: ac.signal, onTextDelta: () => { if (counter.pulls === 3) ac.abort(); } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it('the gate holds back only a possible stop prefix and flushes it at the end', async () => {
    const out: string[] = [];
    const g = createStreamGate({ stops: ['\nPlayer:'], maxChars: Infinity, forward: (d) => { out.push(d); }, onCut: () => {} });
    await g.push('hello\nPl');
    expect(out.join('')).toBe('h');
    await g.push('ease');
    await g.flush();
    expect(out.join('')).toBe('hello\nPlease');
    expect(g.cut).toBeNull();
  });
});

describe('chatgpt main provider: repeated 401', () => {
  it('a forced refresh that changes nothing (earliest_refresh_at) sends no retry and is not terminal', async () => {
    const fetchImpl = vi.fn(async () => errResp(401, { error: { code: 'invalid_token' } }));
    const { s, reported } = fakeSession({
      getAccessToken: vi.fn(async () => ({ token: 'same', expiresAt: null, accountId: 'a' })),
    });
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const err = await p.call(params).catch((e) => e);
    expect(err.code).toBe('CHATGPT_AUTH');
    expect(err.terminal).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((reported[0] as { code: string }).code).toBe('CHATGPT_AUTH');
  });

  it('subscription_sharing_invalid_user after a real refresh is FORBIDDEN (no sign-in prompt)', async () => {
    const fetchImpl = vi.fn(async () => errResp(401, { error: { code: 'subscription_sharing_invalid_user' } }));
    const { s } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    await expect(p.call(params)).rejects.toMatchObject({ code: 'CHATGPT_FORBIDDEN', terminal: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a 401 right after the forced refresh is terminal CHATGPT_AUTH_REJECTED, reported, no third request', async () => {
    const fetchImpl = vi.fn(async () => errResp(401, { error: { code: 'invalid_token' } }));
    const { s, reported } = fakeSession();
    const p = createChatgptProvider({ model: 'm', vision: 'yes', session: s, fetchImpl });
    const err = await p.call(params).catch((e) => e);
    expect(err.code).toBe('CHATGPT_AUTH_REJECTED');
    expect(err.terminal).toBe(true);
    expect(err.httpStatus).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((reported[0] as { code: string }).code).toBe('CHATGPT_AUTH_REJECTED');
  });
});

describe('applyStopSequences', () => {
  it('cuts at the earliest stop', () => {
    expect(applyStopSequences('a END b STOP', ['STOP', 'END'])).toEqual({ text: 'a ', stopped: true });
    expect(applyStopSequences('abc', ['x'])).toEqual({ text: 'abc', stopped: false });
    expect(applyStopSequences('abc', undefined)).toEqual({ text: 'abc', stopped: false });
  });
});
