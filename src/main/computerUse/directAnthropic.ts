/**
 * 260925 backseat act: a direct Anthropic client for development, used when
 * SEI_ACT_ANTHROPIC_KEY is set (or by scripts/act-latency-probe.ts with the
 * dev test key). It exists because the cloud proxy only serves Haiku 4.5 and
 * Sonnet 5 and drops anthropic-beta headers, and a spike needs to compare
 * models and thinking settings freely. Production traffic goes through the
 * normal LLM layer (buildLlmProvider) and never through this file.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallParams, LlmResult, LlmToolUse } from '../llm/types';
import type { LlmCall } from './visionChooser';

export function createDirectAnthropicCall(apiKey: string, opts: { baseURL?: string } = {}): LlmCall {
  const client = new Anthropic({ apiKey, maxRetries: 0, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return async (p: LlmCallParams): Promise<LlmResult> => {
    const body: Record<string, unknown> = {
      model: p.model ?? 'claude-sonnet-5',
      max_tokens: p.maxTokens,
      messages: p.messages,
      ...(p.system !== undefined ? { system: p.system } : {}),
      ...(p.tools !== undefined ? { tools: p.tools } : {}),
      ...(p.toolChoice !== undefined ? { tool_choice: p.toolChoice } : {}),
      ...(p.anthropicExtra ?? {}),
    };
    const res = (await client.messages.create(body as unknown as Anthropic.MessageCreateParamsNonStreaming, {
      ...(p.timeoutMs !== undefined ? { timeout: p.timeoutMs } : {}),
      ...(p.signal ? { signal: p.signal } : {}),
    })) as Anthropic.Message;
    const toolUses: LlmToolUse[] = [];
    let text = '';
    for (const b of res.content) {
      if (b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      if (b.type === 'text') text += b.text;
    }
    return {
      content: res.content,
      toolUses,
      text: text.trim(),
      usage: res.usage as LlmResult['usage'],
      stopReason: res.stop_reason ?? null,
    };
  };
}
