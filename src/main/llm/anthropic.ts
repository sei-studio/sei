/**
 * Anthropic adapter (covers BOTH cloud-proxy and local BYOK Anthropic).
 *
 * HARD CONSTRAINT (china-compat W1): this path must be byte-for-byte
 * behaviorally identical to the pre-layer code. It therefore:
 *   - builds its client through buildChatSdk() (the exact same SDK wiring,
 *     including apiKey:null header suppression on cloud-proxy and
 *     maxRetries:1) — which is also the seam every existing test mocks;
 *   - passes system / tools / tool_choice / stop_sequences / messages through
 *     UNTOUCHED, cache_control breakpoints included;
 *   - uses client.messages.stream() when a streaming callback is given
 *     (text deltas awaited in order; contentBlock events delivered exactly
 *     once with the emitted-count dedupe drawService used), and
 *     client.messages.create() otherwise.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { buildChatSdk } from '../chat/sdk';
import type { LlmBackend, LlmCallParams, LlmProvider, LlmResult, LlmToolUse } from './types';
import { textOfContent } from './messageMappers';

type ClientLike = {
  messages: {
    create: (req: unknown, opts?: unknown) => Promise<unknown>;
    stream?: (req: unknown, opts?: unknown) => unknown;
  };
};

interface StreamLike extends AsyncIterable<unknown> {
  on?: (event: string, cb: (arg: unknown) => void) => unknown;
  finalMessage: () => Promise<{ content: unknown[]; usage?: unknown; stop_reason?: string | null }>;
}

function toResult(res: { content: unknown[]; usage?: unknown; stop_reason?: string | null }): LlmResult {
  const content = (res.content ?? []) as Anthropic.Messages.ContentBlock[];
  const toolUses: LlmToolUse[] = [];
  for (const b of content) {
    if ((b as { type?: string })?.type === 'tool_use') {
      const tu = b as unknown as { id: string; name: string; input: Record<string, unknown> };
      toolUses.push({ id: tu.id, name: tu.name, input: tu.input ?? {} });
    }
  }
  const u = (res.usage ?? {}) as LlmResult['usage'];
  return {
    content,
    toolUses,
    text: textOfContent(content as Array<{ type?: string; text?: string }>),
    usage: u,
    stopReason: res.stop_reason ?? null,
  };
}

export async function createAnthropicProvider(backend: LlmBackend): Promise<LlmProvider> {
  // Fresh per build (every call site already rebuilds per turn), so a
  // cloud<->local switch or JWT rotation is picked up exactly as before.
  const { client, model } = await buildChatSdk();
  const c = client as unknown as ClientLike;

  async function call(p: LlmCallParams): Promise<LlmResult> {
    // Build the request with only the fields the caller provided, so the SDK
    // (and every test spy asserting on params) sees the same object shape the
    // pre-layer call sites produced.
    const params: Record<string, unknown> = {
      model: p.model ?? model,
      max_tokens: p.maxTokens,
      messages: p.messages,
    };
    if (p.system !== undefined) params.system = p.system;
    if (p.tools !== undefined) params.tools = p.tools;
    if (p.toolChoice !== undefined) params.tool_choice = p.toolChoice;
    if (p.stopSequences !== undefined) params.stop_sequences = p.stopSequences;
    const opts: Record<string, unknown> = {};
    if (p.timeoutMs !== undefined) opts.timeout = p.timeoutMs;
    if (p.signal !== undefined) opts.signal = p.signal;

    if (p.onTextDelta || p.onContentBlock) {
      const stream = c.messages.stream!(params, opts) as StreamLike;
      // contentBlock dedupe is by COUNT (drawService's original logic): the
      // event blocks and finalMessage().content are not guaranteed to be the
      // same references, and events arrive in content order, so the count of
      // events handled is exactly the prefix of final.content to skip.
      let emitted = 0;
      if (p.onContentBlock && typeof stream.on === 'function') {
        stream.on('contentBlock', (b) => {
          emitted += 1;
          p.onContentBlock!(b as Anthropic.Messages.ContentBlock);
        });
      }
      if (p.onTextDelta) {
        for await (const ev of stream) {
          const e = ev as { type?: string; delta?: { type?: string; text?: string } };
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
            await p.onTextDelta(e.delta.text);
          }
        }
      }
      const final = await stream.finalMessage();
      if (p.onContentBlock) {
        for (let i = emitted; i < final.content.length; i++) {
          p.onContentBlock(final.content[i] as Anthropic.Messages.ContentBlock);
        }
      }
      return toResult(final);
    }

    const res = (await c.messages.create(params, Object.keys(opts).length ? opts : undefined)) as {
      content: unknown[];
      usage?: unknown;
      stop_reason?: string | null;
    };
    return toResult(res);
  }

  return {
    call,
    backend,
    kind: 'anthropic',
    model,
    vision: 'yes',
    streaming: true,
  };
}
