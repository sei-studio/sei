/**
 * 261008: Haiku 5 defaults to adaptive thinking, which eats the 200-token
 * chat/voice budget. The Anthropic adapter disables it for Haiku 5 unless the
 * caller asked for thinking, and leaves every other model's request alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async (_req: unknown, _opts?: unknown) => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }));
const stream = vi.fn((_req: unknown, _opts?: unknown) => ({
  async *[Symbol.asyncIterator]() {},
  on: () => undefined,
  finalMessage: async () => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }),
}));
let sdkModel = 'claude-haiku-4-5';
vi.mock('../chat/sdk', () => ({
  buildChatSdk: async () => ({ client: { messages: { create, stream } }, model: sdkModel }),
}));

import { applyModelDefaults, createAnthropicProvider } from './anthropic';

describe('applyModelDefaults', () => {
  it('disables thinking on Haiku 5 when the caller did not set it', () => {
    expect(applyModelDefaults({ model: 'claude-haiku-5-5' }).thinking).toEqual({ type: 'disabled' });
  });

  it('keeps a thinking setting the caller passed', () => {
    const p = applyModelDefaults({ model: 'claude-haiku-5-5', thinking: { type: 'adaptive' } });
    expect(p.thinking).toEqual({ type: 'adaptive' });
  });

  it('leaves Haiku 4.5 and Sonnet 5 requests unchanged', () => {
    expect(applyModelDefaults({ model: 'claude-haiku-4-5' })).toEqual({ model: 'claude-haiku-4-5' });
    expect(applyModelDefaults({ model: 'claude-sonnet-5' })).toEqual({ model: 'claude-sonnet-5' });
  });
});

describe('createAnthropicProvider request shape', () => {
  beforeEach(() => {
    create.mockClear();
    stream.mockClear();
  });

  it('sends thinking disabled when the session model is Haiku 5', async () => {
    sdkModel = 'claude-haiku-5-5';
    const provider = await createAnthropicProvider('cloud' as never);
    await provider.call({ maxTokens: 200, messages: [{ role: 'user', content: 'hey' }] } as never);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 200, thinking: { type: 'disabled' } });
  });

  it('sends no thinking field for Haiku 4.5', async () => {
    sdkModel = 'claude-haiku-4-5';
    const provider = await createAnthropicProvider('cloud' as never);
    await provider.call({ maxTokens: 200, messages: [{ role: 'user', content: 'hey' }] } as never);
    expect(create.mock.calls[0][0]).not.toHaveProperty('thinking');
  });

  it('applies to a per-call Haiku 5 model override too', async () => {
    sdkModel = 'claude-haiku-4-5';
    const provider = await createAnthropicProvider('cloud' as never);
    await provider.call({ model: 'claude-haiku-5-5', maxTokens: 300, messages: [{ role: 'user', content: 'hey' }] } as never);
    expect(create.mock.calls[0][0]).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it('sends thinking disabled on the streaming path (Draw!, Backseat lookups)', async () => {
    sdkModel = 'claude-haiku-5-5';
    const provider = await createAnthropicProvider('cloud' as never);
    await provider.call({ maxTokens: 160, messages: [{ role: 'user', content: 'hey' }], onContentBlock: () => {} } as never);
    expect(stream.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' } });
  });

  it('never sends a fixed thinking budget or sampling params to Haiku 5', async () => {
    sdkModel = 'claude-haiku-5-5';
    const provider = await createAnthropicProvider('cloud' as never);
    await provider.call({
      maxTokens: 300,
      messages: [{ role: 'user', content: 'hey' }],
      anthropicExtra: { thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 0 },
    } as never);
    const req = create.mock.calls[0][0] as Record<string, unknown>;
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req).not.toHaveProperty('temperature');
  });
});
