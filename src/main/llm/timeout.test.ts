/**
 * 260926: a local/BYOK provider's own request timeout must surface as a real
 * error (LlmTimeoutError, classified "timeout"), while a caller cancel keeps
 * throwing the AbortError every surface reads as a silent interrupt.
 *
 * The fake fetch hangs until its signal aborts and then rejects the way
 * undici does (DOMException AbortError), so both paths go through the real
 * provider abort wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOllamaProvider, LOCAL_TIMEOUT_FLOOR_MS } from './ollama';
import { createOpenAICompatProvider } from './openaiCompat';
import { createGeminiProvider } from './gemini';
import { LlmTimeoutError, LLM_TIMEOUT } from './timeout';
import { surfaceErrorClass } from '../surfaceErrorClass';
import type { LlmCallParams, LlmProvider } from './types';

function hangingFetch(): typeof fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    })) as unknown as typeof fetch;
}

const providers: Array<[string, () => LlmProvider]> = [
  ['ollama', () => createOllamaProvider({ model: 'qwen3:1.7b', fetchImpl: hangingFetch() })],
  [
    'openai-compatible',
    () =>
      createOpenAICompatProvider({
        kind: 'openai',
        apiKey: 'k',
        baseUrl: 'https://api.test/v1',
        model: 'gpt-5-mini',
        fetchImpl: hangingFetch(),
      }),
  ],
  ['gemini', () => createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl: hangingFetch() })],
];

const params = (extra: Partial<LlmCallParams> = {}): LlmCallParams => ({
  maxTokens: 50,
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  timeoutMs: 30_000,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(providers)('%s provider: timeout vs cancel', (_name, make) => {
  it('its own deadline rejects with LlmTimeoutError, classified timeout', async () => {
    const pending = make().call(params());
    const settled = pending.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(LOCAL_TIMEOUT_FLOOR_MS + 1_000);
    const err = (await settled) as Error & { code?: string };
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.code).toBe(LLM_TIMEOUT);
    // The chat/backseat abort checks sniff /abort/i in the message.
    expect(err.name).not.toBe('AbortError');
    expect(err.message).not.toMatch(/abort/i);
    expect(surfaceErrorClass(err)).toBe('timeout');
  });

  it('a caller cancel still rejects with an AbortError, classified aborted', async () => {
    const caller = new AbortController();
    const pending = make().call(params({ signal: caller.signal }));
    const settled = pending.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    const err = (await settled) as Error;
    expect(err).not.toBeInstanceOf(LlmTimeoutError);
    expect(err.name).toBe('AbortError');
    expect(surfaceErrorClass(err)).toBe('aborted');
    // The deadline was cleared: nothing fires later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller cancel that lands after the deadline still counts as a cancel', async () => {
    // The user hit stop while the timer was racing it: stay silent.
    const caller = new AbortController();
    const pending = make().call(params({ signal: caller.signal }));
    const settled = pending.then(
      () => null,
      (e: unknown) => e,
    );
    caller.abort();
    await vi.advanceTimersByTimeAsync(LOCAL_TIMEOUT_FLOOR_MS + 1_000);
    const err = (await settled) as Error;
    expect(err).not.toBeInstanceOf(LlmTimeoutError);
    expect(surfaceErrorClass(err)).toBe('aborted');
  });
});

describe('ollama keeps the 120 s local floor', () => {
  it('does not time out at the 30 s cloud chat budget', async () => {
    const caller = new AbortController();
    const settled = createOllamaProvider({ model: 'm', fetchImpl: hangingFetch() })
      .call(params({ signal: caller.signal }))
      .then(
        () => null,
        (e: unknown) => e,
      );
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(LOCAL_TIMEOUT_FLOOR_MS - 1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect(err.message).toContain(`${LOCAL_TIMEOUT_FLOOR_MS / 1000}s`);
  });
});
