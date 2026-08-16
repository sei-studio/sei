/**
 * OpenAI-compat adapter tests (china-compat W1): deepseek extra body + the
 * first-token timeout floor, stop_sequences mapping, forced tool_choice with
 * JSON fallback, SSE delta folding (text surfaced, tool_calls buffered), and
 * the no-op-ness of cache markers on this wire.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildRequestBody,
  createOpenAICompatProvider,
  drainSseToolCalls,
  effectiveTimeoutMs,
  foldSseChunk,
} from './openaiCompat';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    body: null,
  } as unknown as Response;
}

describe('effectiveTimeoutMs', () => {
  it('applies the deepseek 60s floor over a smaller caller timeout', () => {
    expect(effectiveTimeoutMs('deepseek', 20_000)).toBe(60_000);
  });
  it('keeps a caller timeout above the floor', () => {
    expect(effectiveTimeoutMs('deepseek', 90_000)).toBe(90_000);
  });
  it('leaves floorless providers on the caller timeout', () => {
    expect(effectiveTimeoutMs('openai', 20_000)).toBe(20_000);
  });
});

describe('buildRequestBody', () => {
  const p = {
    maxTokens: 160,
    system: [{ type: 'text' as const, text: 'sys', cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: 'hello' }],
    stopSequences: ['\nHuman:', '\nPlayer:'],
  };

  it('maps stopSequences to `stop` and spreads the deepseek extra body', () => {
    const body = buildRequestBody('deepseek', 'deepseek-v4-flash', p, false);
    expect(body.stop).toEqual(['\nHuman:', '\nPlayer:']);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.model).toBe('deepseek-v4-flash');
  });

  it('does not spread the deepseek body for other providers', () => {
    const body = buildRequestBody('openai', 'gpt-5-mini', p, false);
    expect(body.thinking).toBeUndefined();
  });

  it('cache markers never reach the wire (bytes unchanged otherwise)', () => {
    const body = buildRequestBody('openai', 'gpt-5-mini', p, false);
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect((body.messages as Array<{ content: string }>)[0].content).toBe('sys');
  });

  it('maps a forced tool_choice and reinforces it in the system prompt', () => {
    const body = buildRequestBody(
      'openai',
      'gpt-5-mini',
      { ...p, toolChoice: { type: 'tool' as const, name: 'set_chess_profile' } },
      false,
    );
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'set_chess_profile' } });
    expect((body.messages as Array<{ content: string }>)[0].content).toContain('set_chess_profile');
  });
});

describe('SSE folding', () => {
  it('surfaces text deltas and buffers tool_call argument deltas per index', () => {
    const state = { text: '', toolBuf: new Map(), finishReason: null, usage: null };
    expect(foldSseChunk(state, { choices: [{ delta: { content: 'hel' } }] })).toBe('hel');
    expect(foldSseChunk(state, { choices: [{ delta: { content: 'lo. ' } }] })).toBe('lo. ');
    foldSseChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'pen', arguments: '{"po' } }] } }],
    });
    foldSseChunk(state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ints":[{"x":1,"y":2}]}' } }] } }],
    });
    foldSseChunk(state, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5 } });
    expect(state.text).toBe('hello. ');
    expect(state.finishReason).toBe('tool_calls');
    const uses = drainSseToolCalls(state);
    expect(uses).toEqual([{ id: 'c1', name: 'pen', input: { points: [{ x: 1, y: 2 }] } }]);
  });
});

describe('createOpenAICompatProvider', () => {
  it('non-streaming: returns synthesized content, normalized stop + usage', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: 'done',
              tool_calls: [{ id: 'c9', type: 'function', function: { name: 'play', arguments: '{"move":"e4"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
    );
    const p = createOpenAICompatProvider({
      kind: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      model: 'gpt-5-mini',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await p.call({ maxTokens: 100, messages: [{ role: 'user', content: 'go' }] });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/v1/chat/completions');
    expect(res.toolUses).toEqual([{ id: 'c9', name: 'play', input: { move: 'e4' } }]);
    expect(res.content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 'c9', name: 'play', input: { move: 'e4' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage.input_tokens).toBe(11);
  });

  it('forced tool_choice falls back to parsing tool-shaped JSON from text', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: '{"elo": 800, "styleNote": "timid"}' }, finish_reason: 'stop' }],
      }),
    );
    const p = createOpenAICompatProvider({
      kind: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      model: 'gpt-5-mini',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await p.call({
      maxTokens: 100,
      messages: [{ role: 'user', content: 'derive' }],
      tools: [{ name: 'set_chess_profile', input_schema: { type: 'object' } }],
      toolChoice: { type: 'tool', name: 'set_chess_profile' },
    });
    expect(res.toolUses).toHaveLength(1);
    expect(res.toolUses[0].name).toBe('set_chess_profile');
    expect(res.toolUses[0].input).toEqual({ elo: 800, styleNote: 'timid' });
    expect(res.text).toBe('');
  });

  it('streams SSE: onTextDelta sees deltas in order, result carries the whole text', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"one. "}}]}\n',
      'data: {"choices":[{"delta":{"content":"two."}}]}\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n',
      'data: [DONE]\n',
    ];
    const encoder = new TextEncoder();
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () =>
          i < sse.length ? { done: false, value: encoder.encode(sse[i++]) } : { done: true, value: undefined },
      }),
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, body }) as unknown as Response);
    const p = createOpenAICompatProvider({
      kind: 'deepseek',
      apiKey: 'k',
      baseUrl: 'https://api.test/v1',
      model: 'deepseek-v4-flash',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const res = await p.call({
      maxTokens: 200,
      messages: [{ role: 'user', content: 'hi' }],
      onTextDelta: (t) => {
        deltas.push(t);
      },
    });
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown[])[1] ? String((fetchImpl.mock.calls[0][1] as { body: string }).body) : '{}') as Record<string, unknown>;
    expect(sent.stream).toBe(true);
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect(deltas).toEqual(['one. ', 'two.']);
    expect(res.text).toBe('one. two.');
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.input_tokens).toBe(7);
  });

  it('missing-key header is omitted rather than sent empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    const p = createOpenAICompatProvider({
      kind: 'openai',
      apiKey: '',
      baseUrl: 'https://api.test/v1',
      model: 'gpt-5-mini',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.call({ maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    const headers = (fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBeUndefined();
  });
});
